import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, AppConfig } from '../config';
import { FileJobStore } from '../storage/jobStore';
import { JobExecutionRecord, JobRecord, JobRequest, JobStatus, JsonSchemaObject } from '../types';
import { openApiDocument } from './openapi';
import { executeJob } from '../agent/jobRunner';
import { NullBrowserDriver } from '../browser/browserDriver';
import { McpBrowserDriver } from '../browser/mcpBrowserDriver';

export class ApiServer {
  private config: AppConfig;
  private store: FileJobStore;
  private driver: NullBrowserDriver | McpBrowserDriver;
  private running = 0;
  private queue: string[] = [];
  private controllers = new Map<string, AbortController>();
  private sockets = new Set<net.Socket>();
  private server: http.Server | null = null;

  constructor(config = loadConfig()) {
    this.config = config;
    this.store = new FileJobStore(config.dataDir);
    this.driver = config.browserMcpCommand
      ? new McpBrowserDriver(config.browserMcpCommand, config.browserMcpArgs)
      : new NullBrowserDriver();
  }

  async start(): Promise<http.Server> {
    await this.driver.ensureReady().catch(() => {});
    this.server = http.createServer((req, res) => void this.route(req, res));
    this.server.on('connection', socket => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server!.listen(this.config.port, this.config.host, resolve));
    return this.server;
  }

  async stop(): Promise<void> {
    await this.driver.close().catch(() => {});
    for (const socket of this.sockets) {
      try { socket.destroy(); } catch {}
    }
    this.sockets.clear();
    if (this.server && 'closeIdleConnections' in this.server) {
      try { (this.server as any).closeIdleConnections(); } catch {}
    }
    if (this.server && 'closeAllConnections' in this.server) {
      try { (this.server as any).closeAllConnections(); } catch {}
    }
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (!this.authorize(req)) return this.sendJson(res, 401, { error: 'Unauthorized' });
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/ui')) return this.serveSpa(res);
      if (req.method === 'GET' && url.pathname.startsWith('/assets/')) return this.serveSpaAsset(res, url.pathname);
      if (req.method === 'GET' && url.pathname === '/favicon.ico') return this.serveSpaAsset(res, '/favicon.ico');
      if (req.method === 'GET' && url.pathname === '/health') return this.sendJson(res, 200, { ok: true, status: 'ready' });
      if (req.method === 'GET' && url.pathname === '/openapi.json') return this.sendJson(res, 200, openApiDocument);
      if (req.method === 'GET' && url.pathname === '/jobs') return this.sendJson(res, 200, { items: this.store.list() });
      if (req.method === 'POST' && url.pathname === '/jobs') return this.createJob(req, res, url);
      const jobIdMatch = url.pathname.match(/^\/jobs\/([^/]+)(?:\/(cancel|retry|wait|run|logs))?$/);
      if (jobIdMatch) return this.handleJobAction(req, res, url, jobIdMatch[1], jobIdMatch[2]);
      return this.sendJson(res, 404, { error: 'Not found' });
    } catch (err: any) {
      return this.sendJson(res, 500, { error: err?.message || 'Internal server error' });
    }
  }

  private async createJob(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const body = await readJson(req);
    const payload = this.validateJobRequest(body);
    if ('error' in payload) return this.sendJson(res, 400, payload);
    const existing = payload.idempotencyKey ? this.store.findByIdempotencyKey(payload.idempotencyKey) : undefined;
    if (existing) return this.sendJson(res, 200, { job: existing, deduplicated: true });
    const wait = readBooleanQuery(url.searchParams.get('wait'), true);
    const job: JobRecord = {
      id: crypto.randomUUID(),
      name: payload.name,
      instruction: payload.instruction,
      outputSchema: payload.outputSchema,
      examples: payload.examples,
      requiredFields: payload.requiredFields,
      strict: payload.strict,
      autoRun: payload.autoRun !== false,
      timeoutMs: payload.timeoutMs ?? this.config.jobTimeoutMs,
      priority: payload.priority ?? 0,
      metadata: payload.metadata ?? {},
      idempotencyKey: payload.idempotencyKey,
      status: 'queued',
      createdAt: new Date().toISOString(),
      attempts: 0,
      logs: [],
      executions: [],
    };
    this.store.upsert(job);
    if (job.autoRun) void this.schedule(job.id);
    if (!wait) return this.sendJson(res, 201, { job });
    const done = await this.waitForJob(job.id, job.timeoutMs || this.config.jobTimeoutMs);
    return this.sendJson(res, done.status === 200 ? 200 : 504, done.body);
  }

  private async handleJobAction(req: http.IncomingMessage, res: http.ServerResponse, url: URL, id: string, action?: string): Promise<void> {
    const job = this.store.get(id);
    if (!job) return this.sendJson(res, 404, { error: 'Job not found' });
    if (req.method === 'GET' && !action) {
      const view = (url.searchParams.get('view') || url.searchParams.get('format') || '').toLowerCase();
      if (view === 'record' || view === 'job' || view === 'details') {
        return this.sendJson(res, 200, { job });
      }
      return this.sendJobOutput(res, await this.waitForJobResult(id, job.timeoutMs || this.config.jobTimeoutMs));
    }
    if (req.method === 'PUT' && !action) return this.updateJob(req, res, id, job);
    if (req.method === 'DELETE' && !action) {
      if (job.status === 'running') return this.sendJson(res, 409, { error: 'Job is already running' });
      this.controllers.get(id)?.abort();
      this.controllers.delete(id);
      this.queue = this.queue.filter(item => item !== id);
      this.store.remove(id);
      this.store.onComplete(id);
      return this.sendJson(res, 200, { deleted: true, jobId: id });
    }
    if (req.method === 'POST' && action === 'cancel') {
      this.controllers.get(id)?.abort();
      job.status = 'canceled';
      job.finishedAt = new Date().toISOString();
      this.store.upsert(job);
      this.store.onComplete(id);
      return this.sendJson(res, 200, { job });
    }
    if (req.method === 'POST' && action === 'retry') {
      if (job.status === 'running') return this.sendJson(res, 409, { error: 'Job is already running' });
      job.status = 'queued';
      job.error = undefined;
      job.output = undefined;
      job.resultSummary = undefined;
      job.startedAt = undefined;
      job.finishedAt = undefined;
      job.durationMs = undefined;
      job.logs = [];
      job.attempts += 1;
      this.store.upsert(job);
      void this.schedule(id);
      return this.sendJson(res, 200, { job });
    }
    if (req.method === 'POST' && action === 'run') {
      if (job.status === 'running') return this.sendJson(res, 409, { error: 'Job is already running' });
      job.status = 'queued';
      this.store.upsert(job);
      void this.schedule(id);
      const wait = readBooleanQuery(url.searchParams.get('wait'), true);
      if (wait) {
        return this.sendJobOutput(res, await this.waitForJobResult(id, job.timeoutMs || this.config.jobTimeoutMs));
      }
      return this.sendJson(res, 200, { job, manualRun: true });
    }
    if (req.method === 'GET' && action === 'logs') {
      return this.sendJson(res, 200, { jobId: id, logs: job.logs });
    }
    if (req.method === 'POST' && action === 'wait') {
      const done = await this.waitForJob(id, job.timeoutMs || this.config.jobTimeoutMs);
      return this.sendJson(res, done.status === 200 ? 200 : 504, done.body);
    }
    return this.sendJson(res, 405, { error: 'Method not allowed' });
  }

  private async updateJob(req: http.IncomingMessage, res: http.ServerResponse, id: string, job: JobRecord): Promise<void> {
    if (job.status === 'running') return this.sendJson(res, 409, { error: 'Job is already running' });
    const body = await readJson(req);
    const payload = this.validateJobRequest(body, job);
    if ('error' in payload) return this.sendJson(res, 400, payload);
    const updated: JobRecord = {
      ...job,
      name: payload.name,
      instruction: payload.instruction,
      outputSchema: payload.outputSchema,
      outputExample: payload.outputExample,
      examples: payload.examples,
      requiredFields: payload.requiredFields,
      strict: payload.strict,
      autoRun: payload.autoRun !== false,
      timeoutMs: payload.timeoutMs ?? job.timeoutMs ?? this.config.jobTimeoutMs,
      priority: payload.priority ?? job.priority ?? 0,
      metadata: payload.metadata ?? job.metadata ?? {},
      idempotencyKey: payload.idempotencyKey ?? job.idempotencyKey,
      status: 'queued',
      output: undefined,
      error: undefined,
      resultSummary: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      durationMs: undefined,
      logs: [],
    };
    this.store.upsert(updated);
    return this.sendJson(res, 200, { job: updated });
  }

  private async schedule(id: string): Promise<void> {
    if (this.queue.includes(id)) return;
    this.queue.push(id);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running >= this.config.maxConcurrentJobs) return;
    const nextId = this.queue.shift();
    if (!nextId) return;
    const job = this.store.get(nextId);
    if (!job || job.status !== 'queued') return void this.drain();
    this.running += 1;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.attempts += 1;
    this.store.upsert(job);
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const timer = setTimeout(() => controller.abort(), job.timeoutMs || this.config.jobTimeoutMs);
    const executionLogStart = job.logs.length;
    try {
      const result = await executeJob(
        job,
        this.driver,
        controller.signal,
        (level, message, data) => this.log(job.id, level, message, data),
        { deepseekApiKey: this.config.deepseekApiKey },
      );
      const latest = this.store.get(job.id) || job;
      latest.status = 'succeeded';
      latest.output = result.output;
      latest.resultSummary = result.summary;
      latest.error = undefined;
      latest.finishedAt = new Date().toISOString();
      latest.durationMs = new Date(latest.finishedAt).getTime() - new Date(latest.startedAt || latest.finishedAt).getTime();
      appendExecution(latest, {
        attempt: latest.attempts,
        status: latest.status,
        startedAt: latest.startedAt,
        finishedAt: latest.finishedAt,
        durationMs: latest.durationMs,
        output: latest.output,
        resultSummary: latest.resultSummary,
        logs: latest.logs.slice(executionLogStart),
      });
      this.store.upsert(latest);
      this.store.onComplete(job.id);
    } catch (err: any) {
      const canceled = controller.signal.aborted;
      const latest = this.store.get(job.id) || job;
      latest.status = canceled ? 'timed_out' : ((latest.status as JobStatus) === 'canceled' ? 'canceled' : 'failed');
      latest.error = String(err?.message || err);
      latest.finishedAt = new Date().toISOString();
      latest.durationMs = new Date(latest.finishedAt).getTime() - new Date(latest.startedAt || latest.finishedAt).getTime();
      appendExecution(latest, {
        attempt: latest.attempts,
        status: latest.status,
        startedAt: latest.startedAt,
        finishedAt: latest.finishedAt,
        durationMs: latest.durationMs,
        error: latest.error,
        logs: latest.logs.slice(executionLogStart),
      });
      this.store.upsert(latest);
      this.store.onComplete(job.id);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(job.id);
      this.running -= 1;
      void this.drain();
    }
  }

  private async waitForJob(id: string, timeoutMs: number): Promise<{ status: number; body: unknown }> {
    const job = this.store.get(id);
    if (!job) return { status: 404, body: { error: 'Job not found' } };
    if (!isActive(job.status)) return { status: 200, body: { job } };
    return new Promise(resolve => {
      const deadline = setTimeout(() => resolve({ status: 504, body: { error: 'Timed out waiting for job', job: this.store.get(id) } }), timeoutMs);
      const done = () => {
        clearTimeout(deadline);
        this.store.waitersFor(id).delete(done);
        const latest = this.store.get(id);
        if (!latest) {
          resolve({ status: 404, body: { error: 'Job not found' } });
          return;
        }
        resolve({ status: 200, body: { job: latest } });
      };
      this.store.waitersFor(id).add(done);
    });
  }

  private async waitForJobResult(id: string, timeoutMs: number): Promise<{ status: number; body: unknown }> {
    const job = this.store.get(id);
    if (!job) return { status: 404, body: { error: 'Job not found' } };
    if (isActive(job.status)) {
      const waited = await this.waitForJob(id, timeoutMs);
      if (waited.status !== 200) return waited;
    }
    const latest = this.store.get(id);
    if (!latest) return { status: 404, body: { error: 'Job not found' } };
    if (latest.status === 'succeeded') {
      return { status: 200, body: latest.output ?? null };
    }
    const statusCode = latest.status === 'timed_out' ? 504 : latest.status === 'canceled' ? 409 : 500;
    return {
      status: statusCode,
      body: {
        error: latest.error || `Job ${latest.status}`,
        status: latest.status,
        jobId: latest.id,
        resultSummary: latest.resultSummary,
      },
    };
  }

  private validateJobRequest(body: unknown, base?: Partial<JobRequest>): JobRequest | { error: string } {
    if (!body || typeof body !== 'object') return { error: 'Invalid JSON body' };
    const payload = body as Partial<JobRequest>;
    const instruction = typeof payload.instruction === 'string' ? payload.instruction.trim() : base?.instruction;
    if (typeof instruction !== 'string' || !instruction.trim()) return { error: 'instruction is required' };
    if (instruction.length > this.config.maxJobInstructionChars) return { error: 'instruction too long' };
    const inferredSchema = inferOutputSchema(payload.outputSchema ?? base?.outputSchema, payload.outputExample ?? base?.outputExample);
    if (!inferredSchema) return { error: 'outputSchema or outputExample is required' };
    return {
      name: typeof payload.name === 'string' ? payload.name : base?.name,
      instruction,
      outputSchema: inferredSchema,
      outputExample: payload.outputExample ?? base?.outputExample,
      examples: Array.isArray(payload.examples) ? payload.examples : base?.examples,
      requiredFields: Array.isArray(payload.requiredFields) ? payload.requiredFields.filter((x): x is string => typeof x === 'string') : base?.requiredFields,
      strict: payload.strict === true || (payload.strict == null ? !!base?.strict : false),
      autoRun: typeof payload.autoRun === 'boolean' ? payload.autoRun : base?.autoRun,
      timeoutMs: typeof payload.timeoutMs === 'number' ? payload.timeoutMs : base?.timeoutMs,
      priority: typeof payload.priority === 'number' ? payload.priority : base?.priority,
      metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata as Record<string, unknown> : base?.metadata as Record<string, unknown> | undefined,
      idempotencyKey: typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey : base?.idempotencyKey,
    };
  }

  private authorize(req: http.IncomingMessage): boolean {
    if (!this.config.apiKey) return true;
    const hdr = req.headers.authorization || '';
    return hdr === `Bearer ${this.config.apiKey}`;
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body, null, 2));
  }

  private sendHtml(res: http.ServerResponse, status: number, html: string): void {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  }

  private serveSpa(res: http.ServerResponse): void {
    const indexPath = this.getSpaIndexPath();
    if (indexPath) return this.sendStaticFile(res, indexPath, 'text/html; charset=utf-8', true);
    return this.sendHtml(res, 200, renderDashboard(this.config));
  }

  private serveSpaAsset(res: http.ServerResponse, urlPath: string): void {
    const assetPath = this.resolveSpaAssetPath(urlPath);
    if (!assetPath) return this.sendHtml(res, 404, 'Not found');
    this.sendStaticFile(res, assetPath, this.contentTypeForPath(assetPath), false);
  }

  private sendStaticFile(res: http.ServerResponse, filePath: string, contentType: string, noStore: boolean): void {
    try {
      const body = fs.readFileSync(filePath);
      res.writeHead(200, {
        'content-type': contentType,
        'cache-control': noStore ? 'no-store' : 'public, max-age=31536000, immutable',
      });
      res.end(body);
    } catch {
      this.sendHtml(res, 404, 'Not found');
    }
  }

  private getSpaRoot(): string {
    return path.resolve(process.cwd(), 'web', 'dist');
  }

  private getSpaIndexPath(): string | null {
    const indexPath = path.join(this.getSpaRoot(), 'index.html');
    return fs.existsSync(indexPath) ? indexPath : null;
  }

  private resolveSpaAssetPath(urlPath: string): string | null {
    const root = this.getSpaRoot();
    const candidate = path.resolve(root, `.${urlPath}`);
    if (!candidate.startsWith(root)) return null;
    if (!fs.existsSync(candidate)) return null;
    const stat = fs.statSync(candidate);
    return stat.isFile() ? candidate : null;
  }

  private contentTypeForPath(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case '.js': return 'application/javascript; charset=utf-8';
      case '.mjs': return 'application/javascript; charset=utf-8';
      case '.css': return 'text/css; charset=utf-8';
      case '.html': return 'text/html; charset=utf-8';
      case '.svg': return 'image/svg+xml';
      case '.png': return 'image/png';
      case '.ico': return 'image/x-icon';
      case '.json': return 'application/json; charset=utf-8';
      case '.map': return 'application/json; charset=utf-8';
      default: return 'application/octet-stream';
    }
  }

  private log(jobId: string, level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    const job = this.store.get(jobId);
    if (!job) return;
    job.logs.push({ ts: new Date().toISOString(), level, message, data });
    this.store.upsert(job);
  }

  private sendJobOutput(res: http.ServerResponse, result: { status: number; body: unknown }): void {
    this.sendJson(res, result.status, result.body);
  }
}

function isActive(status: JobStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting_input';
}

function readBooleanQuery(raw: string | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const value = raw.trim().toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function appendExecution(job: JobRecord, execution: JobExecutionRecord): void {
  if (!Array.isArray(job.executions)) job.executions = [];
  job.executions.push(execution);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function renderDashboard(config: AppConfig): string {
  const endpoints = [
    ['GET', '/health', 'Health check'],
    ['POST', '/jobs', 'Create a job'],
    ['GET', '/jobs', 'List jobs'],
    ['GET', '/jobs/:id', 'Get job details'],
    ['POST', '/jobs/:id/run', 'Run job and wait for the final output'],
    ['POST', '/jobs/:id/cancel', 'Cancel job'],
    ['POST', '/jobs/:id/retry', 'Retry job'],
    ['POST', '/jobs/:id/wait', 'Wait for completion'],
    ['GET', '/openapi.json', 'OpenAPI spec'],
  ];
  const baseUrl = `http://${config.host}:${config.port}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bah Browser API</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f1115;
      --panel: #161a22;
      --panel-2: #1e2430;
      --text: #e8edf7;
      --muted: #96a1b2;
      --accent: #7dd3fc;
      --accent-2: #a78bfa;
      --border: #2a3242;
      --good: #34d399;
      --bad: #f87171;
      --warn: #fbbf24;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        radial-gradient(circle at top left, rgba(125, 211, 252, 0.12), transparent 30%),
        radial-gradient(circle at top right, rgba(167, 139, 250, 0.14), transparent 24%),
        var(--bg);
      color: var(--text);
    }
    .shell { max-width: 1280px; margin: 0 auto; padding: 32px 20px 56px; }
    .menu-card {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      align-items: center;
      margin-bottom: 16px;
    }
    .menu-brand {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .menu-brand h1 { margin-bottom: 2px; }
    .menu-tabs { display: flex; flex-wrap: wrap; gap: 8px; }
    .menu-tab {
      padding: 9px 14px;
      border-radius: 999px;
      background: transparent;
      color: var(--muted);
    }
    .menu-tab.active {
      color: var(--text);
      border-color: rgba(125, 211, 252, 0.55);
      background: rgba(125, 211, 252, 0.08);
    }
    .view-pane { display: none; }
    .view-pane.active { display: block; }
    .hero.view-pane.active { display: grid; }
    .hero {
      display: grid;
      grid-template-columns: 1.2fr 0.8fr;
      gap: 16px;
      margin-bottom: 18px;
    }
    .card {
      background: linear-gradient(180deg, rgba(255,255,255,0.03), transparent), var(--panel);
      border: 1px solid var(--border);
      border-radius: 18px;
      box-shadow: 0 16px 40px rgba(0,0,0,0.25);
      padding: 18px;
    }
    h1, h2, h3 { margin: 0 0 10px; }
    h1 { font-size: 34px; }
    .sub { color: var(--muted); line-height: 1.5; }
    .grid { display: grid; gap: 16px; }
    .endpoint-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .two-col { grid-template-columns: 1.1fr 0.9fr; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.03);
      padding: 8px 12px;
      border-radius: 999px;
      color: var(--text);
      font-size: 13px;
    }
    .pill strong { color: var(--accent); }
    .endpoint {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      padding: 12px 14px;
      border-radius: 14px;
      background: var(--panel-2);
      border: 1px solid var(--border);
    }
    .method {
      font-weight: 700;
      font-size: 12px;
      letter-spacing: .08em;
      color: var(--accent);
    }
    .path { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .muted { color: var(--muted); font-size: 13px; }
    textarea, input, select {
      width: 100%;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: #0f1320;
      color: var(--text);
      padding: 12px 14px;
      font: inherit;
    }
    textarea { min-height: 120px; resize: vertical; }
    label { display: block; margin: 0 0 6px; color: var(--muted); font-size: 13px; }
    .row { display: grid; gap: 12px; margin-bottom: 12px; }
    .row.cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .row.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .section-label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }
    .step-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 5px 10px;
      border-radius: 999px;
      background: rgba(125, 211, 252, 0.1);
      border: 1px solid rgba(125, 211, 252, 0.25);
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
    }
    .step-helper { color: var(--muted); font-size: 12px; }
    .preset-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
    .preset-row button {
      padding: 8px 12px;
      font-size: 13px;
      border-radius: 999px;
    }
    .step-panel {
      padding: 14px;
      border-radius: 16px;
      background: rgba(255,255,255,0.02);
      border: 1px solid rgba(255,255,255,0.04);
      margin-bottom: 12px;
    }
    .step-panel.compact { padding-bottom: 10px; }
    .step-panel h3 { margin-bottom: 6px; font-size: 15px; }
    .step-panel .sub { font-size: 13px; }
    button {
      appearance: none;
      border: 1px solid var(--border);
      background: linear-gradient(180deg, rgba(255,255,255,0.06), transparent), #1d2432;
      color: var(--text);
      padding: 11px 14px;
      border-radius: 12px;
      cursor: pointer;
      font-weight: 600;
    }
    button:hover { border-color: var(--accent); }
    .ghost { background: transparent; }
    .good { color: var(--good); }
    .bad { color: var(--bad); }
    .warn { color: var(--warn); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .jobs {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
      gap: 12px;
      align-items: start;
    }
    .job {
      border: 1px solid var(--border);
      background: var(--panel-2);
      border-radius: 16px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    .job-head { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
    .job-title { font-weight: 700; }
    .job-meta { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
    .job-summary {
      width: 100%;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 10px;
      cursor: pointer;
    }
    .job-summary::-webkit-details-marker { display: none; }
    .job-summary-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
    }
    .job-summary-title {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .job-summary-tools { display: flex; flex-wrap: wrap; gap: 8px; }
    .job-body {
      padding-top: 12px;
      margin-top: 12px;
      border-top: 1px solid var(--border);
    }
    .dashboard-stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-top: 14px;
    }
    .stat {
      padding: 12px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.03);
    }
    .stat .value { display:block; margin-top: 4px; font-size: 24px; font-weight: 800; color: var(--text); }
    .stat .label { color: var(--muted); font-size: 12px; letter-spacing: .04em; text-transform: uppercase; }
    .tag {
      display:inline-flex;
      border-radius:999px;
      padding:4px 10px;
      background: rgba(255,255,255,0.05);
      border:1px solid var(--border);
      font-size:12px;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: #0d1020;
      border: 1px solid var(--border);
      padding: 12px;
      border-radius: 12px;
      overflow:auto;
      margin: 10px 0 0;
      font-size: 12px;
      line-height: 1.5;
    }
    .topline { display:flex; flex-wrap:wrap; gap:12px; justify-content:space-between; align-items:center; margin-bottom: 16px; }
    .tiny { font-size: 12px; color: var(--muted); }
    .split { display:grid; grid-template-columns: 1fr 1fr; gap:12px; }
    .statusline { margin-top: 10px; min-height: 20px; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .history { display: grid; gap: 10px; }
    .history-item {
      border: 1px solid var(--border);
      background: #111624;
      border-radius: 14px;
      padding: 12px;
    }
    .history-head {
      display:flex;
      flex-wrap:wrap;
      justify-content:space-between;
      gap:12px;
      align-items:flex-start;
    }
    .history-title { font-weight: 700; }
    .history-grid { display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-top:10px; }
    .history-block {
      border: 1px solid var(--border);
      background: #0d1020;
      border-radius: 12px;
      padding: 10px;
    }
    .history-block .tiny { margin-bottom: 6px; }
    .chip-row { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
    details.collapsible {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: #0d1020;
      overflow: hidden;
    }
    details.collapsible > summary {
      cursor: pointer;
      list-style: none;
      padding: 10px 12px;
      font-weight: 600;
      color: var(--text);
    }
    details.collapsible > summary::-webkit-details-marker { display: none; }
    details.collapsible .collapsible-body { padding: 0 12px 12px; }
    @media (max-width: 720px) {
      .shell { padding: 18px 12px 36px; }
      .menu-card { grid-template-columns: 1fr; }
      .menu-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
      .menu-tab { width: 100%; justify-content: center; }
      .hero { gap: 12px; }
      .card { padding: 14px; border-radius: 16px; }
      .jobs { grid-template-columns: 1fr; }
      .job, .job-body, .history-item, .history-block { border-radius: 14px; }
      .job-summary-head, .job-head, .history-head, .topline, .actions, .section-label {
        flex-direction: column;
        align-items: stretch;
      }
      .job-meta, .chip-row, .preset-row { gap: 6px; }
      .actions button, .actions a, .preset-row button, .menu-tab { width: 100%; }
      .dashboard-stats { grid-template-columns: 1fr; }
      .endpoint-grid, .history-grid, .split { grid-template-columns: 1fr; }
      textarea { min-height: 140px; }
      pre { font-size: 11px; }
    }
    @media (max-width: 980px) {
      .hero, .two-col, .endpoint-grid, .row.cols-2, .row.cols-3, .split, .history-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="topline">
      <div class="pill"><strong>Base URL</strong> <span class="mono">${escapeHtml(baseUrl)}</span></div>
      <div class="pill"><strong>Auth</strong> <span>${config.apiKey ? 'Bearer token required' : 'none'}</span></div>
      <div class="pill"><strong>Worker</strong> <span class="mono">${escapeHtml(config.browserMcpCommand || 'not configured')}</span></div>
    </div>

    <section class="card menu-card">
      <div class="menu-brand">
        <h1>Bah Browser API</h1>
        <p class="sub">Move between the dashboard, job editor, job history, and endpoint docs without scanning the whole page.</p>
      </div>
      <div class="menu-tabs" role="tablist" aria-label="Dashboard navigation">
        <button type="button" class="menu-tab active" data-nav="dashboard">Dashboard</button>
        <button type="button" class="menu-tab" data-nav="jobs">Jobs</button>
        <button type="button" class="menu-tab" data-nav="history">History</button>
        <button type="button" class="menu-tab" data-nav="endpoints">Endpoints</button>
      </div>
    </section>

    <div class="hero view-pane active" data-view="dashboard">
      <section class="card">
        <h2>Start here</h2>
        <p class="sub">Create browser jobs by pasting a real JSON example, then watch the status, output, and history live from this screen.</p>
        <div class="actions" style="margin-top:14px">
          <button id="refreshJobs">Refresh jobs</button>
          <button id="goJobs" class="ghost">Go to jobs</button>
          <button id="seedExample" class="ghost">Load example job</button>
          <a class="pill" href="/openapi.json" target="_blank" rel="noreferrer">OpenAPI</a>
          <a class="pill" href="/jobs" target="_blank" rel="noreferrer">Jobs JSON</a>
        </div>
        <div class="statusline tiny" id="globalStatus"></div>
        <div class="dashboard-stats">
          <div class="stat"><span class="label">Total jobs</span><span class="value" id="statTotalJobs">0</span></div>
          <div class="stat"><span class="label">Active jobs</span><span class="value" id="statActiveJobs">0</span></div>
          <div class="stat"><span class="label">Successful jobs</span><span class="value" id="statSuccessJobs">0</span></div>
        </div>
        <div style="margin-top:14px">
          <div class="topline" style="margin-bottom:8px">
            <h3 style="margin:0">Recent jobs</h3>
            <span class="tiny">Latest saved jobs always stay visible here.</span>
          </div>
          <div id="recentJobs" class="jobs"></div>
        </div>
      </section>

      <section class="card view-pane" data-view="dashboard" id="endpointCard">
        <h2>Endpoints</h2>
        <div class="grid endpoint-grid">
          ${endpoints.map(([method, path, desc]) => `
            <div class="endpoint">
              <div>
                <div class="method">${method}</div>
                <div class="path">${path}</div>
                <div class="muted">${desc}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </section>
    </div>

    <div class="grid two-col">
      <section class="card view-pane" data-view="jobs">
        <h2>New Job</h2>
        <form id="jobForm">
          <div class="step-panel compact">
            <div class="section-label">
              <h3>Step 1. Choose a starting point</h3>
              <span class="step-badge">Fast start</span>
            </div>
            <div class="preset-row">
              <button type="button" class="ghost" data-preset="login">Login</button>
              <button type="button" class="ghost" data-preset="create_test">Create Test</button>
              <button type="button" class="ghost" data-preset="scrape">Scrape</button>
              <button type="button" class="ghost" id="clearPreset">Clear</button>
            </div>
            <div class="row cols-2">
              <div>
                <label for="apiKey">API key</label>
                <input id="apiKey" placeholder="Bearer token if required" />
              </div>
              <div>
                <label for="jobName">Job name</label>
                <input id="jobName" placeholder="Optional label" />
              </div>
            </div>
          </div>
          <div class="step-panel">
            <div class="section-label">
              <h3>Step 2. Write the instruction</h3>
              <span class="step-helper">Tell the browser exactly what to do</span>
            </div>
            <div class="row">
              <div>
                <label for="instruction">Instruction</label>
                <textarea id="instruction" placeholder="Example: open google.com and capture the top news headlines"></textarea>
              </div>
            </div>
          </div>
          <div class="step-panel">
            <div class="section-label">
              <h3>Step 3. Paste an output example</h3>
              <span class="step-helper">The API turns real JSON into the schema</span>
            </div>
            <div class="row cols-2">
              <div>
                <label for="outputExample">Output example JSON</label>
                <textarea id="outputExample" class="mono">{\n  "username": "LuizDavi",\n  "password": "LuizDavi23"\n}</textarea>
                <div class="tiny" style="margin-top:6px">Paste a real JSON example. The API infers the schema automatically.</div>
              </div>
              <div>
                <label for="schemaPreview">Inferred schema</label>
                <pre id="schemaPreview" class="mono" style="min-height:120px; margin-top:0"></pre>
              </div>
            </div>
          </div>
          <details class="collapsible" style="margin-bottom:12px">
            <summary>Advanced settings</summary>
            <div class="collapsible-body" style="padding-top:12px">
              <div class="row cols-2">
                <div>
                  <label for="outputSchema">Force schema manually</label>
                  <textarea id="outputSchema" class="mono" placeholder='{"type":"object","properties":{"username":{"type":"string"}},"required":["username"]}'></textarea>
                  <div class="tiny" style="margin-top:6px">Leave empty to infer from the example above.</div>
                </div>
                <div>
                  <label for="examples">Examples JSON</label>
                  <textarea id="examples" class="mono">[]</textarea>
                </div>
              </div>
              <div class="row cols-3">
                <div>
                  <label for="requiredFields">Required fields</label>
                  <input id="requiredFields" placeholder="username,password" />
                </div>
                <div>
                  <label for="timeoutMs">Timeout ms</label>
                  <input id="timeoutMs" type="number" value="${config.jobTimeoutMs}" />
                </div>
                <div>
                  <label for="idempotencyKey">Idempotency key</label>
                  <input id="idempotencyKey" placeholder="optional" />
                </div>
              </div>
              <div class="row cols-2">
                <div>
                  <label><input id="strict" type="checkbox" /> Strict schema</label>
                </div>
                <div>
                  <label for="metadata">Metadata JSON</label>
                  <input id="metadata" class="mono" placeholder='{"source":"ui"}' />
                </div>
              </div>
            </div>
          </details>
          <div class="actions">
            <button id="submitJobBtn" type="submit">Create Job</button>
            <button type="button" class="ghost" id="copyCreateCurl">Copy curl</button>
            <span class="tiny">Paste a JSON example, save, then run the job from the list below.</span>
          </div>
        </form>
        <div class="statusline" id="jobStatus"></div>
      </section>

      <section class="card view-pane" data-view="jobs">
        <h2>Endpoint Preview</h2>
        <div class="split">
          <div>
            <div class="tiny">Create</div>
            <pre id="endpointPreviewCreate" class="mono"></pre>
          </div>
          <div>
            <div class="tiny">Inspect</div>
            <pre id="endpointPreviewInspect" class="mono"></pre>
          </div>
        </div>
      </section>
    </div>

    <section class="card view-pane" data-view="jobs" style="margin-top:16px">
      <div class="topline" style="margin-bottom:8px">
        <h2>Jobs</h2>
        <div class="actions">
          <button id="pollToggle" class="ghost">Auto refresh: on</button>
          <button id="clearJobs" class="ghost">Clear list view</button>
          <span class="tiny">Cards stay compact until you expand them.</span>
        </div>
      </div>
      <div class="jobs" id="jobs"></div>
    </section>
    <section class="card view-pane" data-view="history" style="margin-top:16px">
      <div class="topline" style="margin-bottom:8px">
        <h2>Selected Job</h2>
        <div class="actions">
          <button id="editSelectedJob" class="ghost">Edit in form</button>
          <button id="manualRun" class="ghost">Run manually</button>
          <button id="copyRunEndpoint" class="ghost">Copy curl</button>
          <button id="copyLogsEndpoint" class="ghost">Copy logs endpoint</button>
        </div>
      </div>
      <div class="split">
        <div>
          <div class="tiny">Job</div>
          <pre id="selectedJobDetail" class="mono"></pre>
        </div>
        <div>
          <div class="tiny">Logs</div>
          <pre id="selectedJobLogs" class="mono"></pre>
        </div>
      </div>
      <div class="split" style="margin-top:12px">
        <details id="selectedJobRequestDetails" class="collapsible">
          <summary>Request example</summary>
          <div class="collapsible-body">
            <div class="actions" style="margin-top:10px">
              <button id="copySelectedRunCurl" class="ghost">Copy run curl</button>
            </div>
            <pre id="selectedJobRequestExample" class="mono"></pre>
          </div>
        </details>
        <details id="selectedJobResponseDetails" class="collapsible">
          <summary>Response example</summary>
          <div class="collapsible-body">
            <div class="actions" style="margin-top:10px">
              <button id="copySelectedResponseExample" class="ghost">Copy response example</button>
            </div>
            <pre id="selectedJobResponseExample" class="mono"></pre>
          </div>
        </details>
      </div>
      <div style="margin-top:12px">
        <details id="selectedJobOutputDetails" class="collapsible">
          <summary>Output</summary>
          <div class="collapsible-body">
            <pre id="selectedJobOutput" class="mono"></pre>
          </div>
        </details>
      </div>
      <div style="margin-top:12px">
        <div class="tiny">Execution History</div>
        <div id="selectedJobHistory" class="history" style="margin-top:8px"></div>
      </div>
      <div class="statusline" id="detailStatus"></div>
    </section>

    <section class="card view-pane" data-view="endpoints" style="margin-top:16px">
      <div class="topline" style="margin-bottom:8px">
        <div>
          <h2>Endpoints</h2>
          <div class="tiny">Copy a route and use it immediately from your API client or integration.</div>
        </div>
        <div class="actions">
          <button id="backToDashboard" class="ghost" type="button">Back to dashboard</button>
        </div>
      </div>
      <div class="grid endpoint-grid">
        ${endpoints.map(([method, path, desc]) => `
          <div class="endpoint">
            <div>
              <div class="method">${method}</div>
              <div class="path">${escapeHtml(path)}</div>
              <div class="muted">${escapeHtml(desc)}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </section>
  </div>

  <script>
    const baseUrl = ${JSON.stringify(baseUrl)};
    const config = ${JSON.stringify({ apiKey: !!config.apiKey })};
    const ls = window.localStorage;
    const $ = (id) => document.getElementById(id);
    const state = { jobs: [], polling: true, selectedJobId: null, editingJobId: null, activeView: 'dashboard' };

    const fmt = (v) => typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    const safeJson = (value, fallback) => {
      try { return JSON.parse(value); } catch { return fallback; }
    };
    const inferSchema = (value) => {
      if (value === null) return { type: 'null' };
      if (Array.isArray(value)) {
        if (!value.length) return { type: 'array', items: {} };
        return { type: 'array', items: inferSchema(value[0]) };
      }
      switch (typeof value) {
        case 'string':
          return { type: 'string' };
        case 'number':
          return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
        case 'boolean':
          return { type: 'boolean' };
        case 'object': {
          const properties = {};
          for (const [key, val] of Object.entries(value)) properties[key] = inferSchema(val);
          return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
        }
        default:
          return {};
      }
    };
    const escapeHtml = (value) => String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    const headers = () => {
      const token = $('apiKey').value.trim();
      const h = { 'content-type': 'application/json' };
      if (token) h.authorization = token.startsWith('Bearer ') ? token : 'Bearer ' + token;
      return h;
    };
    const endpointText = (method, path) => method + ' ' + baseUrl + path;
    const updatePreview = () => {
      const example = safeJson($('outputExample').value, null);
      const manualSchema = safeJson($('outputSchema').value, null);
      $('schemaPreview').textContent = manualSchema
        ? JSON.stringify(manualSchema, null, 2)
        : example
          ? JSON.stringify(inferSchema(example), null, 2)
          : 'Paste a JSON example to see the inferred schema.';
      $('endpointPreviewCreate').textContent = endpointText('POST', '/jobs') + '\\n\\n' + JSON.stringify({
        name: $('jobName').value || 'example-job',
        instruction: $('instruction').value || 'open google.com and collect data',
        outputExample: example,
        outputSchema: manualSchema || undefined,
        examples: safeJson($('examples').value, []),
        requiredFields: $('requiredFields').value.split(',').map(s => s.trim()).filter(Boolean),
        strict: $('strict').checked,
        timeoutMs: Number($('timeoutMs').value || 0),
        metadata: $('metadata').value ? safeJson($('metadata').value, undefined) : undefined,
        idempotencyKey: $('idempotencyKey').value || undefined,
      }, null, 2);
      $('endpointPreviewInspect').textContent = endpointText('GET', '/jobs/:id') + ' (returns final output)\\n' + endpointText('GET', '/jobs/:id?view=record') + ' (returns full job)\\n' + endpointText('POST', '/jobs/:id/run') + ' (waits for final output by default)\\n' + endpointText('POST', '/jobs/:id/cancel') + '\\n' + endpointText('POST', '/jobs/:id/retry') + '\\n' + endpointText('POST', '/jobs/:id/wait');
    };
    const presetValues = {
      login: {
        name: 'Login job',
        instruction: 'Open the target site, sign in with the provided credentials, and return the resulting session data or profile fields requested by the user.',
        outputExample: { username: 'LuizDavi', password: 'LuizDavi23' },
        timeoutMs: 300000,
        requiredFields: ['username', 'password'],
      },
      create_test: {
        name: 'Create Test',
        instruction: 'Access https://painel.digitalplus.top/dashboard/, login with the provided credentials, create a new test with 6H, and return the submitted credentials in the response.',
        outputExample: { username: 'LuizDavi', password: 'LuizDavi23' },
        timeoutMs: 300000,
        requiredFields: ['username', 'password'],
      },
      scrape: {
        name: 'Scrape job',
        instruction: 'Open the target page, collect the requested fields, and return structured JSON with the extracted values.',
        outputExample: { title: 'Example title', url: 'https://example.com', done: true },
        timeoutMs: 180000,
        requiredFields: ['title'],
      },
    };
    const setFormMode = (job) => {
      state.editingJobId = job ? job.id : null;
      $('submitJobBtn').textContent = job ? 'Update Job' : 'Create Job';
      $('jobStatus').textContent = job ? 'Editing job ' + job.id : '';
    };
    const applyPreset = (presetName) => {
      const preset = presetValues[presetName];
      if (!preset) return;
      $('jobName').value = preset.name || '';
      $('instruction').value = preset.instruction || '';
      $('outputExample').value = preset.outputExample ? JSON.stringify(preset.outputExample, null, 2) : '';
      $('outputSchema').value = '';
      $('examples').value = '[]';
      $('requiredFields').value = Array.isArray(preset.requiredFields) ? preset.requiredFields.join(',') : '';
      $('timeoutMs').value = String(preset.timeoutMs || config.jobTimeoutMs);
      $('idempotencyKey').value = '';
      $('metadata').value = '';
      $('strict').checked = false;
      updatePreview();
      setFormMode(null);
      setStatus($('jobStatus'), 'Preset "' + presetName.replace('_', ' ') + '" loaded.');
    };
    const fillFormFromJob = (job) => {
      $('jobName').value = job.name || '';
      $('instruction').value = job.instruction || '';
      $('outputExample').value = job.outputExample ? JSON.stringify(job.outputExample, null, 2) : '';
      $('outputSchema').value = job.outputSchema ? JSON.stringify(job.outputSchema, null, 2) : '';
      $('examples').value = job.examples ? JSON.stringify(job.examples, null, 2) : '[]';
      $('requiredFields').value = Array.isArray(job.requiredFields) ? job.requiredFields.join(',') : '';
      $('timeoutMs').value = String(job.timeoutMs || config.jobTimeoutMs);
      $('idempotencyKey').value = job.idempotencyKey || '';
      $('metadata').value = job.metadata ? JSON.stringify(job.metadata, null, 2) : '';
      $('strict').checked = !!job.strict;
      updatePreview();
      setFormMode(job);
      setView('jobs');
      setStatus($('globalStatus'), 'Loaded job ' + job.id + ' into the form.');
    };
    const setStatus = (el, msg, cls = 'tiny') => { el.className = cls; el.textContent = msg; };
    const setView = (view) => {
      state.activeView = view;
      document.querySelectorAll('.view-pane').forEach(panel => {
        panel.classList.toggle('active', panel.getAttribute('data-view') === view);
      });
      document.querySelectorAll('[data-nav]').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-nav') === view);
      });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    const updateStats = () => {
      const total = state.jobs.length;
      const active = state.jobs.filter(job => ['queued', 'running', 'waiting_input'].includes(job.status)).length;
      const success = state.jobs.filter(job => job.status === 'succeeded').length;
      $('statTotalJobs').textContent = String(total);
      $('statActiveJobs').textContent = String(active);
      $('statSuccessJobs').textContent = String(success);
    };
    const copyText = async (text) => {
      try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
    };
    const prettyJson = (value, fallback = 'No example yet.') => {
      if (value === undefined || value === null) return fallback;
      try { return JSON.stringify(value, null, 2); } catch { return String(value); }
    };
    const schemaExample = (schema) => {
      if (!schema || typeof schema !== 'object') return {};
      const type = schema.type;
      if (Array.isArray(type)) return schemaExample({ ...schema, type: type[0] });
      if (schema.const !== undefined) return schema.const;
      if (schema.enum && schema.enum.length) return schema.enum[0];
      if (type === 'null') return null;
      if (type === 'string') return 'string';
      if (type === 'integer') return 1;
      if (type === 'number') return 1.5;
      if (type === 'boolean') return true;
      if (type === 'array') return [schemaExample(schema.items || {})];
      if (type === 'object' || schema.properties) {
        const result = {};
        for (const [key, value] of Object.entries(schema.properties || {})) result[key] = schemaExample(value);
        return result;
      }
      if (schema.oneOf && schema.oneOf.length) return schemaExample(schema.oneOf[0]);
      if (schema.anyOf && schema.anyOf.length) return schemaExample(schema.anyOf[0]);
      return {};
    };
    const responseExampleForJob = (job) => {
      if (job && job.output !== undefined && job.output !== null) return job.output;
      if (job && job.outputExample !== undefined && job.outputExample !== null) return job.outputExample;
      if (job && job.outputSchema) return schemaExample(job.outputSchema);
      return {};
    };
    const buildRequestBodyForJob = (job) => ({
      name: job.name || undefined,
      instruction: job.instruction || '',
      outputExample: job.outputExample !== undefined ? job.outputExample : responseExampleForJob(job),
      outputSchema: job.outputSchema || undefined,
      examples: Array.isArray(job.examples) ? job.examples : [],
      requiredFields: Array.isArray(job.requiredFields) ? job.requiredFields : [],
      strict: !!job.strict,
      timeoutMs: job.timeoutMs || undefined,
      metadata: job.metadata || undefined,
      idempotencyKey: job.idempotencyKey || undefined,
    });
    const authHeaderSegment = () => {
      const token = $('apiKey').value.trim();
      if (!token) return '';
      const value = token.startsWith('Bearer ') ? token : 'Bearer ' + token;
      return ' -H "authorization: ' + value.replace(/"/g, '\\"') + '"';
    };
    const createCurlForJob = (job) => (
      'curl -X POST ' + JSON.stringify(baseUrl + '/jobs') +
      ' -H "content-type: application/json"' +
      authHeaderSegment() +
      ' -d ' + JSON.stringify(JSON.stringify(buildRequestBodyForJob(job)))
    );
    const runCurlForJob = (job) => (
      'curl -X POST ' + JSON.stringify(baseUrl + '/jobs/' + encodeURIComponent(job.id) + '/run') +
      ' -H "content-type: application/json"' +
      authHeaderSegment()
    );
    const selectJob = async (id) => {
      state.selectedJobId = id;
      setView('history');
      await refreshSelectedJob();
    };
    const renderJobs = () => {
      const root = $('jobs');
      if (!state.jobs.length) {
        root.innerHTML = '<div class="muted">No jobs yet.</div>';
        return;
      }
      root.innerHTML = state.jobs.map(job => {
        const runs = Array.isArray(job.executions) ? job.executions.length : 0;
        const detailUrl = '/jobs/' + encodeURIComponent(job.id);
        const selected = state.selectedJobId === job.id;
        const instruction = job.instruction || '';
        const responseExample = prettyJson(responseExampleForJob(job));
        return '<details class="job" ' + (selected ? 'open' : '') + '>'
          + '<summary class="job-summary">'
          + '<div class="job-summary-head">'
          + '<div class="job-summary-title">'
          + '<div class="job-title">' + escapeHtml(job.name || instruction.slice(0, 80) || 'Untitled job') + '</div>'
          + '<div class="muted mono">' + escapeHtml(job.id) + '</div>'
          + '</div>'
          + '<span class="tag">' + escapeHtml(job.status) + '</span>'
          + '</div>'
          + '<div class="job-meta">'
          + '<span class="tag">created ' + escapeHtml(job.createdAt || '-') + '</span>'
          + '<span class="tag">attempts ' + escapeHtml(String(job.attempts || 0)) + '</span>'
          + '<span class="tag">runs ' + escapeHtml(String(runs)) + '</span>'
          + '<span class="tag">timeout ' + escapeHtml(String(job.timeoutMs || '-')) + '</span>'
          + '</div>'
          + '<div class="tiny">' + escapeHtml(instruction.slice(0, 180) + (instruction.length > 180 ? '…' : '')) + '</div>'
          + '</summary>'
          + '<div class="job-body">'
          + '<div class="actions">'
          + '<button data-cancel="' + escapeHtml(job.id) + '">Cancel</button>'
          + '<button data-retry="' + escapeHtml(job.id) + '">Retry</button>'
          + '<button data-wait="' + escapeHtml(job.id) + '">Wait</button>'
          + '</div>'
          + '<details class="collapsible" style="margin-top:12px">'
          + '<summary>Current output</summary>'
          + '<div class="collapsible-body"><pre>' + escapeHtml(job.output ? JSON.stringify(job.output, null, 2) : 'No output yet.') + '</pre></div>'
          + '</details>'
          + '<details class="collapsible" style="margin-top:12px">'
          + '<summary>Current logs</summary>'
          + '<div class="collapsible-body"><pre>' + escapeHtml(job.logs && job.logs.length ? job.logs.map(l => '[' + l.level + '] ' + l.message).join('\\n') : 'No logs yet.') + '</pre></div>'
          + '</details>'
          + '<details class="collapsible" style="margin-top:12px">'
          + '<summary>API examples</summary>'
          + '<div class="collapsible-body">'
          + '<div class="actions" style="margin-top:10px">'
          + '<button data-copy-run="' + escapeHtml(job.id) + '">Copy run curl</button>'
          + '<button data-copy-response="' + escapeHtml(job.id) + '">Copy response example</button>'
          + '</div>'
          + '<div class="split" style="margin-top:10px">'
          + '<div>'
          + '<div class="tiny">Run curl</div>'
          + '<pre class="mono">' + escapeHtml(runCurlForJob(job)) + '</pre>'
          + '</div>'
          + '</div>'
          + '<div style="margin-top:10px">'
          + '<div class="tiny">Response example</div>'
          + '<pre class="mono">' + escapeHtml(responseExample) + '</pre>'
          + '</div>'
          + '</div>'
          + '</details>'
          + '<div class="actions" style="margin-top:12px">'
          + '<button data-copy="' + escapeHtml(detailUrl) + '">Copy endpoint</button>'
          + '<a class="pill" href="' + escapeHtml(detailUrl) + '" target="_blank" rel="noreferrer">Open</a>'
          + '</div>'
          + '</div>'
          + '</details>';
      }).join('');
      root.querySelectorAll('[data-copy]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const copied = await copyText(baseUrl + btn.getAttribute('data-copy'));
          setStatus($('globalStatus'), copied ? 'Endpoint copied.' : 'Copy failed.');
        });
      });
      root.querySelectorAll('[data-cancel]').forEach(btn => {
        btn.addEventListener('click', () => actionJob(btn.getAttribute('data-cancel'), 'cancel'));
      });
      root.querySelectorAll('[data-retry]').forEach(btn => {
        btn.addEventListener('click', () => actionJob(btn.getAttribute('data-retry'), 'retry'));
      });
      root.querySelectorAll('[data-wait]').forEach(btn => {
        btn.addEventListener('click', () => actionJob(btn.getAttribute('data-wait'), 'wait'));
      });
      root.querySelectorAll('[data-copy-run]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const job = state.jobs.find(item => item.id === btn.getAttribute('data-copy-run'));
          if (!job) return;
          const ok = await copyText(runCurlForJob(job));
          setStatus($('globalStatus'), ok ? 'Run curl copied.' : 'Copy failed.');
        });
      });
      root.querySelectorAll('[data-copy-response]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const job = state.jobs.find(item => item.id === btn.getAttribute('data-copy-response'));
          if (!job) return;
          const ok = await copyText(prettyJson(responseExampleForJob(job)));
          setStatus($('globalStatus'), ok ? 'Response example copied.' : 'Copy failed.');
        });
      });
      root.querySelectorAll('details.job').forEach(detail => {
        detail.addEventListener('toggle', () => {
          if (detail.open) {
            const id = detail.querySelector('.muted.mono')?.textContent;
            if (id) void selectJob(id.trim());
          }
        });
      });
    };
    const renderRecentJobs = () => {
      const root = $('recentJobs');
      if (!root) return;
      if (!state.jobs.length) {
        root.innerHTML = '<div class="muted">Saved jobs will appear here.</div>';
        return;
      }
      root.innerHTML = state.jobs.slice(0, 3).map(job => {
        const detailUrl = '/jobs/' + encodeURIComponent(job.id);
        return '<div class="job">'
          + '<div class="job-head">'
          + '<div>'
          + '<div class="job-title">' + escapeHtml(job.name || job.instruction.slice(0, 80) || 'Untitled job') + '</div>'
          + '<div class="muted mono">' + escapeHtml(job.id) + '</div>'
          + '</div>'
          + '<div class="actions">'
          + '<span class="tag">' + escapeHtml(job.status) + '</span>'
          + '<button data-mini-select="' + escapeHtml(job.id) + '">Open</button>'
          + '<button data-mini-copy="' + escapeHtml(detailUrl) + '">Copy</button>'
          + '</div>'
          + '</div>'
          + '</div>';
      }).join('');
      root.querySelectorAll('[data-mini-select]').forEach(btn => {
        btn.addEventListener('click', () => selectJob(btn.getAttribute('data-mini-select')));
      });
      root.querySelectorAll('[data-mini-copy]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const copied = await copyText(baseUrl + btn.getAttribute('data-mini-copy'));
          setStatus($('globalStatus'), copied ? 'Endpoint copied.' : 'Copy failed.');
        });
      });
    };
    const renderExecutionHistory = (job) => {
      const executions = Array.isArray(job.executions) ? job.executions : [];
      if (!executions.length) return '<div class="muted">No execution history yet.</div>';
      return executions.slice().reverse().map(exec => {
        const output = exec.output ? '<pre>' + escapeHtml(JSON.stringify(exec.output, null, 2)) + '</pre>' : '<div class="muted">No output.</div>';
        const error = exec.error ? '<div class="tag bad" style="margin-top:8px">Error: ' + escapeHtml(exec.error) + '</div>' : '';
        const summary = exec.resultSummary ? '<div class="tag" style="margin-top:8px">Summary: ' + escapeHtml(exec.resultSummary) + '</div>' : '';
        const logs = Array.isArray(exec.logs) && exec.logs.length
          ? '<pre>' + escapeHtml(exec.logs.map(l => '[' + l.ts + '] ' + l.level.toUpperCase() + ' ' + l.message + (l.data ? ' ' + JSON.stringify(l.data) : '')).join('\\n\\n')) + '</pre>'
          : '<div class="muted">No logs for this execution.</div>';
        return '<div class="history-item">'
          + '<div class="history-head">'
          + '<div>'
          + '<div class="history-title">Attempt ' + escapeHtml(String(exec.attempt || '-')) + '</div>'
          + '<div class="tiny">' + escapeHtml(exec.startedAt || '-') + ' → ' + escapeHtml(exec.finishedAt || '-') + '</div>'
          + '</div>'
          + '<div class="chip-row">'
          + '<span class="tag">' + escapeHtml(exec.status || '-') + '</span>'
          + '<span class="tag">duration ' + escapeHtml(String(exec.durationMs ?? '-')) + ' ms</span>'
          + '</div>'
          + '</div>'
          + summary
          + error
          + '<div class="history-grid" style="margin-top:10px">'
          + '<div class="history-block">'
          + '<div class="tiny">Final Response</div>'
          + output
          + '</div>'
          + '<div class="history-block">'
          + '<div class="tiny">Execution Logs</div>'
          + logs
          + '</div>'
          + '</div>'
          + '</div>';
      }).join('');
    };
    const fetchJobs = async () => {
      const res = await fetch('/jobs', { headers: headers() });
      if (!res.ok) throw new Error('Failed to load jobs: ' + res.status);
      const data = await res.json();
      state.jobs = Array.isArray(data.items) ? data.items : [];
      renderJobs();
      renderRecentJobs();
      updateStats();
    };
    const actionJob = async (id, action) => {
      const wait = action === 'run' ? 'wait=false' : '';
      const url = '/jobs/' + encodeURIComponent(id) + '/' + action + (wait ? '?' + wait : '');
      const res = await fetch(url, { method: 'POST', headers: headers() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('Request failed: ' + res.status));
      setStatus($('jobStatus'), 'Job updated: ' + (data.job && data.job.status ? data.job.status : action), data.job && data.job.status === 'succeeded' ? 'good' : 'tiny');
      await fetchJobs();
      if (state.selectedJobId === id) await refreshSelectedJob();
    };
    const refreshSelectedJob = async () => {
      if (!state.selectedJobId) {
        $('selectedJobDetail').textContent = 'No job selected.';
        $('selectedJobLogs').textContent = 'No logs yet.';
        $('selectedJobOutput').textContent = 'No output yet.';
        $('selectedJobOutputDetails').open = false;
        $('selectedJobHistory').innerHTML = '<div class="muted">No execution history yet.</div>';
        return;
      }
      const res = await fetch('/jobs/' + encodeURIComponent(state.selectedJobId) + '?view=record', { headers: headers() });
      if (!res.ok) {
        setStatus($('detailStatus'), 'Failed to load selected job (' + res.status + ')', 'bad');
        return;
      }
      const data = await res.json();
      const job = data.job || {};
      setView('history');
      $('selectedJobDetail').textContent = JSON.stringify({
        id: job.id,
        name: job.name,
        status: job.status,
        instruction: job.instruction,
        endpoint: baseUrl + '/jobs/' + job.id,
        recordEndpoint: baseUrl + '/jobs/' + job.id + '?view=record',
        runEndpoint: baseUrl + '/jobs/' + job.id + '/run',
        logsEndpoint: baseUrl + '/jobs/' + job.id + '/logs',
        runCurl: runCurlForJob(job),
        autoRun: job.autoRun,
        attempts: job.attempts,
        runs: Array.isArray(job.executions) ? job.executions.length : 0,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        resultSummary: job.resultSummary,
        error: job.error,
      }, null, 2);
      $('selectedJobLogs').textContent = (job.logs && job.logs.length)
        ? job.logs.map(l => '[' + l.ts + '] ' + l.level.toUpperCase() + ' ' + l.message + (l.data ? ' ' + JSON.stringify(l.data) : '')).join('\\n\\n')
        : 'No logs yet.';
      $('selectedJobOutput').textContent = job.output ? JSON.stringify(job.output, null, 2) : 'No output yet.';
      $('selectedJobRequestExample').textContent = 'Run curl:\\n\\n' + runCurlForJob(job);
      $('selectedJobResponseExample').textContent = prettyJson(responseExampleForJob(job), 'No response example yet.');
      $('selectedJobOutputDetails').open = false;
      $('selectedJobHistory').innerHTML = renderExecutionHistory(job);
      $('editSelectedJob').onclick = () => fillFormFromJob(job);
    };
    const submitJob = async (ev) => {
      ev.preventDefault();
      const outputExample = safeJson($('outputExample').value, null);
      const outputSchema = safeJson($('outputSchema').value, null);
      const body = {
        name: $('jobName').value || undefined,
        instruction: $('instruction').value,
        outputSchema: outputSchema || undefined,
        outputExample: outputExample,
        examples: safeJson($('examples').value, []),
        requiredFields: $('requiredFields').value.split(',').map(s => s.trim()).filter(Boolean),
        strict: $('strict').checked,
        timeoutMs: Number($('timeoutMs').value || 0) || undefined,
        metadata: $('metadata').value ? safeJson($('metadata').value, undefined) : undefined,
        idempotencyKey: $('idempotencyKey').value || undefined,
      };
      const isEdit = !!state.editingJobId;
      const url = isEdit ? '/jobs/' + encodeURIComponent(state.editingJobId) : '/jobs?wait=false';
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus($('jobStatus'), data.error || ('Failed to create job (' + res.status + ')'), 'bad');
        return;
      }
      const job = data.job || {};
      setStatus($('jobStatus'), (isEdit ? 'Updated job ' : 'Created job ') + (job.id || '') + ' at /jobs/' + (job.id || ''), 'good');
      if (isEdit) setFormMode(null);
      await fetchJobs();
    };
    $('jobForm').addEventListener('submit', submitJob);
    document.querySelectorAll('[data-nav]').forEach(btn => {
      btn.addEventListener('click', () => setView(btn.getAttribute('data-nav') || 'dashboard'));
    });
    $('goJobs').addEventListener('click', () => setView('jobs'));
    $('backToDashboard').addEventListener('click', () => setView('dashboard'));
    document.querySelectorAll('[data-preset]').forEach(btn => {
      btn.addEventListener('click', () => applyPreset(btn.getAttribute('data-preset')));
    });
    $('clearPreset').addEventListener('click', () => {
      $('jobName').value = '';
      $('instruction').value = '';
      $('outputExample').value = JSON.stringify({
        username: 'LuizDavi',
        password: 'LuizDavi23',
      }, null, 2);
      $('outputSchema').value = '';
      $('examples').value = '[]';
      $('requiredFields').value = '';
      $('timeoutMs').value = String(config.jobTimeoutMs);
      $('idempotencyKey').value = '';
      $('metadata').value = '';
      $('strict').checked = false;
      setFormMode(null);
      updatePreview();
      setStatus($('jobStatus'), 'Preset cleared.');
    });
    $('refreshJobs').addEventListener('click', fetchJobs);
    $('pollToggle').addEventListener('click', () => {
      state.polling = !state.polling;
      $('pollToggle').textContent = 'Auto refresh: ' + (state.polling ? 'on' : 'off');
    });
    $('clearJobs').addEventListener('click', () => { state.jobs = []; renderJobs(); });
    $('manualRun').addEventListener('click', () => {
      if (!state.selectedJobId) return;
      actionJob(state.selectedJobId, 'run');
    });
    $('copyRunEndpoint').addEventListener('click', async () => {
      if (!state.selectedJobId) return;
      const job = state.jobs.find(j => j.id === state.selectedJobId);
      if (!job) return;
      const ok = await copyText(runCurlForJob(job));
      setStatus($('detailStatus'), ok ? 'Run curl copied.' : 'Copy failed.');
    });
    $('copySelectedRunCurl').addEventListener('click', async () => {
      if (!state.selectedJobId) return;
      const job = state.jobs.find(j => j.id === state.selectedJobId);
      if (!job) return;
      const ok = await copyText(runCurlForJob(job));
      setStatus($('detailStatus'), ok ? 'Run curl copied.' : 'Copy failed.');
    });
    $('copySelectedResponseExample').addEventListener('click', async () => {
      if (!state.selectedJobId) return;
      const job = state.jobs.find(j => j.id === state.selectedJobId);
      if (!job) return;
      const ok = await copyText(prettyJson(responseExampleForJob(job)));
      setStatus($('detailStatus'), ok ? 'Response example copied.' : 'Copy failed.');
    });
    $('copyLogsEndpoint').addEventListener('click', async () => {
      if (!state.selectedJobId) return;
      await copyText(baseUrl + '/jobs/' + state.selectedJobId + '/logs');
      setStatus($('detailStatus'), 'Logs endpoint copied.');
    });
    $('editSelectedJob').addEventListener('click', () => {
      const job = state.jobs.find(j => j.id === state.selectedJobId);
      if (!job) return;
      fillFormFromJob(job);
    });
    $('seedExample').addEventListener('click', () => {
      $('jobName').value = 'Headline scrape';
      $('instruction').value = 'Open Google News and collect the top three headlines.';
      $('outputSchema').value = JSON.stringify({
        headlines: [
          {
            title: 'Example headline',
            source: 'Example source',
          },
        ],
        done: true,
      }, null, 2);
      updatePreview();
    });
    $('copyCreateCurl').addEventListener('click', async () => {
      const curl = [
        'curl -X POST ' + JSON.stringify(baseUrl + '/jobs'),
        '-H "content-type: application/json"',
        $('apiKey').value.trim() ? '-H "authorization: ' + ($('apiKey').value.trim().startsWith('Bearer ') ? $('apiKey').value.trim() : 'Bearer ' + $('apiKey').value.trim()) + '"' : '',
        '-d ' + JSON.stringify(JSON.stringify({
          name: $('jobName').value || 'example-job',
          instruction: $('instruction').value || 'open google.com and collect data',
          outputExample: safeJson($('outputExample').value, null),
          strict: $('strict').checked,
        }))
      ].filter(Boolean).join(' ');
      const ok = await copyText(curl);
      setStatus($('globalStatus'), ok ? 'cURL copied.' : curl);
    });
    ['apiKey','jobName','instruction','outputExample','outputSchema','examples','requiredFields','timeoutMs','strict','metadata','idempotencyKey'].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener('input', updatePreview);
      if (el && el.tagName === 'INPUT') el.addEventListener('change', updatePreview);
    });
    updatePreview();
    setView('dashboard');
    fetchJobs().catch(err => setStatus($('globalStatus'), err.message, 'bad'));
    setInterval(() => { if (state.polling) fetchJobs().catch(() => {}); }, 4000);
  </script>
</body>
</html>`;
}

function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inferOutputSchema(schemaOrExample: unknown, example?: unknown): JsonSchemaObject | null {
  if (schemaOrExample && typeof schemaOrExample === 'object' && looksLikeSchema(schemaOrExample as JsonSchemaObject)) {
    return schemaOrExample as JsonSchemaObject;
  }
  const candidate = schemaOrExample ?? example;
  if (candidate == null) return null;
  return inferSchema(candidate);
}

function looksLikeSchema(value: JsonSchemaObject): boolean {
  return Boolean(
    value.type ||
    value.properties ||
    value.items ||
    value.oneOf ||
    value.anyOf ||
    value.allOf ||
    value.enum ||
    value.const ||
    value.additionalProperties !== undefined
  );
}

function inferSchema(value: unknown): JsonSchemaObject {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    if (value.length === 0) return { type: 'array', items: {} };
    return { type: 'array', items: inferSchema(value[0]) };
  }
  switch (typeof value) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object': {
      const obj = value as Record<string, unknown>;
      const properties: Record<string, JsonSchemaObject> = {};
      for (const [key, val] of Object.entries(obj)) properties[key] = inferSchema(val);
      return {
        type: 'object',
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      };
    }
    default:
      return {};
  }
}

import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { BrowserDriver, JobLogEntry } from '../types';

type RpcRequest = { jsonrpc: '2.0'; id: number; method: string; params?: unknown };
type RpcResponse = { jsonrpc: '2.0'; id: number; result?: any; error?: { code: number; message: string; data?: unknown } };

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export class McpBrowserDriver implements BrowserDriver {
  readonly name = 'mcp-browser-driver';
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void }>();
  private nextId = 1;

  constructor(
    private command: string,
    private args: string[],
  ) {}

  async ensureReady(): Promise<void> {
    await this.ensureProcess();
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDefinition[]> {
    return this.withRestartRetry(async () => {
      await this.ensureProcess();
      const result = await this.request('tools/list', {}, 15000, signal);
      if (result && typeof result === 'object' && Array.isArray((result as any).tools)) {
        return (result as any).tools as McpToolDefinition[];
      }
      return [];
    });
  }

  async listPages(signal?: AbortSignal): Promise<number[]> {
    return this.withRestartRetry(async () => {
      await this.ensureProcess();
      const result = await this.request('list_pages', {}, 15000, signal);
      return extractPageIds(result);
    });
  }

  async closePage(pageId: number, signal?: AbortSignal): Promise<void> {
    await this.withRestartRetry(async () => {
      await this.ensureProcess();
      await this.request('close_page', { pageId }, 15000, signal);
    });
  }

  async callTool(name: string, args: unknown, timeoutMs = 30000, signal?: AbortSignal): Promise<any> {
    return this.withRestartRetry(async () => {
      await this.ensureProcess();
      const result = await this.request('tools/call', { name, arguments: args }, timeoutMs, signal);
      if (result && typeof result === 'object' && (result as any).isError) {
        const text = stringifyMcpContent((result as any).content);
        throw new Error(text || `Tool call failed: ${name}`);
      }
      return result;
    });
  }

  async runInstruction(): Promise<any> {
    throw new Error('Use the browser agent executor for MCP jobs');
  }

  async close(): Promise<void> {
    try { this.proc?.kill(); } catch {}
    this.proc = null;
    this.pending.clear();
  }

  private async withRestartRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      const message = String(err?.message || err);
      if (!this.shouldRestartFor(message)) throw err;
      await this.restartProcess().catch(() => {});
      return await fn();
    }
  }

  private shouldRestartFor(message: string): boolean {
    return /worker exited|worker is not running|request canceled|initialize/i.test(message);
  }

  private async restartProcess(): Promise<void> {
    await this.close().catch(() => {});
    await this.ensureProcess();
  }

  private async ensureProcess(): Promise<void> {
    if (this.proc) return;
    if (!this.command) throw new Error('BROWSER_MCP_COMMAND is not set');
    const useShell = process.platform === 'win32';
    let child: ChildProcessWithoutNullStreams;
    try {
      const nodeBinDir = path.dirname(process.execPath);
      const env = {
        ...process.env,
        PATH: `${nodeBinDir}${path.delimiter}${process.env.PATH || ''}`,
      };
      if (process.platform === 'win32') {
        (env as NodeJS.ProcessEnv).Path = env.PATH;
      }
      child = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: useShell,
        windowsHide: true,
        env,
      });
    } catch (err: any) {
      throw new Error(`Failed to start browser MCP worker: ${err?.message || err}`);
    }
    this.proc = child;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', line => {
      try {
        const msg = JSON.parse(line) as RpcResponse;
        if (typeof msg.id !== 'number') return;
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message));
        else pending.resolve(msg.result);
      } catch {}
    });
    child.stderr.on('data', chunk => {
      process.stderr.write(`[browser-mcp] ${chunk}`);
    });
    child.once('error', err => {
      this.proc = null;
      for (const [, pending] of this.pending) pending.reject(new Error(`Browser MCP worker error: ${err.message}`));
      this.pending.clear();
    });
    child.on('exit', () => {
      this.proc = null;
      for (const [, pending] of this.pending) pending.reject(new Error('Browser MCP worker exited'));
      this.pending.clear();
    });
    await this.request('initialize', { clientName: 'agent-browser-api', version: '0.1.0' }, 5000);
  }

  private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    const child = this.proc;
    if (!child) return Promise.reject(new Error('Browser MCP worker is not running'));
    const id = this.nextId++;
    const payload: RpcRequest = { jsonrpc: '2.0', id, method, params };
    const timer = setTimeout(() => {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        pending.reject(new Error(`Browser MCP request timed out: ${method}`));
      }
    }, timeoutMs);

    return new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Browser MCP request canceled'));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          reject(err);
        },
      });
      child.stdin.write(JSON.stringify(payload) + '\n');
    });
  }
}

function stringifyMcpContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content.map(item => {
    if (!item || typeof item !== 'object') return String(item);
    const value = item as { type?: string; text?: string; data?: unknown };
    if (typeof value.text === 'string') return value.text;
    if (value.data != null) return typeof value.data === 'string' ? value.data : JSON.stringify(value.data);
    return value.type ? `[${value.type}]` : JSON.stringify(item);
  }).join('\n');
}

function extractPageIds(result: unknown): number[] {
  const text = stringifyMcpContent((result as any)?.content ?? result);
  const ids = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+):\s*/);
    if (match) ids.add(Number(match[1]));
  }
  return Array.from(ids).filter(id => Number.isFinite(id)).sort((a, b) => a - b);
}

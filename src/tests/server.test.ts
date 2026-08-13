import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ApiServer } from '../api/server';

test('health and auth behavior', async () => {
  const server = new ApiServer(createTestConfig());
  const srv = await server.start();
  try {
    const port = getPort(srv);
    const health = await requestJson(port, 'GET', '/health');
    assert.equal(health.status, 200);
    const body = health.body as { ok: boolean };
    assert.equal(body.ok, true);

    const create = await requestJson(port, 'POST', '/jobs?wait=false', {
      instruction: 'open google.com',
      autoRun: false,
      outputSchema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] },
    });
    assert.equal(create.status, 201);
    const created = create.body as { job: { status: string } };
    assert.equal(created.job.status, 'queued');
  } finally {
    await server.stop();
  }
});

test('delete job removes it from the store', async () => {
  const server = new ApiServer(createTestConfig());
  const srv = await server.start();
  try {
    const port = getPort(srv);

    const create = await requestJson(port, 'POST', '/jobs?wait=false', {
      instruction: 'delete me',
      autoRun: false,
      outputSchema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] },
    });
    assert.equal(create.status, 201);
    const created = create.body as { job: { id: string } };
    assert.ok(created.job.id);

    const deleted = await requestJson(port, 'DELETE', `/jobs/${created.job.id}`);
    assert.equal(deleted.status, 200);
    const deletedBody = deleted.body as { deleted: boolean; jobId: string };
    assert.equal(deletedBody.deleted, true);
    assert.equal(deletedBody.jobId, created.job.id);

    const list = await requestJson(port, 'GET', '/jobs');
    assert.equal(list.status, 200);
    const items = list.body as { items: Array<{ id: string }> };
    assert.equal(items.items.some(item => item.id === created.job.id), false);
  } finally {
    await server.stop();
  }
});

function createTestConfig() {
  return {
    host: '127.0.0.1',
    port: 0,
    apiKey: '',
    deepseekApiKey: '',
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-test-')),
    jobTimeoutMs: 1000,
    maxConcurrentJobs: 1,
    maxJobInstructionChars: 12000,
    browserMcpCommand: '',
    browserMcpArgs: [],
  };
}

function getPort(srv: http.Server): number {
  const address = srv.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

function requestJson(
  port: number,
  method: 'GET' | 'POST' | 'DELETE',
  pathName: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathName,
      headers: body ? { 'content-type': 'application/json', connection: 'close' } : { connection: 'close' },
      agent: false,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8') || '{}';
          resolve({ status: res.statusCode || 0, body: JSON.parse(raw) });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

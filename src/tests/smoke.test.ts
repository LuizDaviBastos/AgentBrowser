import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileJobStore } from '../storage/jobStore';

test('job store persists jobs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-'));
  const store = new FileJobStore(dir);
  store.upsert({
    id: 'job-1',
    instruction: 'open google.com',
    outputSchema: { type: 'object' },
    status: 'queued',
    createdAt: new Date().toISOString(),
    attempts: 0,
    autoRun: false,
    logs: [],
    executions: [],
  });
  const store2 = new FileJobStore(dir);
  assert.equal(store2.get('job-1')?.instruction, 'open google.com');
});

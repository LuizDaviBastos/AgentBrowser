import fs from 'node:fs';
import path from 'node:path';
import { JobRecord } from '../types';

export interface JobStore {
  get(id: string): JobRecord | undefined;
  list(): JobRecord[];
  upsert(job: JobRecord): void;
  remove(id: string): void;
  findByIdempotencyKey(key: string): JobRecord | undefined;
  waitersFor(id: string): Set<() => void>;
  onComplete(id: string): void;
}

export class FileJobStore implements JobStore {
  private jobs = new Map<string, JobRecord>();
  private waiters = new Map<string, Set<() => void>>();
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'jobs.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.load();
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  list(): JobRecord[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  upsert(job: JobRecord): void {
    this.jobs.set(job.id, clone(job));
    this.persist();
  }

  remove(id: string): void {
    this.jobs.delete(id);
    this.persist();
  }

  findByIdempotencyKey(key: string): JobRecord | undefined {
    for (const job of this.jobs.values()) {
      if (job.idempotencyKey === key) return clone(job);
    }
    return undefined;
  }

  waitersFor(id: string): Set<() => void> {
    let set = this.waiters.get(id);
    if (!set) {
      set = new Set();
      this.waiters.set(id, set);
    }
    return set;
  }

  onComplete(id: string): void {
    this.emit(id);
  }

  private emit(id: string): void {
    const set = this.waiters.get(id);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(); } catch {}
    }
    set.clear();
    this.waiters.delete(id);
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const item of parsed) {
        if (item && typeof item.id === 'string') this.jobs.set(item.id, normalizeJob(item as JobRecord));
      }
    } catch {}
  }

  private persist(): void {
    const tmp = `${this.filePath}.tmp`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(Array.from(this.jobs.values()), null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function normalizeJob(job: JobRecord): JobRecord {
  return {
    ...job,
    logs: Array.isArray(job.logs) ? job.logs : [],
    executions: Array.isArray(job.executions) ? job.executions : [],
  };
}

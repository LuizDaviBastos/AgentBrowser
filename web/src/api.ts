import type { JobRecord, JsonSchemaObject } from './types';

export interface JobCreateInput {
  name?: string;
  instruction: string;
  outputSchema?: JsonSchemaObject;
  outputExample?: unknown;
  examples?: unknown[];
  requiredFields?: string[];
  strict?: boolean;
  autoRun?: boolean;
  timeoutMs?: number;
  priority?: number;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export async function fetchJobs(): Promise<JobRecord[]> {
  const res = await fetch('/jobs');
  if (!res.ok) throw new Error(`Failed to load jobs (${res.status})`);
  const data = await res.json();
  return Array.isArray(data.items) ? data.items : [];
}

export async function fetchJob(id: string): Promise<JobRecord> {
  const res = await fetch(`/jobs/${encodeURIComponent(id)}?view=record`);
  if (!res.ok) throw new Error(`Failed to load job (${res.status})`);
  const data = await res.json();
  return data.job;
}

export async function createJob(input: JobCreateInput): Promise<JobRecord> {
  const res = await fetch('/jobs?wait=false', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Failed to create job (${res.status})`);
  return data.job;
}

export async function updateJob(id: string, input: JobCreateInput): Promise<JobRecord> {
  const res = await fetch(`/jobs/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Failed to update job (${res.status})`);
  return data.job;
}

export async function deleteJob(id: string): Promise<void> {
  const res = await fetch(`/jobs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Failed to delete job (${res.status})`);
}

export async function runJob(id: string): Promise<JobRecord | undefined> {
  const res = await fetch(`/jobs/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Failed to run job (${res.status})`);
  return data.job;
}

export async function cancelJob(id: string): Promise<JobRecord> {
  const res = await fetch(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Failed to cancel job (${res.status})`);
  return data.job;
}

export async function retryJob(id: string): Promise<JobRecord> {
  const res = await fetch(`/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Failed to retry job (${res.status})`);
  return data.job;
}

export async function waitJob(id: string): Promise<JobRecord | undefined> {
  const res = await fetch(`/jobs/${encodeURIComponent(id)}/wait`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Failed to wait for job (${res.status})`);
  return data.job;
}

export async function fetchOpenApi(): Promise<unknown> {
  const res = await fetch('/openapi.json');
  if (!res.ok) throw new Error(`Failed to load OpenAPI (${res.status})`);
  return res.json();
}

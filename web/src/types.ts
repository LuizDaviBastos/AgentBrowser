export type JobStatus = 'queued' | 'running' | 'waiting_input' | 'succeeded' | 'failed' | 'canceled' | 'timed_out';

export interface JsonSchemaObject {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaObject;
  items?: JsonSchemaObject | JsonSchemaObject[];
  enum?: unknown[];
  const?: unknown;
  oneOf?: JsonSchemaObject[];
  anyOf?: JsonSchemaObject[];
  allOf?: JsonSchemaObject[];
  description?: string;
  title?: string;
  format?: string;
}

export interface JobLogEntry {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
}

export interface JobExecutionRecord {
  attempt: number;
  status: JobStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  output?: unknown;
  error?: string;
  resultSummary?: string;
  logs: JobLogEntry[];
}

export interface JobRecord {
  id: string;
  name?: string;
  instruction: string;
  outputSchema: JsonSchemaObject;
  outputExample?: unknown;
  examples?: unknown[];
  requiredFields?: string[];
  strict?: boolean;
  autoRun: boolean;
  timeoutMs?: number;
  priority?: number;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  attempts: number;
  output?: unknown;
  error?: string;
  logs: JobLogEntry[];
  executions: JobExecutionRecord[];
  resultSummary?: string;
  durationMs?: number;
}

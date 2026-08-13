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

export interface JobRequest {
  name?: string;
  instruction: string;
  outputSchema: JsonSchemaObject;
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

export interface JobRecord extends JobRequest {
  id: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  attempts: number;
  autoRun: boolean;
  output?: unknown;
  error?: string;
  logs: JobLogEntry[];
  executions: JobExecutionRecord[];
  resultSummary?: string;
  browserSessionId?: string;
  durationMs?: number;
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

export interface JobLogEntry {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
}

export interface JobListResponse {
  items: JobRecord[];
}

export interface CreateJobResponse {
  job: JobRecord;
  wait?: boolean;
}

export interface BrowserStepResult {
  summary: string;
  output: unknown;
  artifacts?: Array<{ kind: string; value: string }>;
}

export interface BrowserContextSnapshot {
  url?: string;
  title?: string;
  pageText?: string;
  screenshot?: string;
}

export interface BrowserDriver {
  readonly name: string;
  ensureReady(): Promise<void>;
  runInstruction(input: {
    jobId: string;
    instruction: string;
    outputSchema: JsonSchemaObject;
    examples?: unknown[];
    requiredFields?: string[];
    strict?: boolean;
    timeoutMs: number;
    context?: BrowserContextSnapshot;
    log: (level: JobLogEntry['level'], message: string, data?: unknown) => void;
    signal: AbortSignal;
  }): Promise<BrowserStepResult>;
  close(): Promise<void>;
}

import fs from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  apiKey: string;
  deepseekApiKey: string;
  dataDir: string;
  jobTimeoutMs: number;
  maxConcurrentJobs: number;
  maxJobInstructionChars: number;
  browserMcpCommand: string;
  browserMcpArgs: string[];
}

loadDotEnv();

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): AppConfig {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), '.data'));
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    host: process.env.HOST || '127.0.0.1',
    port: parseIntEnv('PORT', 8787),
    apiKey: process.env.API_KEY || '',
    deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
    dataDir,
    jobTimeoutMs: parseIntEnv('JOB_TIMEOUT_MS', 300000),
    maxConcurrentJobs: Math.max(1, parseIntEnv('MAX_CONCURRENT_JOBS', 1)),
    maxJobInstructionChars: Math.max(1000, parseIntEnv('MAX_JOB_INSTRUCTION_CHARS', 12000)),
    browserMcpCommand: process.env.BROWSER_MCP_COMMAND || '',
    browserMcpArgs: splitArgs(process.env.BROWSER_MCP_ARGS || ''),
  };
}

function splitArgs(raw: string): string[] {
  const text = raw.trim();
  if (!text) return [];
  const args: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && i + 1 < text.length) {
        current += text[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) { args.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) args.push(current);
  return args;
}

function loadDotEnv(): void {
  const file = path.join(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (!key || process.env[key] != null) continue;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {}
}

import { BrowserStepResult, JobLogEntry, JobRecord, JsonSchemaObject } from '../types';
import { validateSchema } from '../validation/jsonSchema';
import { McpBrowserDriver, McpToolDefinition } from '../browser/mcpBrowserDriver';

type DeepSeekMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
};

type DeepSeekTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: unknown;
  };
};

export async function runBrowserAgent(input: {
  job: JobRecord;
  driver: McpBrowserDriver;
  deepseekApiKey: string;
  signal: AbortSignal;
  log: (level: JobLogEntry['level'], message: string, data?: unknown) => void;
}): Promise<BrowserStepResult> {
  const { job, driver, deepseekApiKey, signal, log } = input;
  if (!deepseekApiKey) throw new Error('DEEPSEEK_API_KEY is required for browser jobs');
  const navigationTimeoutMs = Math.min(Math.max(job.timeoutMs || 300000, 60000), 180000);

  const tools = await driver.listTools(signal);
  if (!tools.length) throw new Error('The browser MCP server exposed no tools');

  log('info', 'browser tools loaded', { count: tools.length });
  const baselinePages = await driver.listPages(signal).catch(() => []);

  const messages: DeepSeekMessage[] = [
    {
      role: 'system',
      content: [
        'You are an automation agent controlling a live Chrome browser through MCP tools.',
        'Complete the task step by step.',
        'Use the available browser tools when needed.',
        'Return only a final JSON object that matches the requested schema.',
        `Output schema: ${JSON.stringify(job.outputSchema)}`,
        job.requiredFields?.length ? `Required fields: ${job.requiredFields.join(', ')}` : '',
        job.strict ? 'Strict mode is enabled. Follow the schema exactly.' : '',
        job.examples?.length ? `Examples: ${JSON.stringify(job.examples)}` : '',
      ].filter(Boolean).join('\n'),
    },
    {
      role: 'user',
      content: [
        `Job id: ${job.id}`,
        `Instruction: ${job.instruction}`,
        'If you need to interact with the page, use the tools.',
        'When you are finished, respond only with valid JSON.',
      ].join('\n'),
    },
  ];

  const toolDefs: DeepSeekTool[] = tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeToolSchema(tool.inputSchema),
    },
  }));

  const maxTurns = 20;
  try {
    for (let turn = 0; turn < maxTurns && !signal.aborted; turn++) {
      log('info', 'agent turn start', { turn: turn + 1 });
      const assistant = await callDeepSeek({
        apiKey: deepseekApiKey,
        messages,
        tools: toolDefs,
        signal,
      });
      log('debug', 'agent response received', {
        turn: turn + 1,
        hasToolCalls: !!assistant.tool_calls?.length,
        contentPreview: (assistant.content || '').slice(0, 1000),
      });

      if (assistant.tool_calls?.length) {
        log('info', 'agent requested tools', { turn: turn + 1, count: assistant.tool_calls.length });
        messages.push({ role: 'assistant', content: assistant.content || '', tool_calls: assistant.tool_calls });
        for (const toolCall of assistant.tool_calls) {
          const toolName = toolCall.function.name;
          const rawArgs = toolCall.function.arguments || '{}';
          let args: unknown = {};
          try {
            args = rawArgs ? JSON.parse(rawArgs) : {};
          } catch {
            args = rawArgs;
          }
          log('info', `tool call ${toolName}`, { arguments: args });
          const preparedArgs = prepareToolArgs(toolName, args, navigationTimeoutMs);
          const result = await callToolWithRetry(driver, toolName, preparedArgs, job.timeoutMs || 300000, signal, log);
          const toolText = stringifyResult(result);
          log('debug', `tool result ${toolName}`, { preview: toolText.slice(0, 4000) });
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolText,
          });
        }
        continue;
      }

      const text = assistant.content || '';
      const output = extractJson(text);
      if (output == null) {
        log('warn', 'agent response was not valid JSON', { turn: turn + 1, contentPreview: text.slice(0, 1000) });
        messages.push({
          role: 'user',
          content: 'Your previous response was not valid JSON. Return only a JSON object that matches the schema.',
        });
        continue;
      }

      const check = validateSchema(job.outputSchema, output, !!job.strict, job.requiredFields);
      if (!check.valid) {
        log('warn', 'agent response failed schema validation', { turn: turn + 1, errors: check.errors });
        messages.push({
          role: 'user',
          content: `Your JSON did not match the schema: ${(check.errors || []).join('; ')}. Return a corrected JSON object only.`,
        });
        continue;
      }

      log('info', 'agent completed', { turn: turn + 1 });
      return {
        summary: 'Browser job completed',
        output,
        artifacts: [],
      };
    }
    throw new Error('Browser agent did not produce a valid JSON result');
  } finally {
    await closeNewPages(driver, baselinePages, signal, log);
  }
}

async function callDeepSeek(input: {
  apiKey: string;
  messages: DeepSeekMessage[];
  tools: DeepSeekTool[];
  signal: AbortSignal;
}): Promise<{ content?: string; tool_calls?: DeepSeekMessage['tool_calls'] }> {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: input.messages,
      tools: input.tools,
      tool_choice: 'auto',
      temperature: 0.2,
      stream: false,
    }),
    signal: input.signal,
  });

  if (!response.ok) {
    throw new Error(`DeepSeek API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as any;
  const message = data?.choices?.[0]?.message || {};
  return {
    content: typeof message.content === 'string' ? message.content : '',
    tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : undefined,
  };
}

function normalizeToolSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  return schema;
}

function stringifyResult(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {}
  }
  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i) || trimmed.match(/```\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }
  return null;
}

function prepareToolArgs(toolName: string, args: unknown, navigationTimeoutMs: number): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  if (toolName !== 'new_page' && toolName !== 'navigate_page' && toolName !== 'wait_for') return args;

  const current = args as Record<string, unknown>;
  const timeout = typeof current.timeout === 'number' && Number.isFinite(current.timeout) && current.timeout > 0
    ? current.timeout
    : navigationTimeoutMs;

  return {
    ...current,
    timeout,
  };
}

async function callToolWithRetry(
  driver: McpBrowserDriver,
  toolName: string,
  args: unknown,
  timeoutMs: number,
  signal: AbortSignal,
  log: (level: JobLogEntry['level'], message: string, data?: unknown) => void,
): Promise<any> {
  const maxAttempts = shouldRetryForTool(toolName) ? 3 : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        log('warn', `retrying tool ${toolName}`, { attempt, maxAttempts });
        await sleep(3000);
      }
      return await driver.callTool(toolName, args, timeoutMs, signal);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !shouldRetryInteractiveFailure(toolName, err)) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || `Tool call failed: ${toolName}`));
}

function shouldRetryForTool(toolName: string): boolean {
  return toolName === 'fill_form' || toolName === 'fill' || toolName === 'click' || toolName === 'press_key';
}

function shouldRetryInteractiveFailure(toolName: string, err: unknown): boolean {
  if (!shouldRetryForTool(toolName)) return false;
  const message = String((err as any)?.message || err || '');
  return /did not become interactive within the configured timeout|request timed out|request canceled|worker exited|worker is not running/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function closeNewPages(
  driver: McpBrowserDriver,
  baselinePages: number[],
  signal: AbortSignal,
  log: (level: JobLogEntry['level'], message: string, data?: unknown) => void,
): Promise<void> {
  const before = new Set(baselinePages);
  const after = await driver.listPages(signal).catch(() => []);
  const candidatePages = after.filter(pageId => !before.has(pageId)).sort((a, b) => b - a);
  for (const pageId of candidatePages) {
    try {
      log('info', 'closing browser page', { pageId });
      await driver.closePage(pageId, signal);
    } catch (err: any) {
      log('warn', 'failed to close browser page', { pageId, error: String(err?.message || err) });
    }
  }
}

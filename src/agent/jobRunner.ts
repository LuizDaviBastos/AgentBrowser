import { BrowserDriver, JobRecord } from '../types';
import { validateSchema } from '../validation/jsonSchema';
import { McpBrowserDriver } from '../browser/mcpBrowserDriver';
import { runBrowserAgent } from './browserAgent';

export async function executeJob(
  job: JobRecord,
  driver: BrowserDriver,
  signal: AbortSignal,
  log: JobRecord['logs'][number] extends infer T ? (level: any, message: string, data?: unknown) => void : never,
  options?: { deepseekApiKey?: string },
) {
  log('info', `job ${job.id} starting`, { driver: driver.name });
  const result = driver instanceof McpBrowserDriver
    ? await runBrowserAgent({
        job,
        driver,
        deepseekApiKey: options?.deepseekApiKey || '',
        signal,
        log,
      })
    : await driver.runInstruction({
        jobId: job.id,
        instruction: job.instruction,
        outputSchema: job.outputSchema,
        examples: job.examples,
        requiredFields: job.requiredFields,
        strict: !!job.strict,
        timeoutMs: job.timeoutMs || 300000,
        context: undefined,
        log,
        signal,
      });

  const check = validateSchema(job.outputSchema, result.output, !!job.strict, job.requiredFields);
  if (!check.valid) {
    const message = `Output did not match schema: ${(check.errors || []).join('; ')}`;
    throw new Error(message);
  }

  return {
    summary: result.summary,
    output: result.output,
    artifacts: result.artifacts || [],
  };
}

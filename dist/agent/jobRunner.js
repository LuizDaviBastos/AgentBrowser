"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeJob = executeJob;
const jsonSchema_1 = require("../validation/jsonSchema");
const mcpBrowserDriver_1 = require("../browser/mcpBrowserDriver");
const browserAgent_1 = require("./browserAgent");
async function executeJob(job, driver, signal, log, options) {
    log('info', `job ${job.id} starting`, { driver: driver.name });
    const result = driver instanceof mcpBrowserDriver_1.McpBrowserDriver
        ? await (0, browserAgent_1.runBrowserAgent)({
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
    const check = (0, jsonSchema_1.validateSchema)(job.outputSchema, result.output, !!job.strict, job.requiredFields);
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

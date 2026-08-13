"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.McpBrowserDriver = void 0;
const node_child_process_1 = require("node:child_process");
const node_readline_1 = __importDefault(require("node:readline"));
const node_path_1 = __importDefault(require("node:path"));
class McpBrowserDriver {
    command;
    args;
    name = 'mcp-browser-driver';
    proc = null;
    pending = new Map();
    nextId = 1;
    startupTimeoutMs = 120000;
    constructor(command, args) {
        this.command = command;
        this.args = args;
    }
    async ensureReady() {
        await this.ensureProcess();
    }
    async listTools(signal) {
        return this.withRestartRetry(async () => {
            await this.ensureProcess();
            const result = await this.request('tools/list', {}, 15000, signal);
            if (result && typeof result === 'object' && Array.isArray(result.tools)) {
                return result.tools;
            }
            return [];
        });
    }
    async listPages(signal) {
        return this.withRestartRetry(async () => {
            await this.ensureProcess();
            const result = await this.request('list_pages', {}, 15000, signal);
            return extractPageIds(result);
        });
    }
    async closePage(pageId, signal) {
        await this.withRestartRetry(async () => {
            await this.ensureProcess();
            await this.request('close_page', { pageId }, 15000, signal);
        });
    }
    async callTool(name, args, timeoutMs = 30000, signal) {
        return this.withRestartRetry(async () => {
            await this.ensureProcess();
            const result = await this.request('tools/call', { name, arguments: args }, timeoutMs, signal);
            if (result && typeof result === 'object' && result.isError) {
                const text = stringifyMcpContent(result.content);
                throw new Error(text || `Tool call failed: ${name}`);
            }
            return result;
        });
    }
    async runInstruction() {
        throw new Error('Use the browser agent executor for MCP jobs');
    }
    async close() {
        try {
            this.proc?.kill();
        }
        catch { }
        this.proc = null;
        this.pending.clear();
    }
    async withRestartRetry(fn) {
        try {
            return await fn();
        }
        catch (err) {
            const message = String(err?.message || err);
            if (!this.shouldRestartFor(message))
                throw err;
            await this.restartProcess().catch(() => { });
            return await fn();
        }
    }
    shouldRestartFor(message) {
        return /worker exited|worker is not running|request canceled|initialize/i.test(message);
    }
    async restartProcess() {
        await this.close().catch(() => { });
        await this.ensureProcess();
    }
    async ensureProcess() {
        if (this.proc)
            return;
        if (!this.command)
            throw new Error('BROWSER_MCP_COMMAND is not set');
        const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.command);
        let child;
        try {
            const nodeBinDir = node_path_1.default.dirname(process.execPath);
            const env = {
                ...process.env,
                PATH: `${nodeBinDir}${node_path_1.default.delimiter}${process.env.PATH || ''}`,
            };
            if (process.platform === 'win32') {
                env.Path = env.PATH;
            }
            child = (0, node_child_process_1.spawn)(this.command, this.args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: useShell,
                windowsHide: true,
                env,
            });
        }
        catch (err) {
            throw new Error(`Failed to start browser MCP worker: ${err?.message || err}`);
        }
        this.proc = child;
        const rl = node_readline_1.default.createInterface({ input: child.stdout });
        rl.on('line', line => {
            try {
                const msg = JSON.parse(line);
                if (typeof msg.id !== 'number')
                    return;
                const pending = this.pending.get(msg.id);
                if (!pending)
                    return;
                this.pending.delete(msg.id);
                if (msg.error)
                    pending.reject(new Error(msg.error.message));
                else
                    pending.resolve(msg.result);
            }
            catch { }
        });
        child.stderr.on('data', chunk => {
            process.stderr.write(`[browser-mcp] ${chunk}`);
        });
        child.once('error', err => {
            this.proc = null;
            for (const [, pending] of this.pending)
                pending.reject(new Error(`Browser MCP worker error: ${err.message}`));
            this.pending.clear();
        });
        child.on('exit', () => {
            this.proc = null;
            for (const [, pending] of this.pending)
                pending.reject(new Error('Browser MCP worker exited'));
            this.pending.clear();
        });
        await this.request('initialize', {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: {
                name: 'agent-browser-api',
                version: '0.1.0',
            },
        }, this.startupTimeoutMs);
        this.notify('notifications/initialized', {});
    }
    request(method, params, timeoutMs, signal) {
        const child = this.proc;
        if (!child)
            return Promise.reject(new Error('Browser MCP worker is not running'));
        const id = this.nextId++;
        const payload = { jsonrpc: '2.0', id, method, params };
        const timer = setTimeout(() => {
            const pending = this.pending.get(id);
            if (pending) {
                this.pending.delete(id);
                pending.reject(new Error(`Browser MCP request timed out: ${method}`));
            }
        }, timeoutMs);
        return new Promise((resolve, reject) => {
            const abort = () => {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new Error('Browser MCP request canceled'));
            };
            if (signal?.aborted)
                return abort();
            signal?.addEventListener('abort', abort, { once: true });
            this.pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', abort);
                    resolve(value);
                },
                reject: (err) => {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', abort);
                    reject(err);
                },
            });
            child.stdin.write(JSON.stringify(payload) + '\n');
        });
    }
    notify(method, params) {
        const child = this.proc;
        if (!child)
            return;
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }
}
exports.McpBrowserDriver = McpBrowserDriver;
function stringifyMcpContent(content) {
    if (!Array.isArray(content))
        return typeof content === 'string' ? content : '';
    return content.map(item => {
        if (!item || typeof item !== 'object')
            return String(item);
        const value = item;
        if (typeof value.text === 'string')
            return value.text;
        if (value.data != null)
            return typeof value.data === 'string' ? value.data : JSON.stringify(value.data);
        return value.type ? `[${value.type}]` : JSON.stringify(item);
    }).join('\n');
}
function extractPageIds(result) {
    const text = stringifyMcpContent(result?.content ?? result);
    const ids = new Set();
    for (const line of text.split(/\r?\n/)) {
        const match = line.trim().match(/^(\d+):\s*/);
        if (match)
            ids.add(Number(match[1]));
    }
    return Array.from(ids).filter(id => Number.isFinite(id)).sort((a, b) => a - b);
}

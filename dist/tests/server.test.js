"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_http_1 = __importDefault(require("node:http"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const server_1 = require("../api/server");
(0, node_test_1.default)('health and auth behavior', async () => {
    const server = new server_1.ApiServer(createTestConfig());
    const srv = await server.start();
    try {
        const port = getPort(srv);
        const health = await requestJson(port, 'GET', '/health');
        strict_1.default.equal(health.status, 200);
        const body = health.body;
        strict_1.default.equal(body.ok, true);
        const create = await requestJson(port, 'POST', '/jobs?wait=false', {
            instruction: 'open google.com',
            autoRun: false,
            outputSchema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] },
        });
        strict_1.default.equal(create.status, 201);
        const created = create.body;
        strict_1.default.equal(created.job.status, 'queued');
    }
    finally {
        await server.stop();
    }
});
(0, node_test_1.default)('delete job removes it from the store', async () => {
    const server = new server_1.ApiServer(createTestConfig());
    const srv = await server.start();
    try {
        const port = getPort(srv);
        const create = await requestJson(port, 'POST', '/jobs?wait=false', {
            instruction: 'delete me',
            autoRun: false,
            outputSchema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] },
        });
        strict_1.default.equal(create.status, 201);
        const created = create.body;
        strict_1.default.ok(created.job.id);
        const deleted = await requestJson(port, 'DELETE', `/jobs/${created.job.id}`);
        strict_1.default.equal(deleted.status, 200);
        const deletedBody = deleted.body;
        strict_1.default.equal(deletedBody.deleted, true);
        strict_1.default.equal(deletedBody.jobId, created.job.id);
        const list = await requestJson(port, 'GET', '/jobs');
        strict_1.default.equal(list.status, 200);
        const items = list.body;
        strict_1.default.equal(items.items.some(item => item.id === created.job.id), false);
    }
    finally {
        await server.stop();
    }
});
function createTestConfig() {
    return {
        host: '127.0.0.1',
        port: 0,
        apiKey: '',
        deepseekApiKey: '',
        dataDir: node_fs_1.default.mkdtempSync(node_path_1.default.join(node_os_1.default.tmpdir(), 'agent-browser-test-')),
        jobTimeoutMs: 1000,
        maxConcurrentJobs: 1,
        maxJobInstructionChars: 12000,
        browserMcpCommand: '',
        browserMcpArgs: [],
    };
}
function getPort(srv) {
    const address = srv.address();
    strict_1.default.ok(address && typeof address === 'object');
    return address.port;
}
function requestJson(port, method, pathName, body) {
    return new Promise((resolve, reject) => {
        const req = node_http_1.default.request({
            hostname: '127.0.0.1',
            port,
            method,
            path: pathName,
            headers: body ? { 'content-type': 'application/json', connection: 'close' } : { connection: 'close' },
            agent: false,
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(Buffer.from(chunk)));
            res.on('end', () => {
                try {
                    const raw = Buffer.concat(chunks).toString('utf8') || '{}';
                    resolve({ status: res.statusCode || 0, body: JSON.parse(raw) });
                }
                catch (err) {
                    reject(err);
                }
            });
        });
        req.on('error', reject);
        if (body)
            req.write(JSON.stringify(body));
        req.end();
    });
}

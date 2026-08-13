"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const jobStore_1 = require("../storage/jobStore");
(0, node_test_1.default)('job store persists jobs', () => {
    const dir = node_fs_1.default.mkdtempSync(node_path_1.default.join(node_os_1.default.tmpdir(), 'agent-browser-'));
    const store = new jobStore_1.FileJobStore(dir);
    store.upsert({
        id: 'job-1',
        instruction: 'open google.com',
        outputSchema: { type: 'object' },
        status: 'queued',
        createdAt: new Date().toISOString(),
        attempts: 0,
        autoRun: false,
        logs: [],
        executions: [],
    });
    const store2 = new jobStore_1.FileJobStore(dir);
    strict_1.default.equal(store2.get('job-1')?.instruction, 'open google.com');
});

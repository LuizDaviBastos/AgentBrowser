"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileJobStore = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
class FileJobStore {
    jobs = new Map();
    waiters = new Map();
    filePath;
    constructor(dataDir) {
        this.filePath = node_path_1.default.join(dataDir, 'jobs.json');
        node_fs_1.default.mkdirSync(dataDir, { recursive: true });
        this.load();
    }
    get(id) {
        return this.jobs.get(id);
    }
    list() {
        return Array.from(this.jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    upsert(job) {
        this.jobs.set(job.id, clone(job));
        this.persist();
    }
    remove(id) {
        this.jobs.delete(id);
        this.persist();
    }
    findByIdempotencyKey(key) {
        for (const job of this.jobs.values()) {
            if (job.idempotencyKey === key)
                return clone(job);
        }
        return undefined;
    }
    waitersFor(id) {
        let set = this.waiters.get(id);
        if (!set) {
            set = new Set();
            this.waiters.set(id, set);
        }
        return set;
    }
    onComplete(id) {
        this.emit(id);
    }
    emit(id) {
        const set = this.waiters.get(id);
        if (!set)
            return;
        for (const fn of Array.from(set)) {
            try {
                fn();
            }
            catch { }
        }
        set.clear();
        this.waiters.delete(id);
    }
    load() {
        try {
            if (!node_fs_1.default.existsSync(this.filePath))
                return;
            const raw = node_fs_1.default.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed))
                return;
            for (const item of parsed) {
                if (item && typeof item.id === 'string')
                    this.jobs.set(item.id, normalizeJob(item));
            }
        }
        catch { }
    }
    persist() {
        const tmp = `${this.filePath}.tmp`;
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(this.filePath), { recursive: true });
        node_fs_1.default.writeFileSync(tmp, JSON.stringify(Array.from(this.jobs.values()), null, 2), 'utf8');
        node_fs_1.default.renameSync(tmp, this.filePath);
    }
}
exports.FileJobStore = FileJobStore;
function clone(value) {
    return JSON.parse(JSON.stringify(value));
}
function normalizeJob(job) {
    return {
        ...job,
        logs: Array.isArray(job.logs) ? job.logs : [],
        executions: Array.isArray(job.executions) ? job.executions : [],
    };
}

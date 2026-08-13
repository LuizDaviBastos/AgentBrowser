"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NullBrowserDriver = void 0;
class NullBrowserDriver {
    name = 'null-browser-driver';
    async ensureReady() {
        throw new Error('No browser driver configured. Set BROWSER_MCP_COMMAND and BROWSER_MCP_ARGS.');
    }
    async runInstruction() {
        throw new Error('No browser driver configured. Set BROWSER_MCP_COMMAND and BROWSER_MCP_ARGS.');
    }
    async close() { }
}
exports.NullBrowserDriver = NullBrowserDriver;

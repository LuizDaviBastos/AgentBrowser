import { BrowserDriver } from '../types';

export class NullBrowserDriver implements BrowserDriver {
  readonly name = 'null-browser-driver';

  async ensureReady(): Promise<void> {
    throw new Error('No browser driver configured. Set BROWSER_MCP_COMMAND and BROWSER_MCP_ARGS.');
  }

  async runInstruction(): Promise<any> {
    throw new Error('No browser driver configured. Set BROWSER_MCP_COMMAND and BROWSER_MCP_ARGS.');
  }

  async close(): Promise<void> {}
}


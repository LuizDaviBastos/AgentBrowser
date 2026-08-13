# Agent Browser API

Node API server for browser-agent jobs with a React + Vite SPA.

## What it does

- Accepts jobs with a browser instruction.
- Stores jobs durably on disk.
- Runs jobs through a browser-driver adapter.
- Validates a final JSON output against a caller-provided schema.
- Exposes job status through HTTP.
- Serves the SPA from the same Node process.

## Browser worker

The server is built around a browser-driver interface. The first adapter is an MCP-backed browser worker launched as a separate process and addressed through JSON-RPC over stdio.

Configure it with:

- `BROWSER_MCP_COMMAND`
- `BROWSER_MCP_ARGS`

If those are not configured, the server still starts, but jobs fail with a clear error until a driver is available.

## Environment

- `HOST` default `127.0.0.1`
- `PORT` default `8787`
- `API_KEY` optional bearer token
- `DEEPSEEK_API_KEY` optional agent provider key
- `DATA_DIR` default `.data`
- `JOB_TIMEOUT_MS` default `300000`
- `MAX_CONCURRENT_JOBS` default `1`
- `MAX_JOB_INSTRUCTION_CHARS` default `12000`

## Endpoints

- `GET /health`
- `POST /jobs`
- `GET /jobs`
- `GET /jobs/:id`
- `DELETE /jobs/:id`
- `POST /jobs/:id/cancel`
- `POST /jobs/:id/retry`
- `POST /jobs/:id/wait`
- `GET /openapi.json`

## Final validation

Before shipping a change, run these checks:

1. Start the server.
2. Create a real job.
3. Edit the job and confirm the form keeps your unsaved changes.
4. Run the job and confirm the final response matches the configured JSON example or schema.
5. Delete the job and confirm it disappears from the list and from the job detail view.
6. Run `npm test` and `npm run build`.

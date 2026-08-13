import { loadConfig } from './config';
import { ApiServer } from './api/server';

async function main() {
  const config = loadConfig();
  const server = new ApiServer(config);
  await server.start();
  console.log(`agent-browser-api listening on http://${config.host}:${config.port}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const server_1 = require("./api/server");
async function main() {
    const config = (0, config_1.loadConfig)();
    const server = new server_1.ApiServer(config);
    await server.start();
    console.log(`agent-browser-api listening on http://${config.host}:${config.port}`);
}
main().catch(err => {
    console.error(err);
    process.exit(1);
});

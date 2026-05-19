import { readConfig } from "./config.js";
import { startServers } from "./server.js";

const config = readConfig();
const servers = await startServers(config);

console.log(`Dashboard:      http://${config.host}:${config.dashboardPort}`);
console.log(`OTLP/gRPC:      http://${config.host}:${config.otlpGrpcPort}`);
console.log(`OTLP/HTTP:      http://${config.host}:${config.otlpHttpPort}`);
console.log(`Storage:        ${config.storage}`);

const shutdown = async () => {
  await servers.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});

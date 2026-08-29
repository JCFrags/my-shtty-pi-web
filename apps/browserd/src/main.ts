import { BrowserdServer } from "./server.js";

const server = new BrowserdServer();
await server.start();

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await server.stop();
};
process.once("SIGINT", () => { void stop().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void stop().finally(() => process.exit(0)); });

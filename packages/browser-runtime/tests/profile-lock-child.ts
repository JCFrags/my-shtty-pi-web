import { ProfileManager } from "../src/chrome/profile-manager.js";

const root = process.argv[2];
if (root === undefined) throw new Error("profile root is required");
const manager = new ProfileManager(root);
let stopped = false;
const stop = async (): Promise<void> => { if (stopped) return; stopped = true; await manager.close(); };
try {
  await manager.initialize();
  process.stdout.write(`${JSON.stringify({ state: "ready", runtimeInstanceId: manager.runtimeInstanceId, instanceRoot: manager.instanceRoot })}\n`);
  process.once("SIGTERM", () => { void stop().finally(() => process.exit(0)); });
  setInterval(() => undefined, 1_000);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ state: "failed", message: error instanceof Error ? error.message : "failure" })}\n`);
  process.exitCode = 2;
}

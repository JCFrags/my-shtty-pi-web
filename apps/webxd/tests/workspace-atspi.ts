import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PYTHON = "/usr/bin/python3";
const SCRIPT = fileURLToPath(new URL("./workspace-atspi.py", import.meta.url));
const ACTIONS = ["inspect", "take-control", "return-control", "exercise-input", "exercise-pointer", "hold-input"] as const;
type WorkspaceAtspiAction = typeof ACTIONS[number];

export interface WorkspaceAtspiResult {
  readonly ok: true;
  readonly action: WorkspaceAtspiAction;
  readonly eventCount: number;
}

export class WorkspaceAtspi {
  async inspect(): Promise<WorkspaceAtspiResult> { return await this.run("inspect"); }
  async takeControl(): Promise<WorkspaceAtspiResult> { return await this.run("take-control"); }
  async returnControl(): Promise<WorkspaceAtspiResult> { return await this.run("return-control"); }
  async exerciseInput(): Promise<WorkspaceAtspiResult> { return await this.run("exercise-input"); }
  async exercisePointer(): Promise<WorkspaceAtspiResult> { return await this.run("exercise-pointer"); }
  async holdInput(): Promise<WorkspaceAtspiResult> { return await this.run("hold-input"); }

  private async run(action: WorkspaceAtspiAction): Promise<WorkspaceAtspiResult> {
    if (!(ACTIONS as readonly string[]).includes(action)) throw new TypeError("unsupported workspace AT-SPI action");
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(PYTHON, [SCRIPT, action], {
        encoding: "utf8",
        env: process.env,
        maxBuffer: 64 * 1024,
        // The Python driver has a 30-second fixed terminal-state bound.
        timeout: 35_000,
        windowsHide: true,
      }));
    } catch (error) {
      const stderr = isRecord(error) && typeof error.stderr === "string" ? error.stderr.trim() : "";
      const fixedCode = /^workspace AT-SPI action failed:(invoke|terminal-timeout|terminal-failed|unclassified)$/u.exec(stderr)?.[1] ?? "process";
      throw new Error(`workspace AT-SPI ${action} failed (${fixedCode})`, { cause: error });
    }
    if (stdout.length > 4_096) throw new Error(`workspace AT-SPI ${action} returned too much data`);
    let value: unknown;
    try { value = JSON.parse(stdout); }
    catch { throw new Error(`workspace AT-SPI ${action} returned invalid data`); }
    if (!isRecord(value)
      || Object.keys(value).some((key) => key !== "ok" && key !== "action" && key !== "eventCount")
      || value.ok !== true
      || value.action !== action
      || !Number.isSafeInteger(value.eventCount)
      || (value.eventCount as number) < 0
      || (value.eventCount as number) > 32) {
      throw new Error(`workspace AT-SPI ${action} returned invalid data`);
    }
    return value as unknown as WorkspaceAtspiResult;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

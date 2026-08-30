import { spawn, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const WORKSPACE_ID = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const MAX_PATH_BYTES = 4_096;

export interface WorkspaceLaunchRequest {
  readonly action: "show" | "hide" | "attach";
  readonly browserSessionId?: string;
  readonly tabId?: string;
}

export interface WorkspaceLauncher {
  launch(request: WorkspaceLaunchRequest): Promise<void>;
}

type SpawnWorkspace = (executable: string, args: readonly string[], options: {
  readonly shell: false;
  readonly detached: true;
  readonly stdio: "ignore";
}) => ChildProcess;

export class NodeWorkspaceLauncher implements WorkspaceLauncher {
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly homeDirectory = homedir(),
    private readonly spawnWorkspace: SpawnWorkspace = spawn,
  ) {}

  async launch(request: WorkspaceLaunchRequest): Promise<void> {
    const args = launchArguments(request);
    const configured = this.environment.PI_WEB_WORKSPACE_BIN;
    const candidate = configured && configured.length > 0 ? configured : join(this.homeDirectory, ".local", "bin", "pi-browser-workspace");
    if (!isAbsolute(candidate) || Buffer.byteLength(candidate) > MAX_PATH_BYTES || candidate.includes("\0")) {
      throw new Error("The configured workspace executable path is invalid.");
    }

    let executable: string;
    try {
      executable = await realpath(candidate);
      const metadata = await stat(executable);
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (!metadata.isFile() || (uid !== undefined && metadata.uid !== uid) || (metadata.mode & 0o100) === 0 || (metadata.mode & 0o022) !== 0) {
        throw new Error("unsafe executable");
      }
    } catch {
      throw new Error("The reviewed Pi Browser Workspace executable is unavailable or unsafe.");
    }

    const child = this.spawnWorkspace(executable, args, { shell: false, detached: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(new Error("The Pi Browser Workspace process could not be started.")));
    });
    child.unref();
  }
}

export function launchArguments(request: WorkspaceLaunchRequest): string[] {
  if (request.action === "show") return ["--raise"];
  if (request.action === "hide") return ["--hide"];
  if (!request.browserSessionId || !WORKSPACE_ID.test(request.browserSessionId)) throw new Error("A valid browser session ID is required.");
  if (request.tabId !== undefined && !WORKSPACE_ID.test(request.tabId)) throw new Error("The browser tab ID is invalid.");
  return [
    "--raise",
    `--select-session=${request.browserSessionId}`,
    ...(request.tabId ? [`--select-tab=${request.tabId}`] : []),
  ];
}

import { access } from "node:fs/promises";
import { ChromeHost, findChromeExecutable } from "./chrome-host.js";
import { CdpBrowserDriver } from "./cdp-browser-driver.js";
import { SpikeServer } from "./spike-server.js";
import type { AgentSessionId, Observation, SessionStatus } from "./types.js";

const SESSION_IDS = ["agent-a", "agent-b"] as const;

export class BrowserSpike {
  readonly server = new SpikeServer();
  readonly hosts = new Map<AgentSessionId, ChromeHost>();
  readonly drivers = new Map<AgentSessionId, CdpBrowserDriver>();
  readonly profileDirectories: string[] = [];
  browserProcessLaunchCount = 0;
  private frameTimer: NodeJS.Timeout | null = null;
  private framePumpRunning = false;
  private closed = false;

  async start(): Promise<void> {
    await this.server.start();
    const executable = await findChromeExecutable();
    const launched = await Promise.all(SESSION_IDS.map(async (id, index) => {
      const host = await ChromeHost.launch({
        hostId: `chrome-${id}`,
        executable,
        windowPosition: { x: 60 + index * 80, y: 60 + index * 80 },
      });
      this.browserProcessLaunchCount++;
      this.profileDirectories.push(host.profileDirectory);
      return [id, host] as const;
    }));
    for (const [id, host] of launched) this.hosts.set(id, host);

    const created = await Promise.all(SESSION_IDS.map(async (id, index) => {
      const host = this.requiredHost(id);
      const driver = await CdpBrowserDriver.create(host, id, {
        personaSeed: index === 0 ? 0x0a11ce : 0x0b0b42,
        freshnessMs: 3_000,
      });
      await driver.navigate(id, driver.identity.targetId, this.server.fixtureUrl(id));
      return [id, driver] as const;
    }));
    for (const [id, driver] of created) this.drivers.set(id, driver);
    this.server.bind(
      () => this.statuses(),
      (id) => this.drivers.get(id)?.latestFrame() ?? null,
    );
  }

  startFramePump(intervalMs = 500): void {
    if (this.framePumpRunning) return;
    this.framePumpRunning = true;
    const run = async () => {
      if (!this.framePumpRunning) return;
      await Promise.all([...this.drivers.entries()].map(async ([id, driver]) => {
        try {
          const frame = await driver.screenshot(id, driver.identity.targetId);
          this.server.publishFrame(frame);
        } catch (error) {
          if (!this.closed) console.error(`frame pump ${id}:`, error);
        }
      }));
      if (this.framePumpRunning) this.frameTimer = setTimeout(() => void run(), intervalMs);
    };
    void run();
  }

  stopFramePump(): void {
    this.framePumpRunning = false;
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.frameTimer = null;
  }

  driver(id: AgentSessionId): CdpBrowserDriver {
    const driver = this.drivers.get(id);
    if (!driver) throw new Error(`Unknown agent session: ${id}`);
    return driver;
  }

  statuses(): SessionStatus[] {
    return SESSION_IDS.map((id) => this.driver(id).status());
  }

  latestFrame(id: AgentSessionId): Observation | null {
    return this.driver(id).latestFrame();
  }

  async chromeVersion(): Promise<{ product: string; userAgent: string; protocolVersion: string; executable: string }> {
    const host = this.requiredHost("agent-a");
    const version = await host.cdp.send<{ product: string; userAgent: string; protocolVersion: string }>("Browser.getVersion");
    return { ...version, executable: host.executable };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopFramePump();
    await Promise.allSettled([...this.drivers.values()].map((driver) => driver.close()));
    await Promise.allSettled([...this.hosts.values()].map((host) => host.close()));
    await this.server.close();
  }

  async profilesAreRemoved(): Promise<boolean> {
    for (const path of this.profileDirectories) {
      try {
        await access(path);
        return false;
      } catch {
        // Missing is the expected state.
      }
    }
    return true;
  }

  private requiredHost(id: AgentSessionId): ChromeHost {
    const host = this.hosts.get(id);
    if (!host) throw new Error(`Unknown Chrome host: ${id}`);
    return host;
  }
}

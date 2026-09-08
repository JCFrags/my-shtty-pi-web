import assert from "node:assert/strict";

export async function piLoader() {
  const { SettingsManager, DefaultResourceLoader, createEventBus } = await import(process.env.PI_ROOT + "/dist/index.js");
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const settings = SettingsManager.create("/tmp/project", agentDir);
  const bus = createEventBus();
  let identity;
  let extension;
  bus.on("terminal-browser:loaded", value => { identity = value; });
  const loader = new DefaultResourceLoader({ cwd: "/tmp/project", agentDir, settingsManager: settings, eventBus: bus, noSkills: true, noPromptTemplates: true, noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }) });
  const shutdown = async () => {
    for (const handler of extension?.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "reload" }, {});
    extension = undefined;
  };
  return {
    shutdown,
    async load(artifactId) {
      await shutdown();
      await settings.reload();
      await loader.reload();
      const result = loader.getExtensions();
      assert.deepEqual(result.errors, []);
      assert.equal(result.extensions.length, 1);
      extension = result.extensions[0];
      assert.deepEqual([...extension.tools.keys()], ["browser_open", "browser_tabs", "browser_observe", "browser_act", "browser_control"]);
      for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "reload" }, {});
      assert.equal(identity.artifactId, artifactId);
      return identity;
    },
  };
}

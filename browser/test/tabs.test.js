const nodeAssertStrict = require("node:assert/strict");
const nodeTest = require("node:test");

const { BrowserControl: tabManagerBrowserControl } = require("../dist/agent/control.js");
const { createSlowNaturalPersonaProvider } = require("../dist/agent/interaction-profile.js");
const { TabManager: tabManagerClass } = require("../dist/session/tabs.js");

function tabManagerController() {
  return {
    surface: {},
    popup: null,
    devtoolsFocused: false,
    setVisible() {},
    focusContent() {},
    targetId: async () => null,
    releaseAllInput() {},
    releaseAgentPointer() {},
    releaseAgentInput() {},
    stop() {},
  };
}

nodeTest.test("tab activation clears activity for the tab left behind", () => {
  const manager = new tabManagerClass(
    {
      createController: () => tabManagerController(),
      onActivated() {},
      onActiveState() {},
      onCursorChanged() {},
      onDevtoolsChanged() {},
      onDevtoolsAction() {},
      onPageMenu() {},
      onTabsChanged() {},
      requestAgentRender() {},
      onTabOpened() {},
      onTabClosed() {},
      tabSwitchAllowed: () => true,
      agentTabSwitchAllowed: () => true,
      requestRender() {},
    },
    "about:blank",
    new tabManagerBrowserControl(),
  );
  const first = manager.create("https://one.test/", true);
  const second = manager.create("https://two.test/", false);
  let clears = 0;
  first.agentRuntime.clearActivity = () => { clears += 1; };

  nodeAssertStrict.equal(manager.activate(second.id), true);
  nodeAssertStrict.equal(clears, 1);
});

nodeTest.test("all tabs share one stable slow-natural persona", async () => {
  const personaProvider = createSlowNaturalPersonaProvider({ seed: 440, now: () => 0 });
  const manager = new tabManagerClass(
    {
      createController: () => tabManagerController(),
      onActivated() {},
      onActiveState() {},
      onCursorChanged() {},
      onDevtoolsChanged() {},
      onDevtoolsAction() {},
      onPageMenu() {},
      onTabsChanged() {},
      requestAgentRender() {},
      onTabOpened() {},
      onTabClosed() {},
      tabSwitchAllowed: () => true,
      agentTabSwitchAllowed: () => true,
      requestRender() {},
    },
    "about:blank",
    new tabManagerBrowserControl(),
    personaProvider,
  );
  const first = manager.create("https://one.test/", true);
  const second = manager.create("https://two.test/", false);

  await first.agentRuntime.actionServiceInstance();
  await second.agentRuntime.actionServiceInstance();

  nodeAssertStrict.strictEqual(first.agentRuntime.driver.persona, second.agentRuntime.driver.persona);
  nodeAssertStrict.equal(first.agentRuntime.driver.persona.seed, 440);
  nodeAssertStrict.equal(first.agentRuntime.driver.persona.base.speedFactor, 0.6);
});

nodeTest.test("get-url shares the session mutation lane and preserves request order", async () => {
  let resolveFirst;
  const firstGate = new Promise((resolve) => { resolveFirst = resolve; });
  const events = [];
  const control = new tabManagerBrowserControl();
  const manager = new tabManagerClass(
    {
      createController: () => tabManagerController(),
      onActivated() {},
      onActiveState() {},
      onCursorChanged() {},
      onDevtoolsChanged() {},
      onDevtoolsAction() {},
      onPageMenu() {},
      onTabsChanged() {},
      requestAgentRender() {},
      onTabOpened() {},
      onTabClosed() {},
      tabSwitchAllowed: () => true,
      agentTabSwitchAllowed: () => true,
      requestRender() {},
    },
    "about:blank",
    control,
  );
  const tab = manager.create("about:blank", true);
  tab.agentRuntime.getUrl = async () => {
    events.push("first-start");
    await firstGate;
    events.push("first-end");
    return { url: "about:blank", controlEpoch: 1 };
  };
  const first = manager.agentGetUrl(tab.id, { expectedControlEpoch: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  tab.agentRuntime.getUrl = async () => {
    events.push("second");
    return { url: "about:blank#second", controlEpoch: 1 };
  };
  const second = manager.agentGetUrl(tab.id, { expectedControlEpoch: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  nodeAssertStrict.equal(control.busy, true);
  nodeAssertStrict.deepEqual(events, ["first-start"]);
  resolveFirst();
  nodeAssertStrict.deepEqual(await Promise.all([first, second]), [
    { url: "about:blank", controlEpoch: 1 },
    { url: "about:blank#second", controlEpoch: 1 },
  ]);
  nodeAssertStrict.deepEqual(events, ["first-start", "first-end", "second"]);
  nodeAssertStrict.equal(control.busy, false);
});

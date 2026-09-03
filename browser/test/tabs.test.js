const nodeAssertStrict = require("node:assert/strict");
const nodeTest = require("node:test");

const { BrowserControl: tabManagerBrowserControl } = require("../dist/agent/control.js");
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

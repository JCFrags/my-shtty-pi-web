const assert = require("node:assert/strict");
const test = require("node:test");

const {
  currentBrowserOwner,
  paneOpenArgs,
  parseOpenedPane,
} = require("../dist/companion");
const { ownerMatches } = require("../dist/instances");

const ownerA = {
  workspaceId: "w1",
  tabId: "w1:t1",
  paneId: "w1:p1",
  sessionId: "pi-a",
  projectDir: "/tmp/a",
};

function row(key, owner) {
  return {
    key,
    pid: 1,
    socket: `/tmp/${key}.sock`,
    ownerWorkspaceId: owner.workspaceId,
    ownerTabId: owner.tabId,
    ownerPaneId: owner.paneId,
    ownerSessionId: owner.sessionId,
    ownerProjectDir: owner.projectDir,
  };
}

test("current owner derives from the calling Herdr Pi pane", () => {
  assert.deepEqual(currentBrowserOwner({
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_TAB_ID: "w1:t1",
    HERDR_PANE_ID: "w1:p1",
    PI_SESSION_ID: "pi-a",
  }, "/tmp/a"), ownerA);
});

test("exact owner selection prevents cross-agent routing", () => {
  const ownerB = { ...ownerA, paneId: "w1:p2", sessionId: "pi-b" };
  assert.deepEqual(ownerMatches([row("a", ownerA), row("b", ownerB)], ownerA).map((value) => value.key), ["a"]);
  assert.deepEqual(ownerMatches([row("a", ownerA), row("b", ownerB)], ownerB).map((value) => value.key), ["b"]);
});

test("pane launch passes complete owner metadata and exact placement", () => {
  const args = paneOpenArgs(ownerA, { url: "file:///tmp/a.html", focus: false });
  assert.deepEqual(args.slice(0, 12), [
    "plugin", "pane", "open", "--plugin", "zenbu-labs.terminal-browser",
    "--entrypoint", "companion", "--placement", "split",
    "--target-pane", "w1:p1", "--direction",
  ]);
  assert.equal(args.includes("--workspace"), false);
  assert.equal(args.includes("right"), true);
  assert.equal(args.includes("TERMINAL_BROWSER_OWNER_PANE_ID=w1:p1"), true);
  assert.equal(args.includes("TERMINAL_BROWSER_OWNER_PROJECT_DIR=/tmp/a"), true);
  assert.equal(args.includes("TERMINAL_BROWSER_COMPANION_URL=file:///tmp/a.html"), true);
  assert.equal(args.at(-1), "--no-focus");
});

test("pane response accepts only the expected plugin entrypoint", () => {
  const valid = JSON.stringify({ result: { plugin_pane: {
    plugin_id: "zenbu-labs.terminal-browser",
    entrypoint: "companion",
    pane: { pane_id: "w1:p8" },
  } } });
  assert.equal(parseOpenedPane(valid), "w1:p8");
  assert.throws(() => parseOpenedPane(valid.replace("companion", "other")), /invalid Herdr/);
});

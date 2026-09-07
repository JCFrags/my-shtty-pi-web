const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  AgentOverlayRenderCoalescer,
  agentOverlayEnabled,
  agentOverlayGeometry,
  mapAgentCssPoint,
} = require("../dist/ui/agent-overlay.js");

const layout = { x: 10, y: 20, width: 100, height: 80, scale: 2 };

test("agent overlay maps CSS points through the active surface scale", () => {
  assert.deepEqual(mapAgentCssPoint({ x: 5, y: 7 }, layout), { x: 20, y: 34 });
  assert.deepEqual(
    mapAgentCssPoint({ x: 1.25, y: 2.5 }, { x: 3, y: 4, width: 100, height: 80, scale: 1.5 }),
    { x: 5, y: 8 },
  );
  assert.deepEqual(
    agentOverlayGeometry({
      cursor: { x: 5, y: 7 },
      target: { x: 45, y: 30 },
      pulse: true,
    }, layout),
    {
      cursor: { x: 20, y: 34 },
      target: { x: 100, y: 80 },
    },
  );
});

test("agent overlay clips cursor and target centers to the page surface", () => {
  assert.deepEqual(
    agentOverlayGeometry({
      cursor: { x: -20, y: -5 },
      target: { x: 90, y: 60 },
      pulse: false,
    }, layout),
    {
      cursor: { x: 10, y: 20 },
      target: { x: 110, y: 100 },
    },
  );
});

test("agent overlay suppression is independent from control enforcement", () => {
  assert.equal(agentOverlayEnabled(false), true);
  assert.equal(agentOverlayEnabled(true), false);
});

test("agent overlay render requests coalesce until the scheduled frame", () => {
  const queued = [];
  let renders = 0;
  const coalescer = new AgentOverlayRenderCoalescer(
    (callback) => queued.push(callback),
    () => { renders += 1; },
  );
  coalescer.request();
  coalescer.request();
  coalescer.request();
  assert.equal(queued.length, 1);
  queued.shift()();
  assert.equal(renders, 1);
  coalescer.request();
  assert.equal(queued.length, 1);
  queued.shift()();
  assert.equal(renders, 2);
  coalescer.dispose();
  coalescer.request();
  assert.equal(queued.length, 0);
});

const { mock } = require("node:test");
const { AgentActivityOverlay } = require("../dist/ui/agent-overlay.js");
const { computeLayout } = require("../dist/session/layout.js");
const { popupSurfaceLayout } = require("../dist/ui/popup-modal.js");
const pulseModule = require("../dist/ui/pulse.js");
const theme = { bg: [0, 0, 0, 255], accent: [0, 255, 0, 255] };

function renderOverlay(surface, activity = { cursor: { x: 80, y: 90 }, target: { x: 100, y: 110 }, pulse: true }) {
  return AgentActivityOverlay({ activity, layout: surface, noOverlays: false, rem: 10,
    control: { state: "agent", busy: false }, theme });
}

test("overlay component places cursor hotspot, target, pulse and pill in terminal coordinates", () => {
  const pulse = mock.method(pulseModule, "usePulse", () => 0);
  try {
    for (const scale of [1, 1.5, 2]) {
      const surface = { x: 14, y: 56, width: 1200, height: 900, scale };
      const overlay = renderOverlay(surface);
      assert.deepEqual(overlay.props.style.inset, { top: 0, left: 0 });
      const [targets, cursor, pill] = overlay.props.children;
      const [ring, pulseRing] = targets.props.children;
      assert.equal(cursor.props.style.inset.left + cursor.props.style.width * 0.18, 14 + 80 * scale);
      assert.equal(cursor.props.style.inset.top + cursor.props.style.height * 0.22, 56 + 90 * scale);
      for (const node of [ring, pulseRing]) {
        assert.equal(node.props.style.inset.left + node.props.style.width / 2, 14 + 100 * scale);
        assert.equal(node.props.style.inset.top + node.props.style.height / 2, 56 + 110 * scale);
      }
      assert.equal(pill.props.style.inset.top, 62);
      assert.equal(pill.props.style.inset.left + pill.props.style.width, 1208);
    }
  } finally { pulse.mock.restore(); }
});

test("overlay component clips edge graphics without moving the cursor hotspot", () => {
  const pulse = mock.method(pulseModule, "usePulse", () => 0);
  try {
    const surface = { x: 14, y: 56, width: 1200, height: 900, scale: 1 };
    for (const point of [{ x: -10, y: -10 }, { x: 1300, y: 1000 }]) {
      const overlay = renderOverlay(surface, { cursor: point, target: point, pulse: true });
      const [targets, cursor] = overlay.props.children;
      for (const node of [...targets.props.children, cursor]) {
        const { inset, width, height, overflow } = node.props.style;
        assert.equal(overflow, "hidden");
        assert.ok(inset.left >= surface.x && inset.top >= surface.y);
        assert.ok(inset.left + width <= surface.x + surface.width);
        assert.ok(inset.top + height <= surface.y + surface.height);
      }
      const child = cursor.props.children.props.style;
      assert.equal(cursor.props.style.inset.left + child.inset.left + child.width * 0.18,
        surface.x + (point.x < 0 ? 0 : surface.width));
      assert.equal(cursor.props.style.inset.top + child.inset.top + child.height * 0.22,
        surface.y + (point.y < 0 ? 0 : surface.height));
    }
  } finally { pulse.mock.restore(); }
});

test("overlay follows recomputed terminal layouts and the current surface scale, including popup headers", () => {
  const pulse = mock.method(pulseModule, "usePulse", () => 0);
  try {
    for (const info of [
      { width: 1560, height: 1080, basePx: 16, cellHeight: 32 },
      { width: 2400, height: 1300, basePx: 24, cellHeight: 48 },
    ]) {
      for (const scale of [1, 1.5, 2]) {
        const { chrome, surface } = computeLayout(info, scale, false, false, null);
        const view = { width: 600, height: 400 };
        const popup = popupSurfaceLayout(view, chrome, surface.scale);
        assert.equal(popup.x, chrome.page.x + Math.round((chrome.page.width - 600) / 2));
        assert.equal(popup.y, chrome.page.y + Math.max(Math.round(info.basePx * 0.5),
          Math.round((chrome.page.height - 400 - Math.round(info.basePx * 1.7)) / 2)) + Math.round(info.basePx * 1.7));
        for (const current of [surface, popup]) {
          const cursor = renderOverlay(current).props.children[1].props.style;
          assert.equal(cursor.inset.left + cursor.width * 0.18, Math.round(current.x + 80 * scale));
          assert.equal(cursor.inset.top + cursor.height * 0.22, Math.round(current.y + 90 * scale));
        }
      }
    }
  } finally { pulse.mock.restore(); }
});

test("Chrome selects the visible surface and paints popup activity above its modal", () => {
  const React = require("react");
  const { Chrome } = require("../dist/ui/chrome.js");
  const { PopupModal } = require("../dist/ui/popup-modal.js");
  const mocks = [
    mock.method(React, "useMemo", (fn) => fn()),
    mock.method(React, "useState", (initial) => [initial, () => {}]),
    mock.method(React, "useRef", (current) => ({ current })),
    mock.method(React, "useEffect", () => {}),
    mock.method(pulseModule, "usePulse", () => 0),
  ];
  try {
    const { chrome, surface } = computeLayout({ width: 1560, height: 1080, basePx: 16, cellHeight: 32 }, 1, false, false, null);
    for (const popup of [null, { width: 600, height: 400 }]) {
      const tree = Chrome({ state: { loading: false }, actions: {}, layout: chrome,
        colors: { palette: [] }, tabs: [], popup, surfaceLayout: surface,
        agentActivity: { cursor: { x: 80, y: 90 } }, agentControl: { state: "agent" } });
      const children = React.Children.toArray(tree.props.children);
      const overlays = children.filter(node => node.type === AgentActivityOverlay);
      assert.equal(overlays.length, 1);
      const overlay = overlays[0];
      assert.deepEqual(overlay.props.layout, popup ? popupSurfaceLayout(popup, chrome, 1) : surface);
      if (popup) assert.ok(children.indexOf(overlay) > children.findIndex(node => node.type === PopupModal));
    }
  } finally { for (const item of mocks) item.mock.restore(); }
});

import { createRoot } from "pixel-react";

import { App } from "./App";
import { flushPersist, hydrateStore } from "./db/persist";
import { DbProvider } from "./db/react";
import { PALETTE_ACTIONS } from "./palette";
import { store } from "./session";

await hydrateStore();

const root = createRoot({
  onKey(event) {
    if (event.mods.ctrl && event.key === "q") {
      root.stop();
      void flushPersist().finally(() => process.exit(0));
      return;
    }
    if (event.mods.super && event.key === "b") {
      store.toggleSidebar();
      return;
    }
    if (event.mods.super && event.key === "p") {
      store.togglePalette();
      return;
    }
    if (store.palette) {
      if (event.key === "escape") store.closePalette();
      if (event.key === "up") store.movePalette(-1, PALETTE_ACTIONS.length);
      if (event.key === "down") store.movePalette(1, PALETTE_ACTIONS.length);
      if (event.key === "enter") {
        PALETTE_ACTIONS[store.paletteAt].run();
        store.closePalette();
      }
      return;
    }
    const session = store.active();
    if (session.ask) {
      if (event.key === "enter" || event.key === "y") session.ask.resolve(true);
      if (event.key === "escape" || event.key === "n") session.ask.resolve(false);
      return;
    }
    if (event.key === "escape") session.interrupt();
    if (event.mods.ctrl && event.key === "o") session.cycleModel();
    if (event.mods.ctrl && event.key === "p") session.cycleMode();
    if (event.mods.ctrl && event.key === "t") session.cycleThinking();
  },
  onResize() {
    render();
  },
});

function render() {
  root.render(
    <DbProvider fallback={<App info={{ ...root.info }} />}>
      <App info={{ ...root.info }} />
    </DbProvider>,
  );
}

render();

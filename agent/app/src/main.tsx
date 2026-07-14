import { createRoot } from "pixel-react";

import { App } from "./ui/app";
import { sweepAttachments } from "./attachments";
import { closeDb } from "./db/client";
import { flushPersist, hydrateStore } from "./db/persist";
import { DbProvider } from "./db/react";
import { applyFont, fontRows, initFonts } from "./fonts";
import { menus } from "./menu";
import { PALETTE_ACTIONS } from "./palette";
import { store } from "./session";

hydrateStore();
sweepAttachments();

const root = createRoot({
  onKey(event) {
    if (event.mods.ctrl && event.key === "c") {
      if (store.composerText) {
        menus.reset();
        store.clearComposer();
        return;
      }
      root.stop();
      flushPersist();
      closeDb();
      process.exit(0);
    }
    if (event.mods.super && event.key === "b") {
      store.toggleSidebar();
      return;
    }
    if (event.mods.super && event.key === "p") {
      store.togglePalette();
      return;
    }
    if (menus.handleKey(event)) return;
    if (store.settings) {
      const rows = fontRows(store.settingsQuery);
      const ctrl = (letter: string) => event.mods.ctrl && event.key === letter;
      if (event.key === "escape") store.closeSettings();
      else if (event.key === "up" || ctrl("p")) store.moveSettings(-1, rows.length);
      else if (event.key === "down" || ctrl("n")) store.moveSettings(1, rows.length);
      else if (event.key === "enter") {
        const row = rows[store.settingsAt];
        if (row) void applyFont(row.path);
      } else if (event.key === "backspace") {
        store.setSettingsQuery(store.settingsQuery.slice(0, -1));
      } else if (event.key.length === 1 && !event.mods.ctrl && !event.mods.super) {
        store.setSettingsQuery(store.settingsQuery + event.key);
      }
      return;
    }
    if (store.palette) {
      const ctrl = (letter: string) => event.mods.ctrl && event.key === letter;
      if (event.key === "escape") store.closePalette();
      if (event.key === "up" || ctrl("p")) store.movePalette(-1, PALETTE_ACTIONS.length);
      if (event.key === "down" || ctrl("n")) store.movePalette(1, PALETTE_ACTIONS.length);
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

initFonts((path) => root.registerFont(path));

function render() {
  root.render(
    <DbProvider>
      <App info={{ ...root.info }} />
    </DbProvider>,
  );
}

render();

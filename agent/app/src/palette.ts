import { store } from "./session";

export interface PaletteAction {
  label: string;
  run: () => void;
}

export const PALETTE_ACTIONS: PaletteAction[] = [
  { label: "settings", run: () => store.openSettings() },
];

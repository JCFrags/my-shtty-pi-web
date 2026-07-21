import type { PointerEvent, WheelEvent } from "pixel-react";

export interface PaletteView {
  index: number;
  items: { id: string; label: string; shortcut: string }[];
}

export interface NewTabView {
  suggestions: string[];
  /** -1 highlights the typed query itself */
  index: number;
}

export interface TabRow {
  id: number;
  title: string;
  favicon: string | null;
  active: boolean;
  loading: boolean;
}

export interface DeviceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DeviceView {
  mode: "phone" | "tablet";
  frame: DeviceRect & { radius: number };
  screen: DeviceRect;
  island: DeviceRect | null;
}

/** width/height are engine pixels, already clamped to fit the page area */
export interface PopupView {
  title: string;
  host: string;
  loading: boolean;
  width: number;
  height: number;
}

export interface ChromeActions {
  back(): void;
  forward(): void;
  reload(): void;
  urlEdit(): void;
  urlEditCancel(): void;
  urlSubmit(text: string): void;
  pointer(event: PointerEvent): void;
  wheel(event: WheelEvent): void;
  pageHover(hovering: boolean): void;
  findChange(text: string): void;
  findNext(forward: boolean): void;
  findClose(): void;
  paletteQuery(text: string): void;
  paletteRun(index: number): void;
  paletteClose(): void;
  tabSwitch(id: number): void;
  tabClose(id: number): void;
  tabNew(): void;
  newTabQuery(text: string): void;
  newTabSubmit(text: string): void;
  newTabCancel(): void;
  closeConfirmChoose(closePane: boolean): void;
  closeConfirmCancel(): void;
  popupPointer(event: PointerEvent): void;
  popupWheel(event: WheelEvent): void;
  popupClose(): void;
  zoomReset(): void;
}

export interface ChromeLayout {
  width: number;
  height: number;
  toolbarHeight: number;
  contentHeight: number;
  /** where the page surface sits, inset from the edges so its frame shows */
  page: { x: number; y: number; width: number; height: number };
  rem: number;
}

export interface BrowserState {
  url: string;
  title: string;
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  findMatches: { active: number; total: number } | null;
  /** browser zoom factor for the page's host, 1 = 100% */
  zoom: number;
}

export function initialBrowserState(url: string): BrowserState {
  return {
    url,
    title: "",
    favicon: null,
    loading: true,
    canGoBack: false,
    canGoForward: false,
    findMatches: null,
    zoom: 1,
  };
}

/** Where the page surface sits in the pane, in engine pixels; scale is the
 * device scale the page renders at (css px * scale = engine px). */
export interface BrowserSurfaceLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface DeviceSpec {
  width: number;
  height: number;
  userAgent: string;
}

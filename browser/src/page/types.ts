export interface BrowserState {
  url: string;
  title: string;
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  findMatches: { active: number; total: number } | null;
  zoom: number;
}

export function initialBrowserState(url: string): BrowserState {
  return {
    url,
    // yuck
    title: "",
    favicon: null,
    loading: true,
    canGoBack: false,
    canGoForward: false,
    findMatches: null,
    zoom: 1,
  };
}

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

import { useMemo } from "react";
import { Box, Text } from "pixel-react";
import type { EngineInfo, Surface } from "pixel-react";
import type { BrowserState } from "../page/types";
import { DeviceFrame } from "./device-frame";
import { Icon } from "./icons";
import type { IconName } from "./icons";
import { CloseConfirmCard, NewTabCard, PaletteCard, UrlCard } from "./modals";
import { FindBar, ZoomHud } from "./overlays";
import { PopupModal } from "./popup-modal";
import { TabStrip } from "./tab-strip";
import { makeTheme } from "./theme";
import type { Theme } from "./theme";
import type {
  ChromeActions,
  ChromeLayout,
  DeviceView,
  NewTabView,
  PaletteView,
  PopupView,
  TabRow,
} from "./types";

export function Chrome({
  state,
  actions,
  layout,
  colors,
  font,
  findOpen,
  palette,
  device,
  tabs,
  newTab,
  closeConfirm,
  urlEdit,
  popup,
  zoomHud,
  pageSurface,
  popupSurface,
}: {
  state: BrowserState;
  actions: ChromeActions;
  layout: ChromeLayout;
  colors: EngineInfo["colors"];
  font: number;
  findOpen: boolean;
  palette: PaletteView | null;
  device: DeviceView | null;
  tabs: TabRow[];
  newTab: NewTabView | null;
  closeConfirm: boolean;
  urlEdit: boolean;
  popup: PopupView | null;
  /** zoom factor to flash in a transient bubble after a cmd+/- press */
  zoomHud: number | null;
  pageSurface: Surface;
  popupSurface: Surface;
}) {
  const theme = useMemo(() => makeTheme(colors), [colors]);
  return (
    <Box
      style={{
        width: layout.width,
        height: layout.height,
        flexDirection: "column",
        background: theme.bg,
        color: theme.fg,
        fontSize: layout.rem,
        font,
      }}
    >
      {layout.toolbarHeight > 0 && (
        <Toolbar state={state} actions={actions} layout={layout} theme={theme} tabs={tabs} />
      )}
      {device ? (
        <DeviceFrame
          device={device}
          layout={layout}
          theme={theme}
          surface={pageSurface}
          actions={actions}
        />
      ) : (
        <BrowserTabContents layout={layout} theme={theme} surface={pageSurface} actions={actions} />
      )}
      {findOpen && (
        <FindBar state={state} actions={actions} layout={layout} theme={theme} />
      )}
      {zoomHud != null && (
        <ZoomHud factor={zoomHud} layout={layout} theme={theme} findOpen={findOpen} />
      )}
      {popup && (
        <PopupModal
          view={popup}
          actions={actions}
          layout={layout}
          theme={theme}
          surface={popupSurface}
        />
      )}
      {newTab && <NewTabCard view={newTab} actions={actions} layout={layout} theme={theme} />}
      {closeConfirm && <CloseConfirmCard actions={actions} layout={layout} theme={theme} />}
      {urlEdit && <UrlCard state={state} actions={actions} layout={layout} theme={theme} />}
      {palette && <PaletteCard view={palette} actions={actions} layout={layout} theme={theme} />}
    </Box>
  );
}

function Toolbar({
  state,
  actions,
  layout,
  theme,
  tabs,
}: {
  state: BrowserState;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
  tabs: TabRow[];
}) {
  const rem = layout.rem;
  return (
    <Box
      style={{
        height: layout.toolbarHeight,
        flexShrink: 0,
        alignItems: "center",
        gap: rem * 0.25,
        padding: { left: rem * 0.4, right: rem * 0.4 },
      }}
    >
      {(state.canGoBack || state.canGoForward) && (
        <>
          <ToolbarButton
            icon="back"
            enabled={state.canGoBack}
            rem={rem}
            theme={theme}
            onClick={actions.back}
          />
          <ToolbarButton
            icon="forward"
            enabled={state.canGoForward}
            rem={rem}
            theme={theme}
            onClick={actions.forward}
          />
        </>
      )}
      <ToolbarButton
        icon={state.loading ? "close" : "reload"}
        enabled
        rem={rem}
        theme={theme}
        onClick={actions.reload}
      />
      <TabStrip tabs={tabs} state={state} actions={actions} rem={rem} theme={theme} />
      {Math.round(state.zoom * 100) !== 100 && (
        <ZoomChip zoom={state.zoom} rem={rem} theme={theme} onReset={actions.zoomReset} />
      )}
    </Box>
  );
}

// why is this called page view
function BrowserTabContents({
  layout,
  theme,
  surface,
  actions,
}: {
  layout: ChromeLayout;
  theme: Theme;
  surface: Surface;
  actions: ChromeActions;
}) {
  return (
    <>
      <Box
        style={{
          position: "absolute",
          inset: { top: layout.page.y - 1, left: layout.page.x - 1 },
          width: layout.page.width + 2,
          height: layout.page.height + 2,
          cornerRadius: layout.rem * 0.55,
          border: { width: 1, color: theme.fieldBorder },
        }}
      />
      <Box
        id="browser-surface"
        surface={surface}
        style={{
          position: "absolute",
          inset: { top: layout.page.y, left: layout.page.x },
          width: layout.page.width,
          height: layout.page.height,
          cornerRadius: Math.max(2, layout.rem * 0.55 - 1),
          background: theme.bg,
        }}
        onPointer={actions.pointer}
        onWheel={actions.wheel}
        onMouseEnter={() => actions.pageHover(true)}
        onMouseLeave={() => actions.pageHover(false)}
      />
    </>
  );
}

function ToolbarButton({
  icon,
  enabled,
  rem,
  theme,
  onClick,
}: {
  icon: IconName;
  enabled: boolean;
  rem: number;
  theme: Theme;
  onClick(): void;
}) {
  return (
    <Box
      style={{
        width: rem * 1.5,
        height: rem * 1.5,
        alignItems: "center",
        justifyContent: "center",
        cornerRadius: rem * 0.3,
        hoverBackground: enabled ? theme.hover : undefined,
        flexShrink: 0,
      }}
      onClick={enabled ? onClick : undefined}
    >
      <Icon icon={icon} size={rem * 0.95} color={enabled ? theme.muted : theme.disabled} />
    </Box>
  );
}

// not 100% sure if we want this, but im not super opposed to it
function ZoomChip({
  zoom,
  rem,
  theme,
  onReset,
}: {
  zoom: number;
  rem: number;
  theme: Theme;
  onReset(): void;
}) {
  return (
    <Box
      style={{
        height: rem * 1.5,
        alignItems: "center",
        padding: { left: rem * 0.55, right: rem * 0.55 },
        cornerRadius: rem * 0.75,
        background: theme.field,
        hoverBackground: theme.hover,
        flexShrink: 0,
      }}
      onClick={onReset}
    >
      <Text style={{ fontSize: rem * 0.82, color: theme.muted, wrap: false, selectable: false }}>
        {Math.round(zoom * 100)}%
      </Text>
    </Box>
  );
}

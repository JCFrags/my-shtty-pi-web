import { Box } from "pixel-react";
import type { Rgba, Surface } from "pixel-react";
import { mix } from "./theme";
import type { Theme } from "./theme";
import type { ChromeActions, ChromeLayout, DeviceView } from "./types";

/** phone/tablet emulation: the page surface inside a drawn device shell */
export function DeviceFrame({
  device,
  layout,
  theme,
  surface,
  actions,
}: {
  device: DeviceView;
  layout: ChromeLayout;
  theme: Theme;
  surface: Surface;
  actions: ChromeActions;
}) {
  const { frame, screen, island, mode } = device;
  const frameColor: Rgba = [14, 14, 17, 255];
  const edge: Rgba = [70, 70, 78, 255];
  const nubW = Math.max(2, frame.w * 0.008);
  const nub = (top: number, height: number, left: number) => (
    <Box
      style={{
        position: "absolute",
        inset: { top: top - layout.toolbarHeight, left },
        width: nubW,
        height,
        cornerRadius: nubW / 2,
        background: edge,
      }}
    />
  );
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: layout.toolbarHeight, left: 0 },
        width: layout.width,
        height: layout.contentHeight,
        background: mix(theme.bg, [0, 0, 0, 255], 0.35),
      }}
    >
      {mode === "phone" && (
        <>
          {nub(frame.y + frame.h * 0.28, frame.h * 0.05, frame.x - nubW + 1)}
          {nub(frame.y + frame.h * 0.36, frame.h * 0.08, frame.x - nubW + 1)}
          {nub(frame.y + frame.h * 0.46, frame.h * 0.08, frame.x - nubW + 1)}
          {nub(frame.y + frame.h * 0.32, frame.h * 0.12, frame.x + frame.w - 1)}
        </>
      )}
      <Box
        style={{
          position: "absolute",
          inset: { top: frame.y - layout.toolbarHeight, left: frame.x },
          width: frame.w,
          height: frame.h,
          cornerRadius: frame.radius,
          background: frameColor,
          border: { width: 1, color: edge },
        }}
      />
      <Box
        id="browser-surface"
        surface={surface}
        style={{
          position: "absolute",
          inset: { top: screen.y - layout.toolbarHeight, left: screen.x },
          width: screen.w,
          height: screen.h,
          cornerRadius: Math.max(4, frame.radius - (screen.x - frame.x)),
        }}
        onPointer={actions.pointer}
        onWheel={actions.wheel}
        onMouseEnter={() => actions.pageHover(true)}
        onMouseLeave={() => actions.pageHover(false)}
      />
      {island && (
        <Box
          style={{
            position: "absolute",
            inset: { top: island.y - layout.toolbarHeight, left: island.x },
            width: island.w,
            height: island.h,
            cornerRadius: island.h / 2,
            background: [5, 5, 6, 255],
          }}
        />
      )}
    </Box>
  );
}

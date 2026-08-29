export const CURSOR_OVERLAY_INSTALL = String.raw`(() => {
  const KEY = "__piBrowserCursor";
  const install = () => {
    let host = document.getElementById(KEY);
    if (!host) {
      host = document.createElement("div");
      host.id = KEY;
      host.setAttribute("aria-hidden", "true");
      host.style.cssText = "position:fixed;left:0;top:0;width:24px;height:30px;pointer-events:none;z-index:2147483647;transform:translate(-100px,-100px);filter:drop-shadow(0 1px 2px rgba(0,0,0,.85));will-change:transform";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = '<style>:host{all:initial}.cursor{width:22px;height:28px;background:#ff2d55;clip-path:polygon(0 0,0 85%,27% 64%,43% 100%,56% 94%,40% 59%,76% 58%);outline:1px solid white}</style><div class="cursor"></div>';
      (document.documentElement || document.body).appendChild(host);
    }
    const state = globalThis[KEY] || { x: 80, y: 80, pathSequence: 0, sampleCount: 0 };
    globalThis[KEY] = state;
    host.style.transform = 'translate(' + state.x + 'px,' + state.y + 'px)';
    host.dataset.pathSequence = String(state.pathSequence);
    host.dataset.sampleCount = String(state.sampleCount);
  };
  globalThis.__piInstallCursor = install;
  globalThis.__piSetCursor = (x, y, pathSequence, sampleCount) => {
    install();
    const state = globalThis[KEY];
    state.x = x;
    state.y = y;
    state.pathSequence = pathSequence;
    state.sampleCount = sampleCount;
    const host = document.getElementById(KEY);
    host.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    host.dataset.pathSequence = String(pathSequence);
    host.dataset.sampleCount = String(sampleCount);
  };
  if (document.documentElement) install();
  else addEventListener("DOMContentLoaded", install, { once: true });
})();`;

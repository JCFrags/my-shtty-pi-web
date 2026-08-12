# webxd

`webxd` is the local WebX business authority.

This package admits authenticated actors, checks scopes and visibility, enforces idempotency and output bounds, and serves deterministic search, read, research, page-library, artifact, capability, and browser operations.

Browser operations use only `BrowserDaemonPort`. `BrowserDaemonRpcPort` maps semantic actions to the frozen `browser.act` shape. It maps visual CUA to the frozen scoped workspace lease, frame, control, and input methods. It preserves the selected path, owner, operation ID, cancellation, screenshot binding, capability truth, and human control epoch. It does not start a provider or use a direct fallback.

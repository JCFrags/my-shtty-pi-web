# Password-manager and extension feasibility gate

Run this gate on the target Fedora workstation before treating persistent profiles
as production-ready. The script first exercises the deterministic local extension
fixture in headless page-stream mode, checks the WebSocket stream, finds extension
CDP targets, invokes an extension keyboard shortcut, closes the browser, and
verifies profile state after restart.

```bash
node scripts/password-manager-spike.mjs
```

Run headed compatibility separately when a graphical session is available:

```bash
node scripts/password-manager-spike.mjs --headed
```

A real KeePassXC-Browser or Bitwarden unpacked extension path is an explicit gate:

```bash
PI_WEB_PASSWORD_MANAGER_EXTENSION=/absolute/path/to/extension \
PI_WEB_PASSWORD_MANAGER_URL=http://127.0.0.1:4173/auth \
PI_WEB_PASSWORD_MANAGER_SHORTCUT=Control+Shift+l \
PI_WEB_PASSWORD_MANAGER_ASSERT_JS='Boolean(document.querySelector("input[type=password]")?.value)' \
node scripts/password-manager-spike.mjs --require-real
```

Use a dedicated test vault/database. The assertion is evaluated in the page and
must confirm autofill without passing the password through a Pi tool argument.
The JSON report records headless, headed, CDP-target, stream, shortcut, and profile
restart results. A browser-native popup incompatibility is grounds for the optional
full-window/Xpra fallback; it is not grounds for removing extension capability.

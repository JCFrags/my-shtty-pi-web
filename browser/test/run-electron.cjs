const { spawnSync } = require('node:child_process');
const path = require('node:path');
const environment = { ...process.env, TERMINAL_BROWSER_SHM: '0' };
delete environment.ELECTRON_RUN_AS_NODE;
if (process.platform === 'linux' && !environment.DISPLAY) throw new Error('Native dialog fixture requires an X11 display.');
const args = [
  ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : []),
  path.join(__dirname, 'fixtures', 'contexts-electron.cjs'),
];
const result = spawnSync(require('electron'), args, { env: environment, stdio: 'inherit', timeout: 40000, killSignal: 'SIGKILL' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);

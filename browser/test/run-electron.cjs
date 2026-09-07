const { spawnSync } = require('node:child_process');
const path = require('node:path');
const environment = { ...process.env, TERMINAL_BROWSER_SHM: '0' };
delete environment.ELECTRON_RUN_AS_NODE;
if (process.platform === 'linux' && !environment.DISPLAY) throw new Error('Native dialog fixture requires an X11 display.');
for (const fixture of ['contexts-electron.cjs', 'files-electron.cjs', 'semantic-electron.cjs']) {
  const args = [
    ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : []),
    path.join(__dirname, 'fixtures', fixture),
  ];
  const result = spawnSync(require('electron'), args, { env: environment, stdio: 'inherit', timeout: fixture === 'semantic-electron.cjs' ? 120000 : 60000, killSignal: 'SIGKILL' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

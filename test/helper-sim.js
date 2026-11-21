'use strict';
// Runs helper/restart-helper.js against a pretend VS Code (a copy of node called `code` in its own
// folder): a main process, an extension host that starts the helper, and an orphan that ignores
// SIGTERM. Checks that everything is ended and that the new start keeps the flags.
// Runs on Linux, macOS and Windows (CI runs it on all three).

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WIN = process.platform === 'win32';
// the real path: the process list shows /private/var on macOS and long names on Windows
const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'restart-vsc-sim-')));
const app = path.join(dir, 'app');
fs.mkdirSync(app);
const code = path.join(app, WIN ? 'code.exe' : 'code');
fs.copyFileSync(process.execPath, code);
fs.chmodSync(code, 0o755);
const helper = path.resolve(__dirname, '../helper/restart-helper.js');
const w = (name, text) => fs.writeFileSync(path.join(dir, name), text);

w('orphan.js', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'orphan.pid'))}, String(process.pid));`);
w('ext.js', `
const { spawn } = require('child_process');
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(path.join(dir, 'ext.pid'))}, String(process.pid));
const cfg = { extHostPid: process.pid, appDir: ${JSON.stringify(app)}, launchExe: ${JSON.stringify(code)},
  extraArgs: [${JSON.stringify(path.join(dir, 'relaunched.js'))}, 'place'], waitMs: 20000, pauseMs: 100 };
const h = spawn(process.execPath, [${JSON.stringify(helper)}, JSON.stringify(cfg)], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
h.stdout.on('data', (d) => { if (String(d).startsWith('READY')) { fs.writeFileSync(${JSON.stringify(path.join(dir, 'quit.flag'))}, 'q'); h.unref(); h.stdout.destroy(); } });
setInterval(() => {}, 1000);
`);
w('main.js', `
const { spawn } = require('child_process');
const fs = require('fs');
spawn(process.execPath, [${JSON.stringify(path.join(dir, 'ext.js'))}], { stdio: 'ignore' });
spawn(process.execPath, [${JSON.stringify(path.join(dir, 'orphan.js'))}], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(path.join(dir, 'main.pid'))}, String(process.pid));
const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(path.join(dir, 'quit.flag'))})) { clearInterval(t); process.exit(0); } }, 100);
`);
w('relaunched.js', `require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'relaunched.txt'))}, JSON.stringify(process.execArgv.concat(process.argv.slice(2))));`);

const main = spawn(code, ['--no-warnings', path.join(dir, 'main.js')], { stdio: 'ignore', detached: true });
main.unref();

const alive = (pid) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === 'linux') {
    try {
      return !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z'); // ended, not collected yet
    } catch {
      return false;
    }
  }
  return true;
};
const read = (n) => fs.readFileSync(path.join(dir, n), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const until = Date.now() + 25000;
  while (!fs.existsSync(path.join(dir, 'relaunched.txt')) && Date.now() < until) await sleep(200);
  const fail = (m) => { console.error('FAIL: ' + m); try { console.error(fs.readFileSync(path.join(os.tmpdir(), 'restart-vsc.log'), 'utf8').split('\n').slice(-15).join('\n')); } catch {} process.exit(1); };
  if (!fs.existsSync(path.join(dir, 'relaunched.txt'))) fail('VS Code was not started again');
  const got = JSON.parse(read('relaunched.txt'));
  if (!got.includes('--no-warnings') || !got.includes('place')) fail('flags or places lost: ' + got);
  for (const n of ['main.pid', 'ext.pid', 'orphan.pid']) {
    if (alive(Number(read(n)))) fail(n + ' is still running');
  }
  // on Windows the restarted copy of node may still be exiting and keeps code.exe locked for a moment;
  // a leftover temp folder is not a failure
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (e) {
    console.warn('could not remove ' + dir + ': ' + e.code);
  }
  console.log('ok: main, extension host and an orphan that ignores SIGTERM ended; started again with', got.join(' '));
})();

'use strict';
// Restarts VS Code completely. The extension starts this script detached from VS Code, so it
// outlives it. Plain Node, no dependencies, the same code on Linux, macOS and Windows.
//
//   1. find the main VS Code process (the topmost ancestor of the extension host that still runs
//      from the VS Code install) and every process below it, and remember how it was started
//   2. tell the extension READY; it then asks VS Code to quit (VS Code asks about unsaved files)
//   3. wait until the main process is gone (giving up after `waitMs`: the quit was cancelled)
//   4. end every remembered process that is still alive (language servers, terminals, orphans)
//   5. start VS Code again with the same flags (profile, user data dir, ...)
//
// Argument: one JSON object. See `config` in the extension.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cfg = JSON.parse(process.argv[2] || '{}');
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const LOG = path.join(os.tmpdir(), 'restart-vsc.log');

function log(msg) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
  } catch {
    /* no log is not a reason to stop */
  }
}

// the extension reads one line from our stdout and then lets go of it
process.stdout.on('error', () => {});
function say(line) {
  try {
    process.stdout.write(line + '\n');
  } catch {
    /* gone */
  }
}
process.on('SIGHUP', () => {});
process.on('SIGPIPE', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// the process table

/** Map<pid, {ppid, exe}> of every process. */
function table() {
  const t = new Map();
  if (process.platform === 'linux') {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        let exe = '';
        try {
          exe = fs.readlinkSync(`/proc/${name}/exe`).replace(/ \(deleted\)$/, '');
        } catch {
          /* not ours to read */
        }
        t.set(Number(name), { ppid: Number(fields[1]), exe });
      } catch {
        /* it ended while we looked */
      }
    }
  } else if (WIN) {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true }
    );
    const rows = JSON.parse(out);
    for (const r of Array.isArray(rows) ? rows : [rows]) {
      t.set(r.ProcessId, { ppid: r.ParentProcessId, exe: r.ExecutablePath || '' });
    }
  } else {
    // macOS, BSD: `comm` is the full path on macOS
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) t.set(Number(m[1]), { ppid: Number(m[2]), exe: m[3].trim() });
    }
  }
  return t;
}

const norm = (p) => (WIN ? p.replace(/\\/g, '/').toLowerCase() : p);

/** Is `exe` a file inside the VS Code install `dir`? */
function inside(exe, dir) {
  if (!exe) return false;
  const d = norm(dir).replace(/\/+$/, '') + '/';
  return norm(exe).startsWith(d);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return false;
  }
  if (process.platform === 'linux') {
    // ended but not collected yet
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z') return false;
    } catch {
      return false;
    }
  }
  return true;
}

function descendants(t, root) {
  const kids = new Map();
  for (const [pid, p] of t) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(pid);
  }
  const out = new Set();
  const todo = [root];
  while (todo.length) {
    const p = todo.pop();
    for (const k of kids.get(p) || []) {
      if (!out.has(k) && k !== root) {
        out.add(k);
        todo.push(k);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// how the main process was started

/** Split a command line the way a shell would, roughly (for macOS and Windows, which give a string). */
function splitCommandLine(s) {
  const out = [];
  let cur = '';
  let quote = '';
  let has = false;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

function commandLine(pid, exe) {
  try {
    if (process.platform === 'linux') {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((x, i, a) => x || i < a.length - 1);
    }
    if (WIN) {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: 'utf8', windowsHide: true }
      ).trim();
      return splitCommandLine(out);
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
    // the caller drops the first item (the program), like on Linux and Windows
    return [exe, ...splitCommandLine(out.startsWith(exe) ? out.slice(exe.length) : out.replace(/^\S+/, ''))];
  } catch (e) {
    log(`command line of ${pid}: ${e.message}`);
    return [];
  }
}

// flags that name a place or a file for this launch, not how VS Code runs
const DROP = new Set([
  '--reuse-window', '-r', '--new-window', '-n', '--wait', '-w', '--goto', '-g', '--diff', '-d', '--merge', '-m',
  '--add', '-a', '--folder-uri', '--file-uri', '--unity-launch', '--open-url', '--remove',
]);
const DROP_WITH_VALUE = new Set(['--folder-uri', '--file-uri', '--goto', '-g', '--remove']);
// flags whose value may be the next argument
const WITH_VALUE = new Set([
  '--user-data-dir', '--extensions-dir', '--profile', '--locale', '--ozone-platform', '--password-store',
  '--enable-features', '--disable-features', '--proxy-server', '--remote-debugging-port', '--log', '--logsPath',
]);

/** The flags of the old start; folders, files and `code .`-style places are left out. */
function launchFlags(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) continue;
    const name = a.split('=')[0];
    if (DROP.has(name)) {
      if (DROP_WITH_VALUE.has(name) && !a.includes('=')) i++;
      continue;
    }
    if (a.startsWith('--type=') || a.startsWith('--inspect') || a.startsWith('--ms-enable-electron-run-as-node')) continue;
    out.push(a);
    if (WITH_VALUE.has(name) && !a.includes('=') && args[i + 1] !== undefined && !args[i + 1].startsWith('-')) {
      out.push(args[++i]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

function killNow(pid) {
  try {
    if (WIN) execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

async function endAll(snapshot) {
  // `snapshot`: Map<pid, exe>; only what is still the same process is ended (a pid can be reused)
  const still = () => {
    const t = table();
    return [...snapshot].filter(([pid, exe]) => alive(pid) && t.has(pid) && (!exe || t.get(pid).exe === exe));
  };
  let left = still();
  if (!left.length) return;
  log(`ending ${left.length} process(es) that are still running: ${left.map(([p]) => p).join(' ')}`);
  if (!WIN) {
    for (const [pid] of left) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
    for (let i = 0; i < 15 && (left = still()).length; i++) await sleep(200);
  }
  for (const [pid] of left) killNow(pid);
  for (let i = 0; i < 25 && (left = still()).length; i++) await sleep(200);
  if (left.length) log(`could not end: ${left.map(([p]) => p).join(' ')}`);
}

function start(exe, args) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('VSCODE_')) delete env[k];
  let cmd = exe;
  let argv = args;
  if (cfg.launchExe) {
    cmd = cfg.launchExe; // tests
  } else if (MAC && cfg.appBundle) {
    cmd = 'open';
    argv = [cfg.appBundle, ...(args.length ? ['--args', ...args] : [])];
  }
  log(`starting: ${cmd} ${argv.join(' ')}`);
  const child = spawn(cmd, argv, { detached: true, stdio: 'ignore', env, cwd: os.homedir(), windowsHide: false });
  child.on('error', (e) => log(`start failed: ${e.message}`));
  child.unref();
}

async function main() {
  const t = table();
  const self = process.pid;
  const mine = descendants(t, self);
  mine.add(self);

  const host = t.get(cfg.extHostPid);
  if (!host || !inside(host.exe, cfg.appDir)) {
    throw new Error(`the extension host (${cfg.extHostPid}) does not run from ${cfg.appDir}`);
  }
  let top = cfg.extHostPid;
  for (;;) {
    const up = t.get(t.get(top).ppid);
    if (up && inside(up.exe, cfg.appDir) && !mine.has(t.get(top).ppid)) top = t.get(top).ppid;
    else break;
  }
  const mainExe = t.get(top).exe;
  const snapshot = new Map();
  for (const pid of [top, ...descendants(t, top)]) {
    if (!mine.has(pid) && pid !== top) snapshot.set(pid, t.get(pid).exe);
  }
  const flags = launchFlags(commandLine(top, mainExe).slice(1));
  log(`main process ${top} (${mainExe}), ${snapshot.size} below it, flags: ${flags.join(' ')}`);
  say(`READY ${top}`);

  const until = Date.now() + (cfg.waitMs || 120000);
  while (alive(top) && Date.now() < until) await sleep(150);
  if (alive(top)) {
    log('VS Code did not quit (cancelled?); nothing was ended');
    return;
  }
  log('main process has quit');
  await endAll(snapshot);
  await sleep(cfg.pauseMs ?? 800);
  start(mainExe, [...flags, ...(cfg.extraArgs || [])]);
}

main().catch((e) => {
  log(`error: ${e.stack || e.message}`);
  say(`ERROR ${e.message}`);
  process.exitCode = 1;
});

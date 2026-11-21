import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

const cmd = (id: string, fn: () => unknown) => vscode.commands.registerCommand(`restartVsc.${id}`, fn);

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    cmd('reloadWindow', () => vscode.commands.executeCommand('workbench.action.reloadWindow')),
    cmd('restartExtensionHost', () => vscode.commands.executeCommand('workbench.action.restartExtensionHost')),
    cmd('reloadAllWindows', () => reloadAll(context)),
    cmd('restartVscode', () => restartVscode(context)),
    cmd('menu', () => menu()),
  );
  watchForReloadAll(context);
  statusBar(context);
}

export function deactivate(): void {}

// ---------------------------------------------------------------------------------------------
// menu and status bar

async function menu(): Promise<void> {
  const items = [
    { label: '$(refresh) Reload Window', id: 'reloadWindow', description: 'this window' },
    { label: '$(multiple-windows) Reload All Windows', id: 'reloadAllWindows', description: 'every open window' },
    { label: '$(debug-restart) Restart Extension Host', id: 'restartExtensionHost', description: 'extensions only' },
    { label: '$(power) Restart VS Code', id: 'restartVscode', description: 'every process ends, then VS Code starts again' },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Restart' });
  if (pick) {
    await vscode.commands.executeCommand(`restartVsc.${pick.id}`);
  }
}

function statusBar(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
  item.text = '$(refresh)';
  item.tooltip = 'Restart: reload window, reload all windows, restart extension host, restart VS Code';
  item.command = 'restartVsc.menu';
  const apply = () => {
    if (vscode.workspace.getConfiguration('restartVsc').get<boolean>('statusBar', true)) {
      item.show();
    } else {
      item.hide();
    }
  };
  apply();
  context.subscriptions.push(
    item,
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('restartVsc.statusBar') && apply()),
  );
}

// ---------------------------------------------------------------------------------------------
// reload all windows: every window of this VS Code watches one file in the storage folder they
// share (the folder is per user data directory); writing to it makes all of them reload

const SIGNAL = 'reload-all.txt';

function signalFile(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, SIGNAL);
}

function reloadAll(context: vscode.ExtensionContext): void {
  try {
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    fs.writeFileSync(signalFile(context), `${Date.now()} ${Math.random()}`);
  } catch (e) {
    void vscode.window.showErrorMessage(`Reload All Windows: ${(e as Error).message}`);
    return;
  }
  // the other windows have a moment to notice; this one goes last
  setTimeout(() => void vscode.commands.executeCommand('workbench.action.reloadWindow'), 400);
}

function watchForReloadAll(context: vscode.ExtensionContext): void {
  const dir = context.globalStorageUri.fsPath;
  const file = signalFile(context);
  const started = Date.now();
  let last = 0;
  const stamp = (): number => {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  };
  last = stamp();
  let reloading = false;
  const check = () => {
    const m = stamp();
    // only a signal sent after this window started counts, once
    if (!reloading && m > last && m >= started - 1000) {
      reloading = true;
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
    last = Math.max(last, m);
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const w = fs.watch(dir, () => check());
    w.on('error', () => {});
    context.subscriptions.push({ dispose: () => w.close() });
  } catch {
    /* polling below is enough */
  }
  // file watchers are not reliable everywhere (network drives, some containers)
  const timer = setInterval(check, 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

// ---------------------------------------------------------------------------------------------
// restart VS Code: a helper outside of VS Code waits until it has quit, ends what is left and
// starts it again (see helper/restart-helper.js)

/** The folder of the VS Code install: every VS Code process runs from a file inside it. */
function appDir(): string {
  const exe = process.execPath;
  if (process.platform === 'darwin') {
    const i = exe.indexOf('.app/');
    if (i >= 0) {
      return exe.slice(0, i + 4);
    }
  }
  return path.dirname(exe);
}

/** What to open again when VS Code does not bring its windows back by itself. */
function placesToOpen(): string[] {
  const restore = vscode.workspace.getConfiguration('window').get<string>('restoreWindows', 'all');
  if (restore === 'all' || restore === 'preserve') {
    return [];
  }
  const ws = vscode.workspace;
  if (ws.workspaceFile && ws.workspaceFile.scheme === 'file') {
    return [ws.workspaceFile.fsPath];
  }
  return (ws.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
}

function waitForLine(child: ReturnType<typeof spawn>, ms: number): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    const done = (s: string) => {
      clearTimeout(timer);
      resolve(s);
    };
    const timer = setTimeout(() => done('ERROR the helper did not answer'), ms);
    child.stdout?.on('data', (d) => {
      buf += d.toString();
      const line = buf.split('\n').find((l) => l.startsWith('READY') || l.startsWith('ERROR'));
      if (line) {
        done(line);
      }
    });
    child.on('error', (e) => done(`ERROR ${e.message}`));
    child.on('exit', () => done(buf.trim() || 'ERROR the helper stopped'));
  });
}

async function restartVscode(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('restartVsc');
  if (cfg.get<boolean>('confirmRestart', false)) {
    const ok = await vscode.window.showWarningMessage(
      'Restart VS Code? Every process it started, also the ones running in its terminals, will end.',
      { modal: true },
      'Restart',
    );
    if (ok !== 'Restart') {
      return;
    }
  }
  const helper = path.join(context.extensionPath, 'helper', 'restart-helper.js');
  const dir = appDir();
  const config = {
    extHostPid: process.pid,
    appDir: dir,
    appBundle: process.platform === 'darwin' ? dir : undefined,
    extraArgs: placesToOpen(),
    waitMs: 120000,
  };
  let child;
  try {
    // the helper runs on VS Code's own binary used as Node, so nothing has to be installed
    child = spawn(process.execPath, [helper, JSON.stringify(config)], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
  } catch (e) {
    return failed((e as Error).message);
  }
  const answer = await waitForLine(child, 15000);
  child.unref();
  child.stdout?.destroy();
  if (!answer.startsWith('READY')) {
    return failed(answer.replace(/^ERROR\s*/, ''));
  }
  // VS Code asks about unsaved files itself; the helper takes over when it has quit
  await vscode.commands.executeCommand('workbench.action.quit');
}

async function failed(why: string): Promise<void> {
  const pick = await vscode.window.showErrorMessage(
    `Restart VS Code: ${why}. Nothing was closed.`,
    'Reload Window',
  );
  if (pick === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

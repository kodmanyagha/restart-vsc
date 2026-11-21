# Restart VS Code

Four restart commands in one place (command palette: **Restart: …**, or the ↻ button in the status bar):

| Command | What it does |
|---|---|
| **Restart: Reload Window** | Reloads this window. |
| **Restart: Reload All Windows** | Reloads every open window of this VS Code. |
| **Restart: Restart Extension Host** | Restarts the extensions only; the window stays as it is. |
| **Restart: Restart VS Code** | Quits VS Code, makes sure **every process it started has ended**, then starts it again. |

## Restart VS Code

A normal quit can leave processes behind: language servers, file watchers, a dev server from a
terminal. This command waits until VS Code has quit, ends what is still running and only then
starts VS Code again, so the new start is a clean one.

- VS Code asks about unsaved files itself. If you cancel, nothing else happens.
- It starts again with the same flags (`--user-data-dir`, `--profile`, …). Your windows come back
  as `window.restoreWindows` says; with `none` or `one` the window you ran the command in is opened.
- Works the same on Linux, macOS and Windows. A small script (`helper/restart-helper.js`) does the
  waiting, ending and starting; it runs on VS Code's own binary, so nothing has to be installed.
- It also works in remote windows (SSH, WSL, containers): the extension runs on your own machine.
- The helper writes a log to `restart-vsc.log` in your temp folder.

Reload All Windows needs the other windows to have this extension active, which it is after startup.

## Settings

- `restartVsc.statusBar` (default on): the ↻ button.
- `restartVsc.confirmRestart` (default off): ask before **Restart VS Code**.

Add your own shortcut in *Keyboard Shortcuts* (search for "Restart"); none is set by default.

## Limits

- VS Code installed as a Flatpak or in another sandbox hides its processes from the helper. The
  command then says so and does nothing; use **Reload Window**.
- Restarting is tested on Linux. macOS and Windows use the same steps through `ps` / PowerShell and
  `taskkill`.

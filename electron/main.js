'use strict';

/**
 * DeepSeek Harness — desktop shell.
 *
 * Starts `dsh web` as a child process, waits until it accepts connections,
 * then shows the existing browser UI inside a native window.
 *
 * Design notes:
 *  - the agent's stdout/stderr go straight to a log file (no pipes), so the
 *    shell keeps working in locked-down environments;
 *  - the log file is tailed and streamed to the splash screen;
 *  - `dsh` is located by walking PATH and well-known global prefixes, never by
 *    shelling out to `npm`.
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');

const IS_WIN = process.platform === 'win32';
const ROOT = path.join(__dirname, '..');
const SPLASH = path.join(__dirname, 'splash.html');
const MAX_LOG_LINES = 500;
const START_TIMEOUT_MS = 120000;
const TAIL_INTERVAL_MS = 350;

// Portable/testing override: keep every shell artefact (settings, logs) in a
// caller-chosen directory instead of %APPDATA%.
if (process.env.DSH_DESKTOP_DATA) {
  app.setPath('userData', path.resolve(process.env.DSH_DESKTOP_DATA));
}

const SMOKE = process.env.DSH_DESKTOP_SMOKE === '1';

// Chromium's own process sandbox cannot initialise in every Windows session
// (restricted containers, hardened job objects) and the app then dies with
// STATUS_BREAKPOINT before any JavaScript runs — so the switch has to come
// from the command line. The Windows shortcuts created by the installer pass
// `--no-sandbox`; DSH_DESKTOP_CHROMIUM_SANDBOX=1 keeps the sandbox on when a
// launch path supports it.
//
// Hardware acceleration is fine by default; DSH_DESKTOP_GPU=0 disables it for
// machines with broken graphics drivers.
if (process.env.DSH_DESKTOP_GPU === '0') {
  app.disableHardwareAcceleration();
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {import('node:child_process').ChildProcess | null} */
let serverChild = null;
/** @type {string[]} */
let serverLog = [];
let currentUrl = null;
let starting = false;
let quitting = false;
let loggedFailure = false;

let logFd = null;
let logOffset = 0;
let tailTimer = null;
let pendingChunk = '';

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

function settingsPath() {
  return path.join(app.getPath('userData'), 'shell-settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  try {
    const next = { ...readSettings(), ...patch };
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  } catch (err) {
    console.warn('could not persist settings:', err.message);
  }
}

// ---------------------------------------------------------------------------
// agent log file
// ---------------------------------------------------------------------------

function logFilePath() {
  return path.join(app.getPath('userData'), 'logs', 'agent-server.log');
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/** Append a line of the shell's own logging to the shared log file. */
function shellLog(message) {
  try {
    fs.mkdirSync(path.dirname(logFilePath()), { recursive: true });
    fs.appendFileSync(logFilePath(), `[shell] ${message}\n`);
    tailLogFile();
  } catch {
    /* logging must never crash the shell */
  }
}

function pushLogText(text) {
  const clean = stripAnsi(text);
  pendingChunk += clean;
  const parts = pendingChunk.split(/\r?\n/);
  pendingChunk = parts.pop() ?? '';
  for (const line of parts) {
    if (!line.trim()) continue;
    serverLog.push(line);
    if (serverLog.length > MAX_LOG_LINES) serverLog.shift();
  }
  if (parts.some((line) => line.trim()) && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('shell:log', parts.filter((l) => l.trim()).join('\n'));
  }
}

/** Read whatever was appended to the agent log since the last read. */
function tailLogFile() {
  try {
    const file = logFilePath();
    const { size } = fs.statSync(file);
    if (size <= logOffset) return;
    const length = size - logOffset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, logOffset);
    } finally {
      fs.closeSync(fd);
    }
    logOffset = size;
    pushLogText(buffer.toString('utf8'));
  } catch {
    /* file not created yet */
  }
}

function prepareLogFile() {
  const file = logFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (logFd !== null) {
    try {
      fs.closeSync(logFd);
    } catch {
      /* ignore */
    }
  }
  logFd = fs.openSync(file, 'a');
  logOffset = fs.statSync(file).size;
  if (!tailTimer) tailTimer = setInterval(tailLogFile, TAIL_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// status reporting (splash screen)
// ---------------------------------------------------------------------------

function report(phase, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('shell:status', { phase, message });
  }
}

function showSplash(phase, message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const done = () => report(phase, message);
  if (mainWindow.webContents.getURL().startsWith('file://')) {
    done();
  } else {
    mainWindow.webContents.once('did-finish-load', done);
    mainWindow.loadFile(SPLASH);
  }
}

function showFailure(title, detail) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const payload = {
    phase: 'error',
    title,
    message: detail,
    log: serverLog.slice(-60).join('\n'),
  };
  const send = () => mainWindow.webContents.send('shell:status', payload);
  mainWindow.webContents.once('did-finish-load', send);
  mainWindow.loadFile(SPLASH);
  if (!loggedFailure) {
    loggedFailure = true;
    shellLog(`${title}: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// locating node and the `dsh` CLI
// ---------------------------------------------------------------------------

function isFile(candidate) {
  try {
    return Boolean(candidate) && fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function pathEntries() {
  return (process.env.PATH || '')
    .split(IS_WIN ? ';' : ':')
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function findOnPath(names) {
  for (const dir of pathEntries()) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function resolveNode() {
  if (process.env.DSH_NODE && isFile(process.env.DSH_NODE)) return process.env.DSH_NODE;
  const found = findOnPath(IS_WIN ? ['node.exe'] : ['node']);
  if (found) return found;
  return IS_WIN ? 'node.exe' : 'node';
}

/** Directories that may hold globally installed npm packages. */
function globalModuleDirs(nodeExe) {
  const dirs = new Set();
  if (nodeExe) {
    const nodeDir = path.dirname(nodeExe);
    dirs.add(path.join(nodeDir, 'node_modules'));
    if (IS_WIN) {
      dirs.add(path.join(nodeDir, 'node_modules', 'npm', 'node_modules'));
    } else {
      dirs.add(path.join(nodeDir, '..', 'lib', 'node_modules'));
    }
  }
  if (IS_WIN && process.env.APPDATA) {
    dirs.add(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  }
  if (process.env.npm_config_prefix) {
    dirs.add(path.join(process.env.npm_config_prefix, 'lib', 'node_modules'));
  }
  dirs.add('/usr/local/lib/node_modules');
  dirs.add('/usr/lib/node_modules');
  if (process.env.HOME) dirs.add(path.join(process.env.HOME, '.npm-global', 'lib', 'node_modules'));
  return [...dirs];
}

function resolveDshEntry(nodeExe) {
  if (process.env.DSH_BIN && isFile(process.env.DSH_BIN)) return process.env.DSH_BIN;

  const cached = readSettings().dshEntry;
  if (isFile(cached)) return cached;

  const candidates = [
    path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    ...globalModuleDirs(nodeExe).map((dir) =>
      path.join(dir, '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    ),
  ];
  for (const candidate of candidates) {
    if (isFile(candidate)) {
      writeSettings({ dshEntry: candidate });
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// child process lifecycle
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(1200);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(port) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (serverChild && serverChild.exitCode !== null && serverChild.exitCode !== 0) {
      throw new Error(`процесс агента завершился с кодом ${serverChild.exitCode}`);
    }
    if (await canConnect(port)) {
      tailLogFile();
      return;
    }
    await delay(250);
  }
  throw new Error(
    `агент не начал слушать порт ${port} за ${START_TIMEOUT_MS / 1000} с`,
  );
}

function killServer() {
  if (!serverChild || serverChild.exitCode !== null) return;
  const pid = serverChild.pid;
  if (!pid) return;
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      serverChild.kill('SIGTERM');
      setTimeout(() => {
        try {
          if (serverChild && serverChild.exitCode === null) serverChild.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 3000).unref();
    }
  } catch (err) {
    shellLog(`не удалось остановить агента: ${err.message}`);
  }
}

/**
 * `dsh web` prints the UI URL with a one-time auth token — opening the bare
 * root instead shows "authentication required". The line arrives slightly
 * after the socket starts listening, so wait for it.
 */
async function waitForUiUrl(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    tailLogFile();
    for (let i = serverLog.length - 1; i >= 0; i -= 1) {
      const match = serverLog[i].match(/https?:\/\/127\.0\.0\.1:\d+\/[^\s"'`),]*/);
      if (match) return match[0];
    }
    await delay(250);
  }
  shellLog('tokenised UI URL never appeared; falling back to the bare root');
  return `http://127.0.0.1:${port}/`;
}

async function startAgent() {
  if (starting || (serverChild && serverChild.exitCode === null)) return;
  starting = true;
  loggedFailure = false;
  serverLog = [];
  pendingChunk = '';

  try {
    prepareLogFile();
    shellLog('=== запуск оболочки ===');

    const node = resolveNode();
    const entry = resolveDshEntry(node);
    if (!entry) {
      showFailure(
        'Не найден DSH',
        'Пакет @deepseek-ai/dsh не найден.\n\n' +
          'Установите его командой:  npm i -g @deepseek-ai/dsh\n' +
          'или укажите путь к lib/bin.js в переменной окружения DSH_BIN.',
      );
      return;
    }

    const port = await freePort();
    shellLog(`start: ${entry} web --host 127.0.0.1 --port ${port}`);
    report('start', 'Запускаю агента…');

    const child = spawn(node, [entry, 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
      env: process.env,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      cwd: app.getPath('home'),
    });
    serverChild = child;

    child.once('error', (err) => {
      showFailure('Не удалось запустить агента', `${err.code || ''} ${err.message}`);
    });
    child.once('exit', (code) => {
      tailLogFile();
      serverChild = null;
      if (quitting) return;
      showFailure(
        'Агент остановился',
        `Процесс dsh web завершился с кодом ${code}. Подробности — в логе ниже.`,
      );
    });

    report('start', 'Жду, пока поднимется сервер…');
    await waitForServer(port);
    if (quitting) return;

    tailLogFile();
    const url = await waitForUiUrl(port);
    currentUrl = url;
    shellLog(`ready: ${url}`);
    report('ready', 'Открываю интерфейс…');
    await loadApp(url);
    if (SMOKE) await smokeCheck(url);
  } catch (err) {
    if (!quitting) showFailure('Агент не запустился', err.message);
  } finally {
    starting = false;
  }
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

function windowBounds() {
  const saved = readSettings().bounds;
  const defaults = { width: 1360, height: 880 };
  if (!saved) return defaults;
  return {
    ...defaults,
    ...saved,
    width: Math.max(saved.width || defaults.width, 900),
    height: Math.max(saved.height || defaults.height, 600),
  };
}

function createWindow() {
  const win = new BrowserWindow({
    ...windowBounds(),
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0f17',
    title: 'DeepSeek Harness',
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  mainWindow = win;

  win.once('ready-to-show', () => win.show());
  win.on('close', () => writeSettings({ bounds: win.getNormalBounds() }));
  win.on('closed', () => {
    mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) return;
    if (currentUrl && new URL(url).origin === new URL(currentUrl).origin) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    if (code === -3 || !url || url.startsWith('file://') || quitting) return;
    showFailure('Интерфейс не загрузился', `${description} (${code})\n${url}`);
  });

  win.webContents.on('console-message', (event) => {
    // Electron ≥ 40 passes a single details object; older builds passed
    // positionals, so keep a tolerant fallback.
    const level = event.level ?? 'info';
    const text = event.message;
    if (!text) return;
    if (SMOKE || level === 'error' || level === 'warning') {
      shellLog(`[renderer:${level}] ${text}`);
    }
  });

  win.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    if (mainWindow) mainWindow.setTitle(title || 'DeepSeek Harness');
  });

  win.loadFile(SPLASH);
  return win;
}

async function loadApp(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.loadURL(url);
  mainWindow.setTitle('DeepSeek Harness');
}

/** Automated end-to-end check used by CI / local verification. */
async function smokeCheck(url) {
  let result;
  try {
    // The page mounts asynchronously — poll until it has real text content.
    let title = '';
    let text = '';
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      title = await mainWindow.webContents.executeJavaScript('document.title');
      text = await mainWindow.webContents.executeJavaScript(
        'document.body ? document.body.innerText.trim().slice(0, 200) : ""',
      );
      if (text.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    result = { ok: text.length > 0, url, title, sample: text.slice(0, 120) };
    if (!result.ok) {
      result.html = await mainWindow.webContents.executeJavaScript(
        'document.documentElement.outerHTML.slice(0, 600)',
      );
      result.readyState = await mainWindow.webContents.executeJavaScript('document.readyState');
      result.scripts = await mainWindow.webContents.executeJavaScript(
        '[...document.scripts].map((s) => s.src || "inline").slice(0, 6)',
      );
    }
    console.log(`SMOKE_${result.ok ? 'OK' : 'EMPTY'} url=${url} title=${JSON.stringify(title)}`);
  } catch (err) {
    result = { ok: false, url, error: err.message };
    console.log(`SMOKE_FAIL ${err.message}`);
  } finally {
    try {
      const dir = app.getPath('userData');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'smoke-result.json'), JSON.stringify(result, null, 2));
    } catch (err) {
      console.log(`SMOKE_RESULT_WRITE_FAIL ${err.message}`);
    }
    quitting = true;
    killServer();
    setTimeout(() => app.exit(result.ok ? 0 : 1), 300);
  }
}

// ---------------------------------------------------------------------------
// menu
// ---------------------------------------------------------------------------

function buildMenu() {
  const template = [
    {
      label: 'Файл',
      submenu: [
        {
          label: 'Открыть в браузере',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => {
            if (currentUrl) shell.openExternal(currentUrl);
          },
        },
        { type: 'separator' },
        { role: IS_WIN || process.platform === 'linux' ? 'quit' : 'close', label: 'Выход' },
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Вернуть' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выделить всё' },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { role: 'reload', label: 'Перезагрузить' },
        { role: 'forceReload', label: 'Перезагрузить жёстко' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Масштаб 100%' },
        { role: 'zoomIn', label: 'Увеличить' },
        { role: 'zoomOut', label: 'Уменьшить' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Полный экран' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
      ],
    },
    {
      label: 'Помощь',
      submenu: [
        {
          label: 'О приложении',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'DeepSeek Harness',
              message: `DeepSeek Harness ${app.getVersion()}`,
              detail:
                'Десктопная оболочка для агента DeepSeek Harness.\n' +
                'Интерфейс обслуживает локальный процесс `dsh web`.\n\n' +
                `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
              buttons: ['OK'],
            });
          },
        },
        {
          label: 'Документация',
          click: () => shell.openExternal('https://github.com/deepseek-ai/deepseek-harness'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// ipc
// ---------------------------------------------------------------------------

ipcMain.on('shell:retry', () => {
  killServer();
  serverChild = null;
  currentUrl = null;
  loggedFailure = false;
  showSplash('start', 'Перезапускаю агента…');
  setTimeout(() => startAgent(), 400);
});

ipcMain.handle('shell:version', () => app.getVersion());
ipcMain.handle('shell:log', () => serverLog.join('\n'));
ipcMain.handle('shell:copy-log', () => {
  clipboard.writeText(serverLog.join('\n'));
  return true;
});
ipcMain.on('shell:open-external', (_event, url) => {
  if (typeof url === 'string' && /^https?:/i.test(url)) shell.openExternal(url);
});

// ---------------------------------------------------------------------------
// app lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('ai.deepseek.dsh.desktop');
    buildMenu();
    createWindow();
    startAgent();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      startAgent();
    }
  });

  app.on('before-quit', () => {
    quitting = true;
    killServer();
  });

  app.on('window-all-closed', () => {
    quitting = true;
    killServer();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    if (tailTimer) clearInterval(tailTimer);
    if (logFd !== null) {
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
      logFd = null;
    }
  });
}

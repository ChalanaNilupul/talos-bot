import { app, BrowserWindow, globalShortcut, Menu, nativeImage, screen, shell, ipcMain, Tray } from 'electron';
import path from 'node:path';
import {
  CH,
  PET_HEIGHT,
  PET_WIDTH,
  SHEET_HEIGHT,
  SHEET_WIDTH,
  type ApprovalOutcome,
  type ChatEvent,
  type ChatMessage,
  type CursorInfo,
  type DockSide,
  type PetState,
  type ToolRequest,
} from '../shared/types';
import { PERSONA, agent } from './agent';
import { auditDir } from './audit';
import { ApprovalGate } from './gate';
import { clearHistoryFile, loadHistory, saveHistory } from './history';
import { persist, settings } from './settings';
import { Tools } from './tools';

const CURSOR_POLL_MS = 33; // ~30Hz
const TRACK_RADIUS = 420; // further than this the pet stops following the cursor
const REACH_RADIUS = 110; // within this, wake up and accept clicks
const FIDGET_AFTER_MS = 60_000;
const YAWN_AFTER_MS = 240_000;
const SLEEP_AFTER_MS = 300_000;
const DOCK_GLIDE_MS = 260;
const GAP = 12;
/** Summon without hunting for a click-through pet. Alt+Space itself is Windows' system-menu key. */
const SUMMON_SHORTCUT = 'Alt+Shift+Space';
const HISTORY_LIMIT = 40;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let poll: NodeJS.Timeout | null = null;
let glide: NodeJS.Timeout | null = null;

let state: PetState = 'idle';
let clickable = false;
let pointerInside = false;
let dragging = false;
let dragOffset = { x: 0, y: 0 };
let lastInteraction = Date.now();
let lastCursor = { x: Number.NaN, y: Number.NaN };
let lastDistance = Number.POSITIVE_INFINITY;
let yawed = false;

let sheetOpen = false;
let overSheet = false;
let replyInFlight = false;
/** Loaded from disk in whenReady — see src/main/history.ts. */
let history: ChatMessage[] = [];

/**
 * Where a relative path or command is resolved. The first folder the user granted
 * wins, so "write notes.txt" means the folder they already said yes to; with no
 * grants yet it is home, which is at least a place they can find again.
 */
function workdir(): string {
  return settings().allowedDirs[0] ?? app.getPath('home');
}

const gate = new ApprovalGate({
  show: (request: ToolRequest) => {
    if (!win) return false;
    /* The card is the one thing allowed to pull the user in. An approval nobody was
       shown would simply time out into a denial and look like the app ignoring them. */
    openSheet();
    win.webContents.send(CH.approvalRequest, request);
    setState('alarmed');
    return true;
  },
  hide: (id: string, outcome: ApprovalOutcome) => {
    win?.webContents.send(CH.approvalEnd, id, outcome);
    if (gate.waiting === 0 && state === 'alarmed') wake();
  },
});

const tools = new Tools(gate);

/* In dev, Electron's app path is dist/ — which has no package.json — so the
   process would otherwise call itself "Electron" and keep its settings, history
   and single-instance lock in %APPDATA%\Electron, a folder apart from the
   installed app's. Named here, before anything asks for a path. */
app.setName('Talos');
app.setAppUserModelId('com.vixo.talos');
Menu.setApplicationMenu(null);

if (!app.requestSingleInstanceLock()) {
  /* Silent exits are undebuggable, and dev and the installed app now share one
     lock because they share one data folder. */
  console.error('[talos] another Talos is already running — quit it from the tray icon before starting this one');
  app.quit();
}

/* ---------------------------------------------------------------- geometry */

/**
 * The pet is anchored to the bottom-right corner of the overlay window and the
 * chat sheet hangs off its top-left, so the window rect and the pet rect stop
 * being the same thing the moment the sheet opens. Everything about the pet
 * derives from here instead of from the window origin.
 */
function petPosition(): [number, number] {
  if (!win) return [0, 0];
  const b = win.getBounds();
  return [b.x + b.width - PET_WIDTH, b.y + b.height - PET_HEIGHT];
}

function setPetPosition(x: number, y: number): void {
  if (!win) return;
  const b = win.getBounds();
  win.setPosition(Math.round(x - (b.width - PET_WIDTH)), Math.round(y - (b.height - PET_HEIGHT)));
}

/** Electron gives window position as a 2-element array typed only as number[]. */
function windowPosition(): [number, number] {
  const p = win?.getPosition();
  return p ? [p[0] ?? 0, p[1] ?? 0] : [0, 0];
}

function homeDisplay() {
  const [x, y] = petPosition();
  return win && !win.isDestroyed()
    ? screen.getDisplayMatching({ x, y, width: PET_WIDTH, height: PET_HEIGHT })
    : screen.getPrimaryDisplay();
}

function dockPoint(side: DockSide): { x: number; y: number } {
  const { workArea } = homeDisplay();
  const left = workArea.x + GAP;
  const right = workArea.x + workArea.width - PET_WIDTH - GAP;
  const top = workArea.y + GAP;
  const bottom = workArea.y + workArea.height - PET_HEIGHT - GAP;
  const centerX = Math.round(workArea.x + (workArea.width - PET_WIDTH) / 2);

  switch (side) {
    case 'bottom-left': return { x: left, y: bottom };
    case 'top-right': return { x: right, y: top };
    case 'top-left': return { x: left, y: top };
    case 'top': return { x: centerX, y: top };
    case 'bottom': return { x: centerX, y: bottom };
    default: return { x: right, y: bottom };
  }
}

function nearestDock(x: number, y: number): DockSide {
  const { workArea } = screen.getDisplayMatching({ x, y, width: PET_WIDTH, height: PET_HEIGHT });
  const cx = x + PET_WIDTH / 2;
  const cy = y + PET_HEIGHT / 2;
  const corners: Array<[DockSide, number, number]> = [
    ['bottom-right', workArea.x + workArea.width - GAP, workArea.y + workArea.height - GAP],
    ['bottom-left', workArea.x + GAP, workArea.y + workArea.height - GAP],
    ['top-right', workArea.x + workArea.width - GAP, workArea.y + GAP],
    ['top-left', workArea.x + GAP, workArea.y + GAP]
  ];
  let best: DockSide = 'bottom-right';
  let bestDist = Number.POSITIVE_INFINITY;
  for (const [side, px, py] of corners) {
    const d = Math.hypot(cx - px, cy - py);
    if (d < bestDist) {
      bestDist = d;
      best = side;
    }
  }
  return best;
}

function clampIntoDisplay(): void {
  if (!win) return;
  const [x, y] = petPosition();
  const { workArea } = screen.getDisplayMatching({ x, y, width: PET_WIDTH, height: PET_HEIGHT });
  const nx = Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - PET_WIDTH);
  const ny = Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - PET_HEIGHT);
  if (nx !== x || ny !== y) setPetPosition(nx, ny);
}

function glideTo(target: { x: number; y: number }): void {
  if (!win) return;
  if (glide) clearInterval(glide);
  const start = petPosition();
  const t0 = Date.now();
  glide = setInterval(() => {
    if (!win) return;
    const k = Math.min(1, (Date.now() - t0) / DOCK_GLIDE_MS);
    const ease = 1 - Math.pow(1 - k, 3);
    setPetPosition(start[0] + (target.x - start[0]) * ease, start[1] + (target.y - start[1]) * ease);
    if (k >= 1 && glide) {
      clearInterval(glide);
      glide = null;
    }
  }, 16);
}

/* ------------------------------------------------------------ interactivity */

/**
 * Click-through is the default so the pet never blocks the desktop. We only lift it when the
 * cursor is actually reaching for the pet (or already inside it), unless the user pinned
 * forceClickThrough in the tray menu.
 */
function applyMouse(): void {
  if (!win) return;
  const want =
    dragging || (!settings().forceClickThrough && (pointerInside || overSheet || lastDistance < REACH_RADIUS));
  if (want === clickable) return;
  clickable = want;
  win.setIgnoreMouseEvents(!want, { forward: true });
}

function setState(next: PetState): void {
  if (next === state) return;
  state = next;
  win?.webContents.send(CH.state, next);
  tray?.setToolTip(`Talos — ${next}`);
}

function wake(): void {
  lastInteraction = Date.now();
  yawed = false;
}

/* ------------------------------------------------------------------ chat sheet */

/**
 * The sheet hangs off the pet's top-left, so growing the window moves its origin
 * while the pet itself stays where it was. Clamping into the work area is what
 * lets a pet docked against an edge still show a panel.
 */
function sheetBounds(): { x: number; y: number; width: number; height: number } {
  const [px, py] = petPosition();
  const width = Math.max(SHEET_WIDTH, PET_WIDTH);
  const height = SHEET_HEIGHT + PET_HEIGHT;
  const { workArea } = screen.getDisplayMatching({ x: px, y: py, width, height });
  return {
    x: clamp(px - (width - PET_WIDTH), workArea.x, workArea.x + workArea.width - width),
    y: clamp(py - SHEET_HEIGHT, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

function emitChat(event: ChatEvent): void {
  win?.webContents.send(CH.chatEvent, event);
}

/** Every history mutation goes through here, so nothing can change without being saved. */
function pushHistory(message: ChatMessage): void {
  history = [...history, message].slice(-HISTORY_LIMIT);
  saveHistory(history);
}

function clearConversation(): void {
  history = [];
  clearHistoryFile();
  win?.webContents.send(CH.chatHistory, history);
}

function openSheet(): void {
  if (!win || sheetOpen) return;
  sheetOpen = true;
  /* This is the only moment the overlay is allowed to take the keyboard, and it
     gives it back the instant the sheet goes away. */
  win.setFocusable(true);
  win.setBounds(sheetBounds());
  win.show();
  win.focus();
  win.webContents.send(CH.sheetState, true);
  win.webContents.send(CH.chatHistory, history);
  win.webContents.send(CH.toolsState, settings().toolsEnabled);
  wake();
  applyMouse();
}

function closeSheet(): void {
  if (!win || !sheetOpen) return;
  const [px, py] = petPosition();
  sheetOpen = false;
  overSheet = false;
  win.webContents.send(CH.sheetState, false);
  win.setFocusable(false);
  win.setBounds({ x: px, y: py, width: PET_WIDTH, height: PET_HEIGHT });
  wake();
  applyMouse();
}

function toggleSheet(): void {
  if (sheetOpen) closeSheet();
  else openSheet();
}

async function handleSend(raw: string): Promise<void> {
  if (!win || replyInFlight) return;
  const prompt = raw.trim();
  if (!prompt) return;

  const prior = history;
  pushHistory({ role: 'user', text: prompt });
  replyInFlight = true;
  wake();
  emitChat({ kind: 'user', text: prompt });
  setState('thinking');

  try {
    const reply = await agent.send(
      { prompt, history: prior, persona: PERSONA, cwd: workdir() },
      {
        tools,
        say: (delta) => {
          if (state !== 'talking') setState('talking');
          emitChat({ kind: 'delta', text: delta });
        },
      }
    );
    pushHistory({ role: 'talos', text: reply });
    emitChat({ kind: 'reply', text: reply });
    setState('happy');
  } catch (cause) {
    console.error('[agent] reply failed', cause);
    emitChat({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    setState('confused');
  } finally {
    replyInFlight = false;
    wake();
  }
}

/* ------------------------------------------------------------------ the loop */

function tick(): void {
  if (!win) return;

  const cursor = screen.getCursorScreenPoint();
  const [x, y] = petPosition();
  const center = { x: x + PET_WIDTH / 2, y: y + PET_HEIGHT / 2 };
  const distance = Math.hypot(cursor.x - center.x, cursor.y - center.y);
  const moved = cursor.x !== lastCursor.x || cursor.y !== lastCursor.y;
  lastCursor = cursor;
  lastDistance = distance;

  if (moved && distance < TRACK_RADIUS) wake();

  /* The panel is a rectangle of real UI inside an otherwise click-through window,
     so it gets the same proximity treatment the pet has — hovering it is what
     lifts click-through, and hovering nothing at all leaves the desktop free. */
  const [wx, wy] = windowPosition();
  overSheet =
    sheetOpen &&
    cursor.x >= wx &&
    cursor.x < wx + SHEET_WIDTH &&
    cursor.y >= wy &&
    cursor.y < wy + SHEET_HEIGHT;
  applyMouse();

  if (dragging) {
    setPetPosition(cursor.x - dragOffset.x, cursor.y - dragOffset.y);
    return;
  }

  if (sheetOpen) wake();

  /* A reply in flight owns the pet's face; ambient states must not stamp on it. */
  if (!replyInFlight) {
    const idleFor = Date.now() - lastInteraction;
    if (idleFor > SLEEP_AFTER_MS) setState('sleep');
    else if (idleFor > YAWN_AFTER_MS) {
      if (!yawed) {
        yawed = true;
        setState('yawn');
      }
    } else if (idleFor > FIDGET_AFTER_MS) setState('fidget');
    else if (distance < TRACK_RADIUS && moved) setState('tracking');
    else setState('idle');
  }

  const info: CursorInfo = { x: cursor.x - x, y: cursor.y - y, distance };
  win.webContents.send(CH.cursor, info);
}

/* ----------------------------------------------------------------- tray menu */

function rebuildTray(): void {
  if (!tray) return;
  const sides: DockSide[] = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Talos is resting on your desktop', enabled: false },
      { label: `Show chat  (${SUMMON_SHORTCUT})`, click: toggleSheet },
      { label: 'Clear conversation', click: clearConversation },
      { type: 'separator' },
      {
        /* The kill switch has to be one click from the tray and work instantly,
           because that is the control you reach for the moment you stop trusting
           what it just did. */
        label: 'Allow tools',
        type: 'checkbox',
        checked: settings().toolsEnabled,
        click: (item) => {
          settings().toolsEnabled = item.checked;
          persist();
          if (!item.checked) gate.cancelAll('tools-off', 'kill-switch');
          win?.webContents.send(CH.toolsState, item.checked);
          rebuildTray();
        }
      },
      {
        /* rebuildTray runs after every grant, so reading the list here is never stale.
           Clicking one revokes it — the way in has to have a way out. */
        label: 'Allowed folders',
        submenu: settings().allowedDirs.length === 0
          ? [{ label: 'none yet', enabled: false }]
          : settings().allowedDirs.map((dir) => ({
              label: dir,
              click: () => {
                settings().allowedDirs = settings().allowedDirs.filter((d) => d !== dir);
                persist();
                rebuildTray();
              }
            }))
      },
      {
        label: 'Pass clicks through pet',
        type: 'checkbox',
        checked: settings().forceClickThrough,
        click: (item) => {
          settings().forceClickThrough = item.checked;
          pointerInside = false;
          persist();
          applyMouse();
          rebuildTray();
        }
      },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: settings().autoStart,
        click: (item) => {
          settings().autoStart = item.checked;
          app.setLoginItemSettings({ openAtLogin: item.checked });
          persist();
          rebuildTray();
        }
      },
      { type: 'separator' },
      {
        label: 'Dock to',
        submenu: sides.map((side) => ({
          label: side.replace('-', ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          type: 'radio' as const,
          checked: settings().dock === side,
          click: () => {
            settings().dock = side;
            settings().lastPosition = null;
            persist();
            glideTo(dockPoint(side));
            rebuildTray();
          }
        }))
      },
      { label: 'Open settings folder', click: () => void shell.openPath(app.getPath('userData')) },
      { label: 'Open audit log', click: () => void shell.openPath(auditDir()) },
      { type: 'separator' },
      { label: 'Quit Talos', click: () => app.quit() }
    ])
  );
}

/* -------------------------------------------------------------------- startup */

/** Renderer console output is invisible otherwise, which makes a WebGL failure undebuggable. */
function forwardRendererLogs(target: BrowserWindow): void {
  target.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level < 1) return;
    console.log(`[renderer ${level === 1 ? 'info' : level === 2 ? 'warn' : 'ERROR'}] ${message}  (${sourceId}:${line})`);
  });
  target.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer process gone]', details);
  });
}

function createWindow(): BrowserWindow {
  const start = settings().lastPosition ?? dockPoint(settings().dock);
  const created = new BrowserWindow({
    x: start.x,
    y: start.y,
    width: PET_WIDTH,
    height: PET_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // A pet must never steal focus from the editor. Chat input in P1 flips this to true on demand.
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  created.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  /* Shown synchronously: loadFile on a tiny local page can finish before a
     did-finish-load listener attached right after it is ever invoked. */
  created.showInactive();
  created.setAlwaysOnTop(true, 'screen-saver', 1);
  /* Clicking anywhere else dismisses the panel rather than leaving a focused
     text box somewhere the user has stopped looking at. */
  created.on('blur', () => closeSheet());
  return created;
}

void app.whenReady().then(() => {
  history = loadHistory();
  win = createWindow();
  if (!app.isPackaged) forwardRendererLogs(win);
  clampIntoDisplay();

  tray = new Tray(trayImage());
  tray.setToolTip('Talos');
  rebuildTray();

  ipcMain.on(CH.pointerInside, () => {
    pointerInside = true;
    wake();
    applyMouse();
  });
  ipcMain.on(CH.pointerLeft, () => {
    pointerInside = false;
  });
  /* Main works out the grab offset itself: once the sheet is open the renderer's
     click coordinates are no longer relative to the pet's corner. */
  ipcMain.on(CH.dragStart, () => {
    if (!win) return;
    const cursor = screen.getCursorScreenPoint();
    const [px, py] = petPosition();
    dragging = true;
    dragOffset = { x: cursor.x - px, y: cursor.y - py };
    wake();
    setState('dragging');
    applyMouse();
  });
  ipcMain.on(CH.dragEnd, () => {
    if (!win) return;
    dragging = false;
    wake();
    const [x, y] = petPosition();
    const side = nearestDock(x, y);
    settings().dock = side;
    settings().lastPosition = { x, y };
    persist();
    glideTo(dockPoint(side));
    setState('idle');
    applyMouse();
    rebuildTray();
  });

  ipcMain.on(CH.sheetOpen, openSheet);
  ipcMain.on(CH.sheetClose, closeSheet);
  ipcMain.on(CH.chatSend, (_event, text: unknown) => {
    if (typeof text === 'string') void handleSend(text);
  });
  /* The renderer names an id and a decision and nothing else: it cannot say what the
     tool would have done, because main already decided that before asking. */
  ipcMain.on(CH.approvalDecision, (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) return;
    const { id, decision } = payload as { id?: unknown; decision?: unknown };
    if (typeof id !== 'string') return;
    if (decision === 'allow' || decision === 'deny' || decision === 'allow-folder') gate.decide(id, decision);
  });

  if (!globalShortcut.isRegistered(SUMMON_SHORTCUT)) globalShortcut.register(SUMMON_SHORTCUT, toggleSheet);

  poll = setInterval(tick, CURSOR_POLL_MS);
  screen.on('display-metrics-changed', clampIntoDisplay);
});

app.on('before-quit', () => {
  if (poll) clearInterval(poll);
  if (glide) clearInterval(glide);
  globalShortcut.unregisterAll();
  /* Nothing may stay pending across a restart: a card that was never answered is a
     denial, not a yes deferred to the next launch. */
  gate.cancelAll('no-window', 'no-window');
  if (win) {
    const [x, y] = petPosition();
    settings().lastPosition = { x, y };
  }
  persist();
});

app.on('window-all-closed', () => app.quit());

function trayImage(): Electron.NativeImage {
  const image = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'tray-16.png'));
  return image.isEmpty() ? nativeImage.createEmpty() : image;
}

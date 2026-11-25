import './styles.css';
import { PET_HEIGHT, PET_WIDTH, type CursorInfo, type PetState } from '../shared/types';
import { isOpen } from './chat';
import { createScene, type Pose } from './scene';

const CX = PET_WIDTH / 2;
/* the shell sits in the upper-middle of the window, so gaze is measured from
   there rather than from the window centre */
const FACE_Y = Math.round(PET_HEIGHT * 0.37);
const TRACK_RANGE = 420;
const BLINK_MS = 150;
/** under this much travel a press is a click on the pet, not a drag of it */
const DRAG_THRESHOLD = 4;

const canvas = document.getElementById('stage') as HTMLCanvasElement;
/* Sizing lives here rather than in the stylesheet so the pet can never drift out of
   step with PET_WIDTH/PET_HEIGHT, and the overlay growing for the chat sheet
   (window is bigger) leaves the canvas exactly the size the scene was built for. */
canvas.style.width = `${PET_WIDTH}px`;
canvas.style.height = `${PET_HEIGHT}px`;
const scene = createScene(canvas);

/* ---------------------------------------------------------------- runtime */

let state: PetState = 'idle';
let cursor: CursorInfo = { x: CX, y: 0, distance: 0 };

const gaze = { x: 0, y: 0 };
const antenna = { x: 0, vx: 0, y: 0, vy: 0 };

let blinkAt = performance.now() + 2200;
let blinkStart = -1e6;
let yawnUntil = 0;
let hopUntil = 0;
let lastFrame = performance.now();
let cursorDelta = { x: 0, y: 0 };
const fidgetSeed = Math.random() * 1000;

/* ------------------------------------------------------------------ input */

let pointerReportAt = 0;
let dragging = false;
let pressed = false;
let pressAt = { x: 0, y: 0 };

canvas.addEventListener('pointermove', (event) => {
  if (pressed && !dragging && Math.hypot(event.clientX - pressAt.x, event.clientY - pressAt.y) > DRAG_THRESHOLD) {
    dragging = true;
    hopUntil = performance.now() + 260;
    window.talos.dragStart();
  }
  const now = performance.now();
  if (now - pointerReportAt > 200) {
    pointerReportAt = now;
    window.talos.pointerInside();
  }
});

canvas.addEventListener('pointerleave', () => {
  if (!dragging) window.talos.pointerLeft();
});

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  pressed = true;
  dragging = false;
  pressAt = { x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
});

const release = () => {
  if (!pressed) return;
  pressed = false;
  if (dragging) {
    dragging = false;
    window.talos.dragEnd();
    return;
  }
  /* A press that never travelled is a click on the pet itself. */
  if (isOpen()) window.talos.closeSheet();
  else window.talos.openSheet();
};

canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);

window.talos.onCursor((info) => {
  cursorDelta = { x: info.x - cursor.x, y: info.y - cursor.y };
  cursor = info;
});

window.talos.onState((next) => {
  const now = performance.now();
  if (next === 'yawn') yawnUntil = now + 1500;
  if (next === 'happy') hopUntil = now + 420;
  if (next !== 'sleep') blinkAt = now + 2500;
  state = next;
});

/* ----------------------------------------------------------------- helpers */

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const easeOut = (k: number) => 1 - Math.pow(1 - k, 3);

/* ------------------------------------------------------------------- frame */

function pose(now: number, dt: number): Pose {
  const asleep = state === 'sleep';
  const yawning = now < yawnUntil;
  const hopK = now < hopUntil ? easeOut(1 - (hopUntil - now) / 420) : 0;
  const yawnK = yawning ? Math.sin(clamp((yawnUntil - now) / 1500, 0, 1) * Math.PI) : 0;

  const breath = Math.sin((now / (asleep ? 6200 : 4000)) * Math.PI * 2);

  const dx = cursor.x - CX;
  const dy = cursor.y - FACE_Y;
  const len = Math.hypot(dx, dy) || 1;
  const tracking = !asleep && cursor.distance < TRACK_RANGE;
  const reach = clamp(len / 150, 0, 1);
  const k = 1 - Math.pow(0.0015, dt / 1000);
  gaze.x = lerp(gaze.x, tracking ? (dx / len) * reach : 0, k);
  gaze.y = lerp(gaze.y, tracking ? clamp((dy / len) * reach, -1, 0.75) : 0, k);

  /* slow wander layered on top, so stillness never reads as frozen */
  let wanderX = 0;
  let wanderY = 0;
  if (!dragging && (asleep || state === 'fidget' || state === 'idle')) {
    const p = (now + fidgetSeed) / (asleep ? 9000 : 5200);
    wanderX = Math.sin(p * Math.PI * 2) * (asleep ? 0.05 : 0.3);
    wanderY = Math.cos(p * Math.PI * 2) * (asleep ? 0.03 : 0.16);
  }
  const gx = clamp(gaze.x + wanderX, -1, 1);
  const gy = clamp(gaze.y + wanderY, -1, 1);

  if (now >= blinkAt) {
    blinkStart = now;
    blinkAt = now + 2800 + Math.random() * 4200;
  }
  const bt = (now - blinkStart) / BLINK_MS;
  const blinking = bt >= 0 && bt <= 1 ? Math.sin(bt * Math.PI) : 0;
  const blink = asleep ? 1 : clamp(blinking + yawnK, 0, 1);

  /* antenna lags the head by a spring — the most convincing "alive" detail */
  const bob = -breath * 0.012 + (asleep ? breath * 0.02 : 0) - hopK * 0.09 + yawnK * 0.02;
  antenna.vx += (gx * 0.11 - bob * 0.6 - antenna.x) * 0.18;
  antenna.vx *= 0.84;
  antenna.x += antenna.vx;
  antenna.vy += (-bob * 1.4 - antenna.y) * 0.18;
  antenna.vy *= 0.84;
  antenna.y += antenna.vy;

  const wobble = state === 'confused' ? Math.sin(now / 34) * 0.02 : 0;
  const dragLean = dragging ? clamp(cursorDelta.x * 0.0016, -0.09, 0.09) : 0;

  const busy = state === 'thinking' || state === 'talking';
  return {
    gazeX: gx,
    gazeY: gy,
    blink,
    breath: breath * (asleep ? 1.4 : 1) + yawnK * 0.8,
    bob,
    lean: gx * 0.03 + wobble + dragLean,
    antennaZ: antenna.x,
    antennaX: antenna.y,
    asleep,
    alarmed: state === 'alarmed',
    thinking: busy,
    glow: asleep ? 0.15 : busy || state === 'alarmed' ? 1 : 0.45 + Math.sin(now / 1400) * 0.15
  };
}

function loop(now: number) {
  const asleep = state === 'sleep';
  const dt = clamp(now - lastFrame, 1, 64);
  lastFrame = now;
  scene.render(pose(now, dt));
  // an idle pet should not burn frames: ~12Hz asleep, full rate awake
  setTimeout(() => requestAnimationFrame(loop), asleep ? 80 : 0);
}

/* Paint one frame synchronously. An unpainted transparent window is simply invisible,
   and requestAnimationFrame can be deferred until the window is first focused. */
loop(performance.now());

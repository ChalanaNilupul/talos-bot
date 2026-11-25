import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { DockSide } from '../shared/types';

export interface Settings {
  dock: DockSide;
  autoStart: boolean;
  forceClickThrough: boolean;
  lastPosition: { x: number; y: number } | null;
}

const DEFAULTS: Settings = {
  dock: 'bottom-right',
  autoStart: false,
  forceClickThrough: false,
  lastPosition: null
};

let cached: Settings | null = null;

const file = () => path.join(app.getPath('userData'), 'settings.json');

export function settings(): Settings {
  if (!cached) {
    try {
      cached = { ...DEFAULTS, ...(JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<Settings>) };
    } catch {
      cached = { ...DEFAULTS };
    }
  }
  return cached;
}

export function persist(): void {
  if (!cached) return;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cached, null, 2));
  } catch (err) {
    console.error('[talos] settings not saved:', err);
  }
}

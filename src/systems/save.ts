/** Persistent save state (localStorage with versioned migration). */

import { Lang } from './i18n';

export interface SaveState {
  v: number;
  lang: Lang | 'auto';
  music: boolean;
  sfx: boolean;
  haptics: boolean;
  adsRemoved: boolean;
  gems: number;
  level: number;          // current level to play
  stars: Record<number, 0 | 1 | 2 | 3>; // level → stars
  shiftsTotal: number;
  lastDaily: string;      // YYYY-MM-DD
  tutorialDone: number;   // highest tutorial level completed
  seenBiomes: number[];   // biome first indices shown
}

const KEY = 'chromalith.save.v1';
const SAVE_VERSION = 1;

export function defaultSave(): SaveState {
  return {
    v: SAVE_VERSION,
    lang: 'auto',
    music: true,
    sfx: true,
    haptics: true,
    adsRemoved: false,
    gems: 120,
    level: 1,
    stars: {},
    shiftsTotal: 0,
    lastDaily: '',
    tutorialDone: 0,
    seenBiomes: [1],
  };
}

export function loadSave(): SaveState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultSave();
    const data = JSON.parse(raw) as SaveState;
    if (data.v !== SAVE_VERSION) return defaultSave();
    return { ...defaultSave(), ...data };
  } catch {
    return defaultSave();
  }
}

export function persistSave(s: SaveState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full or blocked — game continues in memory */
  }
}

export function todayKey(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

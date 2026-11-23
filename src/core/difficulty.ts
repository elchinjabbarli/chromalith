/**
 * Difficulty curve for 1000 levels across 10 biomes.
 * Deterministic: level number → seed → params, so the client generates the
 * exact same level every time (verified offline by scripts/test-levels.mjs).
 */

import { Color } from './grid';
import { GenParams } from './generator';

export interface Biome {
  key: string;
  nameKey: string;
  /** background gradient stops */
  bg: [string, string, string];
  /** accent color for UI chrome in this biome */
  accent: string;
  range: [number, number]; // level numbers, inclusive
}

export const BIOMES: Biome[] = [
  { key: 'dawnshore',   nameKey: 'biome1',  bg: ['#1a2440', '#2b3a66', '#4a5d9e'], accent: '#7fa8ff', range: [1, 100] },
  { key: 'embergrove',  nameKey: 'biome2',  bg: ['#2b1a24', '#54273a', '#8a4a52'], accent: '#ff9d76', range: [101, 200] },
  { key: 'tidecavern',  nameKey: 'biome3',  bg: ['#0e2a2e', '#134a4a', '#1f7a6e'], accent: '#3fe0c5', range: [201, 300] },
  { key: 'fungalight',  nameKey: 'biome4',  bg: ['#231a33', '#3a2a52', '#5d4385'], accent: '#b78bff', range: [301, 400] },
  { key: 'frostreach',  nameKey: 'biome5',  bg: ['#16222e', '#24405a', '#3f6a8f'], accent: '#9fd8ff', range: [401, 500] },
  { key: 'duskspire',   nameKey: 'biome6',  bg: ['#2a1e2e', '#4a3050', '#7a4a6e'], accent: '#ff9fc7', range: [501, 600] },
  { key: 'voidmere',    nameKey: 'biome7',  bg: ['#101018', '#1c1c2e', '#30304e'], accent: '#8f9ff8', range: [601, 700] },
  { key: 'starfall',    nameKey: 'biome8',  bg: ['#181430', '#2a2060', '#453590'], accent: '#ffd23f', range: [701, 800] },
  { key: 'prismdepths', nameKey: 'biome9',  bg: ['#0e1818', '#123030', '#1a4a44'], accent: '#2ee6d6', range: [801, 900] },
  { key: 'luminary',    nameKey: 'biome10', bg: ['#241a10', '#4a3414', '#8a6a1e'], accent: '#ffe08a', range: [901, 1000] },
];

export function biomeFor(level: number): Biome {
  const clamped = Math.max(1, Math.min(1000, level));
  for (const b of BIOMES) {
    if (clamped >= b.range[0] && clamped <= b.range[1]) return b;
  }
  return BIOMES[0];
}

export const TOTAL_LEVELS = 1000;

/** progress within the whole game, 0..1 */
export function globalProgress(level: number): number {
  return Math.max(0, Math.min(1, (level - 1) / (TOTAL_LEVELS - 1)));
}

/* ------------------------------------------------------------------ */

const lerp = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t);

/** deterministic seed for a level */
export function seedFor(level: number): number {
  // scatter consecutive levels across the seed space
  let h = (level * 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** the sink color palette a biome may request */
function paletteFor(biomeIdx: number, rng: RngLike): Color[] {
  // biome 0: primaries only … later biomes add composites and white
  const pools: Color[][] = [
    [1, 2, 4],
    [1, 2, 4, 3],
    [1, 2, 4, 3, 6],
    [1, 2, 4, 3, 5, 6],
    [1, 2, 4, 3, 5, 6, 7],
  ];
  const pool = pools[Math.min(pools.length - 1, Math.floor(biomeIdx / 2))];
  return pool;
}

interface RngLike {
  pick<T>(arr: readonly T[]): T;
  range(min: number, max: number): number;
  chance(p: number): boolean;
}

/** Build generator params for a level number. */
export function paramsFor(level: number, rng: RngLike): GenParams {
  const biomeIdx = BIOMES.indexOf(biomeFor(level));
  const b = BIOMES[biomeIdx];
  const t = (level - b.range[0]) / (b.range[1] - b.range[0]); // 0..1 in biome
  const challenge = level % 10 === 0; // every 10th level is a spike
  const ct = challenge ? Math.min(1, t + 0.25) : t;

  const w = lerp(SIZE_MIN[biomeIdx][0], SIZE_MAX[biomeIdx][0], ct);
  const h = lerp(SIZE_MIN[biomeIdx][1], SIZE_MAX[biomeIdx][1], ct);
  const sinkCount = lerp(SINKS_MIN[biomeIdx], SINKS_MAX[biomeIdx], ct);
  const scramble = lerp(SCRAMBLE_MIN[biomeIdx], SCRAMBLE_MAX[biomeIdx], ct);
  const decoys = lerp(DECOYS_MIN[biomeIdx], DECOYS_MAX[biomeIdx], ct);
  const bends = lerp(BENDS_MIN[biomeIdx], BENDS_MAX[biomeIdx], ct);

  const palette = paletteFor(biomeIdx, rng);
  const sinks: { color: Color }[] = [];
  for (let i = 0; i < sinkCount; i++) {
    sinks.push({ color: rng.pick(palette) });
  }
  // guarantee at least one composite sink from biome 3 on (mixer teaching)
  if (biomeIdx >= 2 && sinkCount >= 2 && rng.chance(0.5)) {
    sinks[0] = { color: rng.pick([3, 5, 6]) };
  }
  // at most ONE white sink per level: white needs 3 feeds, two whites starve the board
  let whites = 0;
  for (const s of sinks) {
    if (s.color === 7) {
      whites++;
      if (whites > 1) s.color = rng.pick([3, 5, 6, 1, 2, 4]);
    }
  }

  const junctions: ('splitter' | 'mixer')[] = [];
  if (biomeIdx >= 1) junctions.push('splitter');
  if (biomeIdx >= 2) junctions.push('mixer');

  const minPar = lerp(PAR_MIN[biomeIdx], PAR_MAX[biomeIdx], ct);

  return {
    w, h, sinks,
    junctions,
    filters: biomeIdx >= 3,
    decoys,
    scramble,
    bends,
    minPar,
  };
}

/* per-biome [min,max] tables */
const SIZE_MIN: [number, number][] = [
  [5, 5], [6, 6], [6, 6], [7, 6], [7, 7], [7, 7], [8, 7], [8, 8], [8, 8], [8, 8],
];
const SIZE_MAX: [number, number][] = [
  [6, 6], [6, 6], [7, 7], [7, 7], [7, 7], [8, 7], [8, 8], [8, 8], [9, 8], [9, 9],
];
const SINKS_MIN = [1, 2, 2, 2, 3, 3, 3, 4, 4, 4];
const SINKS_MAX = [2, 3, 3, 3, 4, 4, 4, 5, 5, 5];
const SCRAMBLE_MIN = [2, 3, 4, 4, 5, 6, 7, 8, 9, 10];
const SCRAMBLE_MAX = [4, 5, 6, 7, 8, 9, 10, 11, 12, 14];
const DECOYS_MIN = [0, 1, 2, 2, 3, 3, 4, 4, 5, 5];
const DECOYS_MAX = [2, 3, 4, 5, 5, 6, 7, 8, 9, 10];
const BENDS_MIN = [1, 1, 1, 2, 2, 2, 2, 2, 3, 3];
const BENDS_MAX = [2, 2, 3, 3, 3, 3, 4, 4, 4, 4];
/** minimum moves the stored solution must need (difficulty floor) */
const PAR_MIN = [2, 2, 3, 3, 4, 4, 5, 5, 6, 6];
const PAR_MAX = [3, 4, 5, 5, 6, 6, 7, 8, 9, 10];

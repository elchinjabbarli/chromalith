/**
 * Level generator — reverse construction.
 *
 * 1. Build a SOLVED board by direct construction: fixed sources route beams
 *    along bend-paths (mirrors at turns), junctions split (splitter) or
 *    merge (mixer), and every sink ends up lit with its exact color.
 * 2. Sprinkle decoy devices on cells no beam touches.
 * 3. Verify the solved board with the real simulator.
 * 4. Scramble with K cyclic line shifts; verify the start is NOT solved.
 * 5. Store the inverse shift sequence, then greedily MINIMIZE it (drop any
 *    shift whose removal still solves the level) so par is tight.
 *
 * Every shift is invertible, so every level is solvable in ≤ par moves.
 */

import {
  Board, Cell, Color, Dir, DX, DY, makeCell, shiftLine, cloneBoard,
} from './grid';
import { Rng } from './rng';
import { simulate, sinkStats } from './sim';

export interface GenParams {
  w: number;
  h: number;
  sinks: { color: Color }[];
  junctions: ('splitter' | 'mixer')[];
  filters: boolean;
  decoys: number;
  scramble: number;
  bends: number;
  /** difficulty floor: reject levels whose minimal solution is shorter */
  minPar: number;
}

export interface Shift {
  axis: 0 | 1; // 0 = row, 1 = column
  index: number;
  amount: number;
}

export interface GeneratedLevel {
  w: number;
  h: number;
  cells: Cell[];      // scrambled start state
  par: number;
  solution: Shift[];  // minimal-ish shift sequence solving from start
  decoyCount: number;
  seed: number;
}

/* ------------------------------------------------------------------ */
/* occupancy planning                                                  */

type Occ = 'free' | 'path' | 'turn' | 'junction' | 'source' | 'sink';

interface Plan {
  w: number;
  h: number;
  occ: Occ[];
  board: Board;
  rng: Rng;
}

interface Pt { x: number; y: number }

const idx = (p: { w: number }, x: number, y: number): number => y * p.w + x;
const inBounds = (p: Plan, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < p.w && y < p.h;

/** Can a straight beam traverse this cell? */
const canTraverse = (p: Plan, x: number, y: number): boolean => {
  const o = p.occ[idx(p, x, y)];
  return o === 'free' || o === 'path' || o === 'source';
};

/** Can a mirror/junction be placed on this cell? */
const canPlace = (p: Plan, x: number, y: number): boolean =>
  p.occ[idx(p, x, y)] === 'free';

const mark = (p: Plan, x: number, y: number, o: Occ): void => {
  p.occ[idx(p, x, y)] = o;
};

/* ------------------------------------------------------------------ */
/* routing                                                             */

function dirBetween(a: Pt, b: Pt): Dir {
  if (b.x > a.x) return 0;
  if (b.y > a.y) return 1;
  if (b.x < a.x) return 2;
  return 3;
}

/** Mirror orientation from in/out directions: 0 = '/', 1 = '\' */
function mirrorOrient(inD: Dir, outD: Dir): 0 | 1 {
  const s = new Set<number>([inD, outD]);
  if ((s.has(0) && s.has(3)) || (s.has(1) && s.has(2))) return 0;
  return 1;
}

/** Bend test on the extended cell list (ext[0] = emitter, last = target). */
function isBend(ext: Pt[], j: number): boolean {
  const prev = ext[j - 1];
  const next = ext[j + 1];
  if (!prev || !next) return false;
  return !(prev.x === next.x || prev.y === next.y);
}

/**
 * Route a beam emitted by (sx, sy) in direction d0 so it ENTERS (tx, ty).
 * Marks path cells, places mirrors at bends. Target cell is left untouched.
 */
function routePath(
  p: Plan, sx: number, sy: number, d0: Dir, tx: number, ty: number, maxBends: number,
): boolean {
  for (let attempt = 0; attempt < 16; attempt++) {
    const cells = planBends(p, sx, sy, d0, tx, ty, maxBends, p.rng);
    if (!cells) continue;
    const ext: Pt[] = [{ x: sx, y: sy }, ...cells];

    // Validate every cell the beam crosses except the target (last).
    let ok = true;
    for (let i = 0; i < cells.length - 1; i++) {
      const c = cells[i];
      const bend = isBend(ext, i + 1);
      if (bend ? !canPlace(p, c.x, c.y) : !canTraverse(p, c.x, c.y)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    // Commit.
    for (let i = 0; i < cells.length - 1; i++) {
      const c = cells[i];
      if (isBend(ext, i + 1)) {
        const inD = dirBetween(ext[i], ext[i + 1]);
        const outD = dirBetween(ext[i + 1], ext[i + 2]);
        p.board.cells[idx(p, c.x, c.y)] = makeCell('mirror', 0, mirrorOrient(inD, outD));
        mark(p, c.x, c.y, 'turn');
      } else if (p.occ[idx(p, c.x, c.y)] === 'free') {
        mark(p, c.x, c.y, 'path');
      }
    }
    return true;
  }
  return false;
}

/** Bend-path as unit cells from emitter (excluded) to target (included). */
function planBends(
  p: Plan, sx: number, sy: number, d0: Dir, tx: number, ty: number,
  maxBends: number, rng: Rng,
): Pt[] | null {
  const pts: Pt[] = [{ x: sx, y: sy }];
  let cx = sx;
  let cy = sy;
  let cd = d0;
  const bends = rng.range(1, Math.max(1, maxBends));
  for (let b = 0; b < bends; b++) {
    const dist = rng.range(1, 4);
    cx += DX[cd] * dist;
    cy += DY[cd] * dist;
    if (!inBounds(p, cx, cy)) return null;
    pts.push({ x: cx, y: cy });
    cd = (rng.chance(0.5) ? (cd + 1) % 4 : (cd + 3) % 4) as Dir;
  }
  pts.push({ x: tx, y: ty });

  const cells: Pt[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const d = dirBetween(a, b);
    if ((b.x - a.x) * DY[d] !== 0 || (b.y - a.y) * DX[d] !== 0) return null; // diagonal
    const steps = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    let x = a.x;
    let y = a.y;
    for (let s = 0; s < steps; s++) {
      x += DX[d];
      y += DY[d];
      cells.push({ x, y });
    }
  }
  if (cells.length === 0) return null;
  const seen = new Set<number>();
  for (const c of cells) {
    if (!inBounds(p, c.x, c.y)) return null;
    const k = c.y * p.w + c.x;
    if (seen.has(k)) return null;
    seen.add(k);
  }
  if (dirBetween({ x: sx, y: sy }, cells[0]) !== d0) return null;
  const last = cells[cells.length - 1];
  if (last.x !== tx || last.y !== ty) return null;
  return cells;
}

/* ------------------------------------------------------------------ */
/* construction                                                        */

function reflectDir(d: Dir, orient: 0 | 1): Dir {
  if (orient === 0) return ([3, 2, 1, 0] as Dir[])[d];
  return ([1, 0, 3, 2] as Dir[])[d];
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function pickSourceSpot(p: Plan, rng: Rng): Pt | null {
  const spots: Pt[] = [];
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      if (p.occ[idx(p, x, y)] === 'free') spots.push({ x, y });
    }
  }
  if (spots.length === 0) return null;
  const border = spots.filter(s => s.x === 0 || s.y === 0 || s.x === p.w - 1 || s.y === p.h - 1);
  const pool = border.length > 3 && rng.chance(0.7) ? border : spots;
  return rng.pick(pool);
}

function randomDir(p: Plan, x: number, y: number, rng: Rng): Dir | null {
  const dirs: Dir[] = [0, 1, 2, 3];
  rng.shuffle(dirs);
  for (const d of dirs) {
    if (inBounds(p, x + DX[d] * 2, y + DY[d] * 2)) return d;
  }
  return null;
}

/** Spread n points with a rough min-distance. */
function spreadPoints(p: Plan, n: number, rng: Rng): Pt[] | null {
  if (n > p.w * p.h) return null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const pts: Pt[] = [];
    const minD = Math.max(1, Math.floor(Math.min(p.w, p.h) / (Math.ceil(Math.sqrt(n)) + 1)));
    let bad = false;
    for (let i = 0; i < n; i++) {
      let placed = false;
      for (let t = 0; t < 30; t++) {
        const x = rng.range(1, p.w - 2);
        const y = rng.range(1, p.h - 2);
        if (pts.every(q => Math.abs(q.x - x) + Math.abs(q.y - y) >= minD)) {
          pts.push({ x, y });
          placed = true;
          break;
        }
      }
      if (!placed) { bad = true; break; }
    }
    if (!bad) return pts;
  }
  return null;
}

/** One source → one beam → target cell. */
function buildSingleFeed(
  p: Plan, target: Pt, color: Color, params: GenParams, rng: Rng,
): boolean {
  for (let attempt = 0; attempt < 10; attempt++) {
    const src = pickSourceSpot(p, rng);
    if (!src) return false;
    const d = randomDir(p, src.x, src.y, rng);
    if (d === null) continue;
    const occBackup = p.occ.slice();
    const cellsBackup = p.board.cells.map(c => ({ ...c }));
    p.board.cells[idx(p, src.x, src.y)] = makeCell('source', color, d, true);
    mark(p, src.x, src.y, 'source');
    if (routePath(p, src.x, src.y, d, target.x, target.y, params.bends)) {
      return true;
    }
    p.occ = occBackup;
    p.board.cells = cellsBackup;
  }
  return false;
}

/** One source → splitter → two targets (same color). */
function buildSplitterFeed(
  p: Plan, sinkA: Pt, sinkB: Pt, color: Color, params: GenParams, rng: Rng,
): boolean {
  for (let attempt = 0; attempt < 10; attempt++) {
    const src = pickSourceSpot(p, rng);
    if (!src) return false;
    const d = randomDir(p, src.x, src.y, rng);
    if (d === null) continue;
    const steps = rng.range(1, 2);
    const jx = src.x + DX[d] * steps;
    const jy = src.y + DY[d] * steps;
    if (!inBounds(p, jx, jy) || !canPlace(p, jx, jy)) continue;

    // validate + mark the source→splitter segment (straight, direction d)
    let segOk = true;
    const midPts: Pt[] = [];
    for (let s = 1; s < steps; s++) {
      const mx = src.x + DX[d] * s;
      const my = src.y + DY[d] * s;
      if (!canTraverse(p, mx, my)) { segOk = false; break; }
      midPts.push({ x: mx, y: my });
    }
    if (!segOk) continue;

    const occBackup = p.occ.slice();
    const cellsBackup = p.board.cells.map(c => ({ ...c }));
    const orient = rng.chance(0.5) ? 0 : 1;
    const refl = reflectDir(d, orient);

    p.board.cells[idx(p, src.x, src.y)] = makeCell('source', color, d, true);
    mark(p, src.x, src.y, 'source');
    for (const m of midPts) {
      if (p.occ[idx(p, m.x, m.y)] === 'free') mark(p, m.x, m.y, 'path');
    }
    p.board.cells[idx(p, jx, jy)] = makeCell('splitter', 0, orient);
    mark(p, jx, jy, 'junction');

    const okA = routePath(p, jx, jy, d, sinkA.x, sinkA.y, params.bends);
    const okB = okA && routePath(p, jx, jy, refl, sinkB.x, sinkB.y, params.bends);
    if (okA && okB) return true;

    p.occ = occBackup;
    p.board.cells = cellsBackup;
  }
  return false;
}

/** Two sources → mixer → sink with a composite color. */
function buildMixerFeed(
  p: Plan, sink: Pt, channels: Color[], params: GenParams, rng: Rng,
): boolean {
  for (let attempt = 0; attempt < 12; attempt++) {
    const mx = clamp(rng.range(sink.x - 2, sink.x + 2), 0, p.w - 1);
    const my = clamp(rng.range(sink.y - 2, sink.y + 2), 0, p.h - 1);
    if (!canPlace(p, mx, my)) continue;
    const mDir = randomDir(p, mx, my, rng);
    if (mDir === null) continue;

    const occBackup = p.occ.slice();
    const cellsBackup = p.board.cells.map(c => ({ ...c }));
    p.board.cells[idx(p, mx, my)] = makeCell('mixer', 0, mDir);
    mark(p, mx, my, 'junction');

    let ok = true;
    for (const ch of channels) {
      if (!buildSingleFeed(p, { x: mx, y: my }, ch, params, rng)) {
        ok = false;
        break;
      }
    }
    if (ok && routePath(p, mx, my, mDir, sink.x, sink.y, params.bends)) {
      return true;
    }
    p.occ = occBackup;
    p.board.cells = cellsBackup;
  }
  return false;
}

function bitsOf(c: Color): Color[] {
  const out: Color[] = [];
  if (c & 1) out.push(1);
  if (c & 2) out.push(2);
  if (c & 4) out.push(4);
  return out;
}

/* ------------------------------------------------------------------ */
/* scramble + minimize                                                 */

function movableCount(b: Board, index: number, axis: 0 | 1): number {
  const len = axis === 0 ? b.w : b.h;
  let m = 0;
  for (let i = 0; i < len; i++) {
    const c = axis === 0 ? b.cells[index * b.w + i] : b.cells[i * b.w + index];
    if (!c.fixed) m++;
  }
  return m;
}

function applyShifts(b: Board, shifts: readonly Shift[]): Board {
  let out = b;
  for (const s of shifts) out = shiftLine(out, s.index, s.axis, s.amount);
  return out;
}

/** minimized solution length for the current scramble state */
function minParOf(start: Board, _solved: Board, shifts: Shift[]): number {
  // inverse sequence
  const inv: Shift[] = [];
  let cur = start;
  for (let i = shifts.length - 1; i >= 0; i--) {
    const s = shifts[i];
    const m = movableCount(cur, s.index, s.axis);
    const amt = (m - (s.amount % m)) % m;
    inv.push({ axis: s.axis, index: s.index, amount: amt });
    cur = shiftLine(cur, s.index, s.axis, amt);
  }
  return minimizeSolution(start, inv).length;
}

/** Greedily drop shifts whose removal still solves the level. */
function minimizeSolution(start: Board, solution: Shift[]): Shift[] {
  let sol = solution.map(s => ({ ...s }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < sol.length; i++) {
      const trial = sol.slice(0, i).concat(sol.slice(i + 1));
      const st = sinkStats(applyShifts(start, trial));
      if (st.ok === st.total) {
        sol = trial;
        changed = true;
        break;
      }
    }
  }
  return sol;
}

/* ------------------------------------------------------------------ */
/* entry point                                                         */

export function generateLevel(params: GenParams, rng: Rng, seed: number): GeneratedLevel | null {
  for (let restart = 0; restart < 40; restart++) {
    const built = tryBuild(params, rng, seed);
    if (built) return built;
  }
  return null;
}

function tryBuild(params: GenParams, rng: Rng, seed: number): GeneratedLevel | null {
  const { w, h } = params;
  const board: Board = {
    w, h,
    cells: Array.from({ length: w * h }, () => makeCell('empty')),
  };
  const p: Plan = { w, h, occ: Array.from({ length: w * h }, () => 'free' as Occ), board, rng };

  /* place sinks, spread out */
  const sinkPositions = spreadPoints(p, params.sinks.length, rng);
  if (!sinkPositions) return null;
  const sinkPts: Pt[] = [];
  params.sinks.forEach((spec, i) => {
    const pt = sinkPositions[i];
    board.cells[idx(p, pt.x, pt.y)] = makeCell('sink', spec.color, 0, true);
    mark(p, pt.x, pt.y, 'sink');
    sinkPts.push(pt);
  });

  /* feed every sink */
  let usedSplitter = false;
  for (let si = 0; si < sinkPts.length; si++) {
    const sink = sinkPts[si];
    const wantColor = params.sinks[si].color;
    const channels = bitsOf(wantColor);

    let placed = false;
    if (channels.length >= 2 && params.junctions.includes('mixer') && rng.chance(0.6)) {
      placed = buildMixerFeed(p, sink, channels, params, rng);
    }
    if (!placed && channels.length === 1 && params.junctions.includes('splitter')
      && !usedSplitter && rng.chance(0.35)) {
      const next = nextSameColorSink(params.sinks, si, sinkPts);
      if (next) {
        placed = buildSplitterFeed(p, sink, next, channels[0], params, rng);
        if (placed) usedSplitter = true;
      }
    }
    if (!placed) {
      placed = true;
      for (const ch of channels) {
        if (!buildSingleFeed(p, sink, ch, params, rng)) {
          placed = false;
          break;
        }
      }
    }
    if (!placed) return null;
  }

  /* decoys on untouched cells */
  const decoyPts: Pt[] = [];
  {
    const all: Pt[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (p.occ[idx(p, x, y)] === 'free') all.push({ x, y });
      }
    }
    rng.shuffle(all);
    for (let i = 0; i < Math.min(params.decoys, all.length); i++) decoyPts.push(all[i]);
  }
  for (const d of decoyPts) {
    const roll = rng.f();
    if (roll < 0.4) {
      board.cells[idx(p, d.x, d.y)] = makeCell('mirror', 0, rng.chance(0.5) ? 0 : 1);
    } else if (roll < 0.6 && params.filters) {
      board.cells[idx(p, d.x, d.y)] = makeCell('filter', rng.pick([1, 2, 4, 3, 5, 6]) as Color);
    } else if (roll < 0.8) {
      board.cells[idx(p, d.x, d.y)] = makeCell('block', 0, 0, rng.chance(0.5));
    } else {
      board.cells[idx(p, d.x, d.y)] = makeCell('prism');
    }
  }

  /* verify solved by the real simulator */
  const stats = sinkStats(board);
  if (stats.total === 0 || stats.ok !== stats.total) return null;
  const sim = simulate(board);
  if (sim.segs.length < 4) return null;

  /* scramble — keep shifting until the minimized solution meets minPar */
  const scrambleShifts: Shift[] = [];
  let scrambled = cloneBoard(board);
  const maxShifts = params.scramble + 10;
  let guard = 0;
  while (scrambleShifts.length < maxShifts && guard++ < 600) {
    const axis = (rng.chance(0.5) ? 0 : 1) as 0 | 1;
    const index = rng.i(axis === 0 ? h : w);
    const m = movableCount(scrambled, index, axis);
    if (m < 2) continue;
    const amount = rng.range(1, m - 1);
    scrambleShifts.push({ axis, index, amount });
    scrambled = shiftLine(scrambled, index, axis, amount);

    // every 2 extra shifts past the base count, check the difficulty floor
    if (scrambleShifts.length >= params.scramble
      && (scrambleShifts.length - params.scramble) % 2 === 0) {
      if (minParOf(scrambled, board, scrambleShifts) >= params.minPar) break;
    }
  }
  if (scrambleShifts.length < Math.min(params.scramble, 2)) return null;

  /* start must NOT be solved (and not mostly solved) */
  const startStats = sinkStats(scrambled);
  if (startStats.total === 0) return null;
  if (startStats.ok === startStats.total) return null;
  if (startStats.ok > Math.ceil(startStats.total * 0.5)) return null;

  /* inverse sequence restores the solved board */
  const solution: Shift[] = [];
  let cur = scrambled;
  for (let i = scrambleShifts.length - 1; i >= 0; i--) {
    const s = scrambleShifts[i];
    const m = movableCount(cur, s.index, s.axis);
    const inv = (m - (s.amount % m)) % m;
    solution.push({ axis: s.axis, index: s.index, amount: inv });
    cur = shiftLine(cur, s.index, s.axis, inv);
  }
  const final = sinkStats(cur);
  if (final.ok !== final.total) return null;

  /* minimize: drop redundant shifts, re-verify from the real start */
  const minimized = minimizeSolution(scrambled, solution);
  const minCheck = sinkStats(applyShifts(scrambled, minimized));
  if (minCheck.ok !== minCheck.total) return null; // safety, should not happen
  if (minimized.length < params.minPar) return null; // too easy — rebuild

  const par = Math.max(1, minimized.length);
  return {
    w, h,
    cells: scrambled.cells,
    par,
    solution: minimized,
    decoyCount: decoyPts.length,
    seed,
  };
}

function nextSameColorSink(specs: { color: Color }[], si: number, pts: Pt[]): Pt | null {
  for (let j = si + 1; j < specs.length; j++) {
    if (specs[j].color === specs[si].color) return pts[j];
  }
  return null;
}

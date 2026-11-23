/**
 * Beam simulation. Pure, deterministic, no DOM.
 *
 * A beam segment is (x, y, dir, color): it ENTERS cell (x,y) moving in dir.
 * Sources emit; devices transform; sinks absorb and record color hits.
 * Mixers accumulate all incoming colors during a pass, then emit the OR of
 * everything they saw in that pass on the next pass (max 4 passes needed).
 * The state space is finite, so a visited-set cuts cycles while still
 * accumulating sink/mixer inputs.
 */

import { Board, Cell, Color, Dir, DX, DY, reflect } from './grid';

export interface BeamSeg {
  x: number;
  y: number;
  d: Dir;
  c: Color;
}

export interface SimResult {
  /** segments in emission order, for rendering */
  segs: BeamSeg[];
  /** color mask that reached each sink, indexed by cell index */
  sinkHits: Map<number, Color>;
  /** all cells entered by any beam (for glow) */
  litCells: Set<number>;
}

function stateKey(x: number, y: number, d: Dir, c: Color): number {
  return ((y * 64 + x) * 4 + d) * 8 + c;
}

interface MixEntry {
  idx: number;
  color: Color;
  dir: Dir;
}

export function simulate(b: Board): SimResult {
  const segs: BeamSeg[] = [];
  const sinkHits = new Map<number, Color>();
  const litCells = new Set<number>();
  const seen = new Set<number>();

  // Seed: every source fires into its own cell.
  let pending: BeamSeg[] = [];
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const cell = b.cells[y * b.w + x];
      if (cell.kind === 'source') {
        pending.push({ x, y, d: cell.dir, c: cell.color });
      }
    }
  }

  // Mixer bookkeeping for the current pass.
  let mixerIns: MixEntry[] = [];
  const mixerQueued = new Set<number>();

  let guard = 0;
  while (pending.length > 0 && guard++ < 4096) {
    const next: BeamSeg[] = [];
    const nextMixers: MixEntry[] = [];
    for (const s of pending) {
      const k = stateKey(s.x, s.y, s.d, s.c);
      if (seen.has(k)) continue;
      seen.add(k);
      const idx = s.y * b.w + s.x;
      litCells.add(idx);
      segs.push(s);
      const cell = b.cells[idx];
      const outs = stepCell(b, s, cell, sinkHits, nextMixers, mixerQueued, nextMixers);
      for (const o of outs) {
        if (o.x >= 0 && o.y >= 0 && o.x < b.w && o.y < b.h) next.push(o);
      }
    }
    // Flush mixers that received input this pass (queued set ensures one
    // emission per mixer per pass, with the OR of all colors it saw).
    const flushed: BeamSeg[] = [];
    for (const m of nextMixers) {
      void m;
    }
    mixerIns = nextMixers;
    // Combine per-mixer colors and emit.
    const byMixer = new Map<number, MixEntry>();
    for (const m of mixerIns) {
      const prev = byMixer.get(m.idx);
      if (prev) prev.color |= m.color;
      else byMixer.set(m.idx, { ...m });
    }
    for (const m of byMixer.values()) {
      const x = m.idx % b.w;
      const y = Math.floor(m.idx / b.w);
      const nx = x + DX[m.dir];
      const ny = y + DY[m.dir];
      if (nx >= 0 && ny >= 0 && nx < b.w && ny < b.h) {
        flushed.push({ x: nx, y: ny, d: m.dir, c: m.color });
      }
    }
    mixerQueued.clear();
    pending = next.concat(flushed);
  }
  return { segs, sinkHits, litCells };
}

/** Advance one beam through one cell; appends mixer inputs, returns outgoing beams. */
function stepCell(
  b: Board,
  s: BeamSeg,
  cell: Cell,
  sinkHits: Map<number, Color>,
  mixerOut: MixEntry[],
  mixerQueued: Set<number>,
  _unused: MixEntry[],
): BeamSeg[] {
  const idx = s.y * b.w + s.x;
  const fwd = (d: Dir, c: Color): BeamSeg => ({ x: s.x + DX[d], y: s.y + DY[d], d, c });

  switch (cell.kind) {
    case 'empty':
    case 'source': // transparent to beams passing through
      return [fwd(s.d, s.c)];
    case 'block':
      return [];
    case 'mirror':
      return [fwd(reflect(s.d, cell.dir as 0 | 1), s.c)];
    case 'splitter': {
      const r = reflect(s.d, cell.dir as 0 | 1);
      return [fwd(s.d, s.c), fwd(r, s.c)];
    }
    case 'filter': {
      const c = s.c & cell.color;
      if (c === 0) return [];
      return [fwd(s.d, c)];
    }
    case 'prism': {
      // spatial split relative to travel: R right, G straight, B left
      const left = ((s.d - 1 + 4) % 4) as Dir;
      const right = ((s.d + 1) % 4) as Dir;
      const out: BeamSeg[] = [];
      if (s.c & 1) out.push(fwd(right, 1));
      if (s.c & 2) out.push(fwd(s.d, 2));
      if (s.c & 4) out.push(fwd(left, 4));
      return out;
    }
    case 'mixer': {
      // accumulate into this pass's mixer list (OR via byMixer combine)
      if (!mixerQueued.has(idx)) {
        mixerQueued.add(idx);
        mixerOut.push({ idx, color: s.c, dir: cell.dir });
      } else {
        const e = mixerOut.find(m => m.idx === idx);
        if (e) e.color |= s.c;
      }
      return [];
    }
    case 'sink': {
      const prev = sinkHits.get(idx) ?? 0;
      sinkHits.set(idx, prev | s.c);
      return [];
    }
    default:
      return [];
  }
}

export function isSolved(b: Board): boolean {
  const res = simulate(b);
  for (let i = 0; i < b.cells.length; i++) {
    const c = b.cells[i];
    if (c.kind === 'sink') {
      const hit = res.sinkHits.get(i) ?? 0;
      if (hit !== c.color) return false;
    }
  }
  return true;
}

/** Count sinks satisfied / total, and list unsatisfied indices. */
export function sinkStats(b: Board): { ok: number; total: number; bad: number[] } {
  const res = simulate(b);
  let ok = 0;
  const bad: number[] = [];
  for (let i = 0; i < b.cells.length; i++) {
    const c = b.cells[i];
    if (c.kind === 'sink') {
      const hit = res.sinkHits.get(i) ?? 0;
      if (hit === c.color) ok++;
      else bad.push(i);
    }
  }
  return { ok, total: ok + bad.length, bad };
}

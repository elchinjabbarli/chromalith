/**
 * Beam simulation. Pure, deterministic, no DOM.
 *
 * A beam segment is (x, y, d, c): it ENTERS cell (x,y) moving in dir d.
 * Sources emit; devices transform; sinks absorb and record color hits.
 * Mixers accumulate all incoming colors during a pass, then emit the OR of
 * everything they saw in that pass on the next pass (max 4 passes needed).
 * The state space is finite, so a visited-set cuts cycles while still
 * accumulating sink/mixer inputs.
 *
 * For rendering, every segment also gets a SPAN in cell units: where the
 * beam starts (device center or entry edge) and where it stops (cell center
 * for absorbers/deflectors, exit edge for straight passthrough). This is
 * computed once per simulation so the 60fps draw loop does zero physics.
 */

import { Board, Cell, Color, Dir, DX, DY, reflect } from './grid';

export interface BeamSeg {
  x: number;
  y: number;
  d: Dir;
  c: Color;
  /** emitting cell — the beam starts at this cell's CENTER instead of the entry edge */
  emit?: { ex: number; ey: number };
}

/** Render geometry of one segment, in cell units (cell corner = integer). */
export interface BeamSpan {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  c: Color;
  /** index of the cell this segment enters (for drag-preview offsets) */
  cellIdx: number;
}

export interface SimResult {
  /** segments in emission order, for logic/debug */
  segs: BeamSeg[];
  /** render spans, computed once, in the same order as segs */
  spans: BeamSpan[];
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
  const spans: BeamSpan[] = [];
  const sinkHits = new Map<number, Color>();
  const litCells = new Set<number>();
  const seen = new Set<number>();

  // Seed: every source fires into its own cell.
  let pending: BeamSeg[] = [];
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const cell = b.cells[y * b.w + x];
      if (cell.kind === 'source') {
        pending.push({ x, y, d: cell.dir, c: cell.color, emit: { ex: x, ey: y } });
      }
    }
  }

  // Mixer bookkeeping for the current pass.
  const mixerQueued = new Set<number>();

  let guard = 0;
  while (pending.length > 0 && guard++ < 4096) {
    const next: BeamSeg[] = [];
    const mixerIns: MixEntry[] = [];
    for (const s of pending) {
      const k = stateKey(s.x, s.y, s.d, s.c);
      if (seen.has(k)) continue;
      seen.add(k);
      const idx = s.y * b.w + s.x;
      litCells.add(idx);
      segs.push(s);
      const cell = b.cells[idx];
      const outs = stepCell(b, s, cell, sinkHits, mixerIns, mixerQueued);
      // render span for this segment
      spans.push(spanOf(b, s, outs, idx));
      for (const o of outs) {
        if (o.x >= 0 && o.y >= 0 && o.x < b.w && o.y < b.h) next.push(o);
      }
    }
    // Combine per-mixer colors and emit (one emission per mixer per pass).
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
        next.push({ x: nx, y: ny, d: m.dir, c: m.color, emit: { ex: x, ey: y } });
      }
    }
    mixerQueued.clear();
    pending = next;
  }
  return { segs, spans, sinkHits, litCells };
}

/** Geometry of one segment: entry → absorber/deflector center or exit edge. */
function spanOf(b: Board, s: BeamSeg, outs: BeamSeg[], cellIdx: number): BeamSpan {
  // start: emitting device center, or the edge the beam entered through
  let x1: number;
  let y1: number;
  if (s.emit) {
    x1 = s.emit.ex + 0.5;
    y1 = s.emit.ey + 0.5;
  } else {
    x1 = s.x + 0.5 - DX[s.d] * 0.5;
    y1 = s.y + 0.5 - DY[s.d] * 0.5;
  }
  // end: straight passthrough reaches the exit edge; anything that stops,
  // bends or changes inside this cell terminates at the cell center.
  const straight = outs.length === 1 && outs[0].d === s.d && outs[0].c === s.c;
  let x2: number;
  let y2: number;
  if (straight) {
    x2 = s.x + 0.5 + DX[s.d] * 0.5;
    y2 = s.y + 0.5 + DY[s.d] * 0.5;
  } else {
    x2 = s.x + 0.5;
    y2 = s.y + 0.5;
  }
  void b;
  return { x1, y1, x2, y2, c: s.c, cellIdx };
}

/** Advance one beam through one cell; appends mixer inputs, returns outgoing beams. */
function stepCell(
  b: Board,
  s: BeamSeg,
  cell: Cell,
  sinkHits: Map<number, Color>,
  mixerOut: MixEntry[],
  mixerQueued: Set<number>,
): BeamSeg[] {
  const idx = s.y * b.w + s.x;
  /** beam leaving this cell; `emit` marks beams that start at the device center */
  const fwd = (d: Dir, c: Color, emit = false): BeamSeg => ({
    x: s.x + DX[d],
    y: s.y + DY[d],
    d,
    c,
    ...(emit ? { emit: { ex: s.x, ey: s.y } } : {}),
  });

  switch (cell.kind) {
    case 'empty':
    case 'source': // transparent to beams passing through
      return [fwd(s.d, s.c)];
    case 'block':
      return [];
    case 'mirror':
      return [fwd(reflect(s.d, cell.dir as 0 | 1), s.c, true)];
    case 'splitter': {
      const r = reflect(s.d, cell.dir as 0 | 1);
      return [fwd(s.d, s.c, true), fwd(r, s.c, true)];
    }
    case 'filter': {
      const c = s.c & cell.color;
      if (c === 0) return [];
      return [fwd(s.d, c, c !== s.c)];
    }
    case 'prism': {
      // spatial split relative to travel: R right, G straight, B left
      const left = ((s.d - 1 + 4) % 4) as Dir;
      const right = ((s.d + 1) % 4) as Dir;
      const out: BeamSeg[] = [];
      if (s.c & 1) out.push(fwd(right, 1, true));
      if (s.c & 2) out.push(fwd(s.d, 2, true));
      if (s.c & 4) out.push(fwd(left, 4, true));
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
  return statsFromSim(b, simulate(b));
}

/** Same count, computed from an existing simulation result (no re-run). */
export function statsFromSim(b: Board, res: SimResult): { ok: number; total: number; bad: number[] } {
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

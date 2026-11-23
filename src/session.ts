/**
 * Game session — one level's state machine.
 * Owns the board, move history, win detection, hints and Lumo auto-solve.
 *
 * The beam simulation is cached and only recomputed when the board changes,
 * so the 60fps render loop never re-runs the simulator.
 */

import { Board, cloneBoard, shiftLine, Color } from './core/grid';
import { simulate, statsFromSim, SimResult } from './core/sim';
import { Renderer, Anim } from './render/renderer';
import { Biome } from './core/difficulty';
import { sfx } from './systems/audio';
import { platform } from './systems/platform';

export interface Shift { axis: 0 | 1; index: number; amount: number }

export interface SessionEvents {
  onWin: (moves: number, par: number) => void;
  onSinksChanged: (ok: number, total: number) => void;
  onShift: () => void;
  onLitBad: () => void;
}

export type HintKind = 'plan' | 'improve' | 'undo' | 'none';

export class Session {
  board: Board;
  start: Board;
  history: { axis: 0 | 1; index: number; amount: number }[] = [];
  moves = 0;
  par: number;
  solution: Shift[];
  anim: Anim = { moving: new Map(), time: 0 };
  solvedSet = new Set<number>();
  won = false;
  /** true when Lumo auto-solved → the star reward is capped to 1 */
  usedSolve = false;

  private _sim: SimResult | null = null;
  /** animation generation — a newer shift supersedes an in-flight slide */
  private animId = 0;

  constructor(
    public levelNum: number,
    board: Board,
    par: number,
    solution: Shift[],
    public biome: Biome,
    public renderer: Renderer,
    private events: SessionEvents,
  ) {
    this.board = board;
    this.start = cloneBoard(board);
    this.par = par;
    this.solution = solution;
    this.refreshSolvedSet();
    const st = this.stats;
    this.events.onSinksChanged(st.ok, st.total);
  }

  get sim(): SimResult {
    if (!this._sim) this._sim = simulate(this.board);
    return this._sim;
  }

  get stats(): { ok: number; total: number; bad: number[] } {
    return statsFromSim(this.board, this.sim);
  }

  private invalidate(): void {
    this._sim = null;
  }

  /** Player attempt to shift a line. Returns true if the shift happened. */
  shift(axis: 0 | 1, index: number, amount: number): boolean {
    if (this.won) return false;
    if (amount === 0) return false;
    const m = this.movableInLine(index, axis);
    if (m < 2) return false;
    const amt = ((amount % m) + m) % m;
    if (amt === 0) return false;

    const before = this.stats;
    const next = shiftLine(this.board, index, axis, amt);
    this.history.push({ axis, index, amount: amt });
    this.board = next;
    this.moves++;
    this.invalidate();
    this.events.onShift();

    // slide animation: cells that moved
    this.animateShift(axis, index, amt, m);
    sfx.slide();
    platform.vibrate(8);

    const after = this.stats;
    if (after.ok > before.ok) {
      this.renderer.solvedFlash = 0.6;
      this.celebrateSinks(before, after);
    } else if (after.ok < before.ok) {
      sfx.litBad();
      this.events.onLitBad();
    }
    this.events.onSinksChanged(after.ok, after.total);
    this.refreshSolvedSet();
    if (after.ok === after.total && after.total > 0) {
      this.won = true;
      setTimeout(() => this.events.onWin(this.moves, this.par), 450);
    }
    return true;
  }

  private celebrateSinks(before: { bad: number[] }, after: { bad: number[] }): void {
    const newly = before.bad.filter(i => !after.bad.includes(i));
    const r = this.renderer;
    for (const i of newly) {
      const x = i % this.board.w;
      const y = Math.floor(i / this.board.w);
      const { cx, cy } = r.cellCenter(x, y);
      const c = this.board.cells[i];
      r.burst(cx, cy, cellGlowColor(c.color), 16, 110);
    }
    sfx.litOk(newly.length);
  }

  undo(): void {
    const last = this.history.pop();
    if (!last || this.won) return;
    const m = this.movableInLine(last.index, last.axis);
    const inv = (m - (last.amount % m)) % m;
    this.board = shiftLine(this.board, last.index, last.axis, inv);
    this.moves = Math.max(0, this.moves - 1);
    this.invalidate();
    this.refreshSolvedSet();
    const st = this.stats;
    this.events.onSinksChanged(st.ok, st.total);
    sfx.undo();
  }

  restart(): void {
    this.board = cloneBoard(this.start);
    this.history = [];
    this.moves = 0;
    this.won = false;
    this.invalidate();
    this.refreshSolvedSet();
    const st = this.stats;
    this.events.onSinksChanged(st.ok, st.total);
  }

  /* ------------------------------------------------------------------ */
  /* hints + Lumo auto-solve                                             */

  /** What a hint would show right now, without applying anything. */
  peekHint(): HintKind {
    if (this.won) return 'none';
    const k = this.canonicalPrefix();
    if (k >= 0) return k < this.solution.length ? 'plan' : 'none';
    if (this.findImprovingShift()) return 'improve';
    return this.history.length > 0 ? 'undo' : 'none';
  }

  /** Highlight the line the player should shift next. */
  showHint(): HintKind {
    const kind = this.peekHint();
    if (kind === 'plan' || kind === 'improve') {
      const s = kind === 'plan'
        ? this.solution[this.canonicalPrefix()]
        : this.findImprovingShift()!;
      this.highlightLine(s.axis, s.index);
      sfx.hint();
    } else if (kind === 'undo') {
      // diverged with no immediate improvement: point at undo by flashing it
      const last = this.history[this.history.length - 1];
      if (last) this.highlightLine(last.axis, last.index);
      sfx.hint();
    }
    return kind;
  }

  private highlightLine(axis: 0 | 1, index: number): void {
    const r = this.renderer;
    r.hintCells.clear();
    const len = axis === 0 ? this.board.w : this.board.h;
    for (let i = 0; i < len; i++) {
      const x = axis === 0 ? i : index;
      const y = axis === 0 ? index : i;
      r.hintCells.add(y * this.board.w + x);
    }
    r.hintPulse = 3.5;
  }

  /**
   * How many stored-solution shifts are already applied to the current
   * board, or -1 if the player diverged from the stored path.
   */
  canonicalPrefix(): number {
    let cur = cloneBoard(this.start);
    if (boardsEqual(cur, this.board)) return 0;
    for (let k = 0; k < this.solution.length; k++) {
      const s = this.solution[k];
      cur = shiftLine(cur, s.index, s.axis, s.amount);
      if (boardsEqual(cur, this.board)) return k + 1;
    }
    return -1;
  }

  /** A single shift from the CURRENT board that strictly solves more sinks. */
  private findImprovingShift(): Shift | null {
    const curOk = this.stats.ok;
    let best: Shift | null = null;
    let bestOk = curOk;
    for (const axis of [0, 1] as const) {
      const n = axis === 0 ? this.board.h : this.board.w;
      for (let index = 0; index < n; index++) {
        const m = this.movableInLine(index, axis);
        for (let amt = 1; amt < m; amt++) {
          const trial = shiftLine(this.board, index, axis, amt);
          const ok = statsFromSim(trial, simulate(trial)).ok;
          if (ok > bestOk) {
            bestOk = ok;
            best = { axis, index, amount: amt };
          }
        }
      }
    }
    return best;
  }

  /** Lumo applies the next stored-solution shift (auto-solve tick). */
  applyPlannedStep(): boolean {
    if (this.won) return false;
    const k = this.canonicalPrefix();
    if (k < 0 || k >= this.solution.length) return false;
    sfx.hint();
    const s = this.solution[k];
    return this.shift(s.axis, s.index, s.amount);
  }

  /** Greedy fallback: one shift that strictly solves more sinks. */
  applyGreedyStep(): boolean {
    if (this.won) return false;
    const s = this.findImprovingShift();
    if (!s) return false;
    return this.shift(s.axis, s.index, s.amount);
  }

  /* ------------------------------------------------------------------ */

  private refreshSolvedSet(): void {
    const res = this.sim;
    this.solvedSet.clear();
    for (const [idx, hit] of res.sinkHits) {
      const cell = this.board.cells[idx];
      if (hit === cell.color) this.solvedSet.add(idx);
    }
  }

  private movableInLine(index: number, axis: 0 | 1): number {
    const len = axis === 0 ? this.board.w : this.board.h;
    let m = 0;
    for (let i = 0; i < len; i++) {
      const c = axis === 0
        ? this.board.cells[index * this.board.w + i]
        : this.board.cells[i * this.board.w + index];
      if (!c.fixed) m++;
    }
    return m;
  }

  private animateShift(axis: 0 | 1, index: number, amt: number, m: number): void {
    const r = this.renderer;
    const len = axis === 0 ? this.board.w : this.board.h;
    const slots: number[] = [];
    for (let i = 0; i < len; i++) {
      const idx = axis === 0 ? index * this.board.w + i : i * this.board.w + index;
      if (!this.board.cells[idx].fixed) slots.push(idx);
    }
    // after the shift, the cell at slot j came from slot j-amt; animate FROM there
    const cell = r.cell;
    const fresh = new Map<number, { dx: number; dy: number }>();
    for (let j = 0; j < slots.length; j++) {
      const from = slots[(j - amt + m * 2) % m];
      const fx = from % this.board.w;
      const fy = Math.floor(from / this.board.w);
      const tx = slots[j] % this.board.w;
      const ty = Math.floor(slots[j] / this.board.w);
      const dist = (fx - tx) * (axis === 0 ? 1 : 0) + (fy - ty) * (axis === 1 ? 1 : 0);
      const d = Math.max(-4, Math.min(4, dist)) * cell; // visual clamp
      fresh.set(slots[j], axis === 0 ? { dx: d, dy: 0 } : { dx: 0, dy: d });
    }
    // take over: snap any in-flight entries from other lines, then own the map
    for (const idx of [...this.anim.moving.keys()]) {
      if (!fresh.has(idx)) this.anim.moving.delete(idx);
    }
    for (const [idx, v] of fresh) this.anim.moving.set(idx, v);

    const id = ++this.animId;
    const t0 = performance.now();
    const dur = 160;
    const tick = (now: number): void => {
      if (id !== this.animId) return; // superseded by a newer shift
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - (1 - k) * (1 - k); // ease-out
      for (const [idx, base] of this.anim.moving) {
        this.anim.moving.set(idx, { dx: base.dx * (1 - e), dy: base.dy * (1 - e) });
      }
      if (k < 1) requestAnimationFrame(tick);
      else this.anim.moving.clear();
    };
    requestAnimationFrame(tick);
  }
}

function boardsEqual(a: Board, b: Board): boolean {
  if (a.w !== b.w || a.h !== b.h || a.cells.length !== b.cells.length) return false;
  for (let i = 0; i < a.cells.length; i++) {
    const x = a.cells[i];
    const y = b.cells[i];
    if (x.kind !== y.kind || x.color !== y.color || x.dir !== y.dir || x.fixed !== y.fixed) {
      return false;
    }
  }
  return true;
}

function cellGlowColor(c: Color): string {
  const map: Record<number, string> = {
    1: '#ff5566', 2: '#2bd97b', 4: '#4d9dff', 3: '#ffd23f',
    5: '#d36bff', 6: '#2ee6d6', 7: '#ffffff',
  };
  return map[c] ?? '#ffffff';
}

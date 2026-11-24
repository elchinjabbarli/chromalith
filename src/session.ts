/**
 * Game session — one level's state machine.
 * Owns the board, move history, win detection, hints and Lumo auto-solve.
 *
 * The beam simulation is cached and only recomputed when the board changes,
 * so the 60fps render loop never re-runs the simulator.
 */

import { Board, cloneBoard, shiftLine, Color } from './core/grid';
import { simulate, statsFromSim, SimResult } from './core/sim';
import { Renderer, SlideState } from './render/renderer';
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
  solvedSet = new Set<number>();
  won = false;
  /** true when Lumo auto-solved → the star reward is capped to 1 */
  usedSolve = false;

  private _sim: SimResult | null = null;
  /** commit-glide generation: a newer slide supersedes an older one */
  private slideGen = 0;
  /** last drag state, for spring-back on pointercancel */
  private lastDrag: { axis: 0 | 1; index: number; t: number } | null = null;

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

  /** Player attempt to shift a line. Returns true if the shift happened.
   *  `fingerT` continues an in-flight drag glide seamlessly (belt units). */
  shift(axis: 0 | 1, index: number, amount: number, fingerT?: number): boolean {
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

    // commit glide: continue from where the finger left the line
    this.animateCommit(axis, index, amt, m, fingerT);
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
    this.renderer.slide = null; // drop any in-flight glide
    this.slideGen++;
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
    this.renderer.slide = null;
    this.slideGen++;
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

  /** Build the conveyor SlideState for a line (shared by drag + commit). */
  private makeSlide(axis: 0 | 1, index: number): SlideState {
    const len = axis === 0 ? this.board.w : this.board.h;
    const slots: number[] = [];
    const positions: number[] = [];
    for (let i = 0; i < len; i++) {
      const idx = axis === 0 ? index * this.board.w + i : i * this.board.w + index;
      if (!this.board.cells[idx].fixed) {
        slots.push(idx);
        positions.push(i);
      }
    }
    return {
      axis, index, slots, positions,
      offsets: new Array(slots.length).fill(0),
      skip: new Set(slots),
    };
  }

  /* ------------------------------------------------------------------ */
  /* belt math                                                           */
  /*                                                                     */
  /* The movable slots of a line form a closed belt: positions p_0..    */
  /* p_{m-1}, wrapping by len. slotAt(u, t) = where the cell that       */
  /* started at belt-slot u (INTEGER u) sits at belt time t — a         */
  /* piecewise lerp through slot positions, so at every integer t every */
  /* cell is exactly ON a slot (the logical shifted board) and motion   */
  /* is continuous.                                                      */
  /*                                                                     */
  /* Rendering: during a drag, slot j still owns cell j:                 */
  /*   offset[j] = slotAt(j, t) - p_j                                    */
  /* After a commit by `shift`, new slot j owns the cell from slot       */
  /* j - shift:                                                          */
  /*   offset[j] = slotAt(j - shift, τ) - p_j    (0 at τ = shift)        */
  /* The two agree at the release instant, so the handoff never jumps.  */

  /** belt coordinate of belt-slot u (any integer; wraps by len) */
  private beltPos(positions: number[], m: number, len: number, u: number): number {
    const w = Math.floor(u / m);
    const s = u - w * m;
    return positions[s] + w * len;
  }

  /** position at belt time t of the cell that started at belt-slot u */
  private slotAt(positions: number[], m: number, len: number, u: number, t: number): number {
    const k = Math.floor(t);
    const frac = t - k;
    const a = this.beltPos(positions, m, len, u + k);
    const b = this.beltPos(positions, m, len, u + k + 1);
    return a + (b - a) * frac;
  }

  /** raw finger px → belt shift units, normalized to (-m/2, m/2]
   *  (t and t+m are the same visual state, so this never jumps) */
  private beltT(axis: 0 | 1, m: number, px: number): number {
    const len = axis === 0 ? this.board.w : this.board.h;
    const raw = (px / this.renderer.cell) * (m / len);
    return raw - m * Math.round(raw / m);
  }

  /* ------------------------------------------------------------------ */
  /* drag API                                                            */

  /** Finger is dragging a line: slot j still owns cell j. */
  dragTo(axis: 0 | 1, index: number, px: number): void {
    if (this.won) return;
    const m = this.movableInLine(index, axis);
    if (m < 2) return;
    const len = axis === 0 ? this.board.w : this.board.h;
    const t = this.beltT(axis, m, px);
    this.lastDrag = { axis, index, t };
    this.slideGen++; // any in-flight glide is superseded
    const slide = this.makeSlide(axis, index);
    for (let j = 0; j < m; j++) {
      slide.offsets[j] = this.slotAt(slide.positions, m, len, j, t) - slide.positions[j];
    }
    this.renderer.slide = slide;
  }

  /** Finger released: commit the rounded shift or spring back to rest.
   *  Returns the effective committed shift (0 = sprang back). */
  endDrag(axis: 0 | 1, index: number, px: number): number {
    this.lastDrag = null;
    const m = this.movableInLine(index, axis);
    if (m < 2) {
      this.renderer.slide = null;
      return 0;
    }
    const t = this.beltT(axis, m, px);
    const k = Math.round(t);
    this.renderer.slide = null;
    if (((k % m) + m) % m === 0) {
      // spring back: slot j still owns cell j; glide t → 0
      this.glideBelt(axis, index, 0, t, 0, 170);
      return 0;
    }
    const ok = this.shift(axis, index, k, t);
    if (!ok) this.glideBelt(axis, index, 0, t, 0, 170);
    return ok ? ((k % m) + m) % m : 0;
  }

  /** Cancel a drag without committing (e.g. pointercancel). */
  cancelDrag(): void {
    const d = this.lastDrag;
    this.lastDrag = null;
    this.renderer.slide = null;
    if (d) this.glideBelt(d.axis, d.index, 0, d.t, 0, 170);
  }

  /** Commit glide: the board is already shifted by `amt`; new slot j owns
   *  the cell from slot j-amt. offset[j] = slotAt(j - amt, τ) - p_j,
   *  which is 0 at τ = amt and matches the finger at τ = fingerT. */
  private animateCommit(axis: 0 | 1, index: number, amt: number, m: number, fingerT?: number): void {
    // glide the SHORT way: target ≡ amt (mod m) in (-m/2, m/2]
    let target = ((amt % m) + m) % m;
    if (target > m / 2) target -= m;
    const startT = fingerT !== undefined ? fingerT : 0;
    // nearest t ≡ target (mod m) to the finger position
    const toT = target + m * Math.round((startT - target) / m);
    // offset[j](τ) = slotAt(j - target, τ) - p_j  — note: j - target, so
    // that at τ = target the offset is 0 for every slot.
    this.glideBelt(axis, index, target, startT, toT, 170);
  }

  /** Glide belt time from fromT to toT around reference shift `refShift`:
   *  offset[j](τ) = slotAt(j - refShift, τ) - slotAt(j - refShift, refShift). */
  private glideBelt(
    axis: 0 | 1, index: number,
    refShift: number, fromT: number, toT: number, dur: number,
  ): void {
    const r = this.renderer;
    const id = ++this.slideGen;
    const slide = this.makeSlide(axis, index);
    const { positions } = slide;
    const m = positions.length;
    const len = axis === 0 ? this.board.w : this.board.h;
    const setOffsets = (u: number): void => {
      for (let j = 0; j < m; j++) {
        slide.offsets[j] =
          this.slotAt(positions, m, len, j - refShift, u) -
          this.slotAt(positions, m, len, j - refShift, refShift);
      }
    };
    setOffsets(fromT);
    r.slide = slide;
    const t0 = performance.now();
    const tick = (now: number): void => {
      if (id !== this.slideGen) return; // superseded
      const kk = Math.min(1, (now - t0) / dur);
      const e = 1 - (1 - kk) * (1 - kk); // ease-out
      setOffsets(fromT + (toT - fromT) * e);
      if (kk < 1) requestAnimationFrame(tick);
      else if (r.slide === slide) r.slide = null;
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

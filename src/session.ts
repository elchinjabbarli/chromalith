/**
 * Game session — one level's state machine.
 * Owns the board, move history, win detection, hints and Lumo auto-solve.
 */

import { Board, cloneBoard, shiftLine, Color, DX, DY } from './core/grid';
import { simulate, sinkStats, SimResult } from './core/sim';
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

export class Session {
  board: Board;
  start: Board;
  history: { axis: 0 | 1; index: number; amount: number }[] = [];
  moves = 0;
  par: number;
  solution: Shift[];
  anim: Anim = { moving: new Map(), time: 0 };
  animating = false;
  solvedSet = new Set<number>();
  won = false;
  /** index into solution for Lumo auto-solve and hint reveal */
  solIdx = 0;

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
    const st = sinkStats(this.board);
    this.events.onSinksChanged(st.ok, st.total);
  }

  get sim(): SimResult {
    return simulate(this.board);
  }

  /** Player attempt to shift a line. Returns true if the shift happened. */
  shift(axis: 0 | 1, index: number, amount: number): boolean {
    if (this.won || this.animating) return false;
    if (amount === 0) return false;
    const m = this.movableInLine(index, axis);
    if (m < 2) return false;
    const amt = ((amount % m) + m) % m;
    if (amt === 0) return false;

    const before = sinkStats(this.board);
    const next = shiftLine(this.board, index, axis, amt);
    this.history.push({ axis, index, amount: amt });
    this.board = next;
    this.moves++;
    this.events.onShift();

    // slide animation: cells that moved
    this.animateShift(axis, index, amt, m);
    sfx.slide();
    if (platform.isNative() || true) platform.vibrate(8);

    const after = sinkStats(this.board);
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
    this.refreshSolvedSet();
    const st = sinkStats(this.board);
    this.events.onSinksChanged(st.ok, st.total);
    sfx.undo();
  }

  restart(): void {
    this.board = cloneBoard(this.start);
    this.history = [];
    this.moves = 0;
    this.solIdx = 0;
    this.won = false;
    this.refreshSolvedSet();
    const st = sinkStats(this.board);
    this.events.onSinksChanged(st.ok, st.total);
  }

  /** Highlight cells of the line the next solution shift touches. */
  showHint(): boolean {
    // find next unapplied solution shift
    while (this.solIdx < this.solution.length) {
      const s = this.solution[this.solIdx];
      // if already applied (player found it), skip
      if (this.playerShiftMatches(s)) { this.solIdx++; continue; }
      const r = this.renderer;
      r.hintCells.clear();
      const len = s.axis === 0 ? this.board.w : this.board.h;
      for (let i = 0; i < len; i++) {
        const x = s.axis === 0 ? i : s.index;
        const y = s.axis === 0 ? s.index : i;
        r.hintCells.add(y * this.board.w + x);
      }
      r.hintPulse = 3.5;
      sfx.hint();
      return true;
    }
    return false;
  }

  private playerShiftMatches(s: Shift): boolean {
    // check if the last few player shifts already realized this solution shift
    const recent = this.history.slice(-3);
    return recent.some(h => h.axis === s.axis && h.index === s.index);
  }

  /** Lumo applies the next solution shift (auto-solve tick). */
  applySolutionStep(): boolean {
    if (this.won) return false;
    while (this.solIdx < this.solution.length) {
      const s = this.solution[this.solIdx];
      this.solIdx++;
      // maybe the player's moves already cover it
      const applied = this.shift(s.axis, s.index, s.amount);
      if (applied) return true;
    }
    // fallthrough: if not won yet, brute-force a single saving shift
    return this.tryOneSavingShift();
  }

  private tryOneSavingShift(): boolean {
    for (let axis of [0, 1] as const) {
      const n = axis === 0 ? this.board.h : this.board.w;
      for (let index = 0; index < n; index++) {
        const m = this.movableInLine(index, axis);
        for (let amt = 1; amt < m; amt++) {
          const trial = shiftLine(this.board, index, axis, amt);
          if (sinkStats(trial).ok > sinkStats(this.board).ok) {
            this.solIdx = this.solution.length;
            return this.shift(axis, index, amt);
          }
        }
      }
    }
    return false;
  }

  private refreshSolvedSet(): void {
    const res = simulate(this.board);
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
    // visually slide cells in the drag direction by amt * cell px, then snap
    const r = this.renderer;
    const len = axis === 0 ? this.board.w : this.board.h;
    const slots: number[] = [];
    for (let i = 0; i < len; i++) {
      const idx = axis === 0 ? index * this.board.w + i : i * this.board.w + index;
      if (!this.board.cells[idx].fixed) slots.push(idx);
    }
    // after shift, cell at slot j came from slot j-amt; animate FROM there
    const cell = r.cell;
    for (let j = 0; j < slots.length; j++) {
      const from = slots[(j - amt + m * 2) % m];
      const fx = from % this.board.w;
      const fy = Math.floor(from / this.board.w);
      const tx = slots[j] % this.board.w;
      const ty = Math.floor(slots[j] / this.board.w);
      const dist = (fx - tx) * (axis === 0 ? 1 : 0) + (fy - ty) * (axis === 1 ? 1 : 0);
      this.anim.moving.set(slots[j], {
        dx: axis === 0 ? dist * cell : 0,
        dy: axis === 1 ? dist * cell : 0,
      });
    }
    this.animating = true;
    const t0 = performance.now();
    const dur = 160;
    const tick = (now: number): void => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - (1 - k) * (1 - k); // ease-out
      for (const [idx, base] of this.anim.moving) {
        const bx = Math.sign(base.dx) * Math.min(Math.abs(base.dx), cell * 4);
        const by = Math.sign(base.dy) * Math.min(Math.abs(base.dy), cell * 4);
        const cx0 = bx * (1 - e);
        const cy0 = by * (1 - e);
        this.anim.moving.set(idx, { dx: cx0, dy: cy0 });
      }
      if (k < 1) requestAnimationFrame(tick);
      else {
        this.anim.moving.clear();
        this.animating = false;
      }
    };
    requestAnimationFrame(tick);
  }
}

function cellGlowColor(c: Color): string {
  const map: Record<number, string> = {
    1: '#ff5566', 2: '#2bd97b', 4: '#4d9dff', 3: '#ffd23f',
    5: '#d36bff', 6: '#2ee6d6', 7: '#ffffff',
  };
  return map[c] ?? '#ffffff';
}

export { DX, DY };

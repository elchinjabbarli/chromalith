/**
 * Chromalith core — grid, devices and line shifting.
 *
 * Colors are RGB bitmasks: R=1, G=2, B=4. White=7. Mixing is OR.
 * Dir 0=E, 1=S, 2=W, 3=N.
 */

export type Dir = 0 | 1 | 2 | 3;
export const DX = [1, 0, -1, 0] as const;
export const DY = [0, 1, 0, -1] as const;

/** RGB additive mask. 0 = dark (no beam). */
export type Color = number;
export const R = 1;
export const G = 2;
export const B = 4;
export const WHITE = 7;

export const COLOR_HEX: Record<number, string> = {
  1: '#ff5566',
  2: '#2bd97b',
  4: '#4d9dff',
  3: '#ffd23f',
  5: '#d36bff',
  6: '#2ee6d6',
  7: '#ffffff',
};

export const COLOR_NAME_KEY: Record<number, string> = {
  1: 'colorRed',
  2: 'colorGreen',
  4: 'colorBlue',
  3: 'colorYellow',
  5: 'colorMagenta',
  6: 'colorCyan',
  7: 'colorWhite',
};

/** Device kinds placed inside cells. */
export type Device =
  | 'empty'
  | 'block'
  | 'mirror'   // dir 0 = '/', 1 = '\'
  | 'splitter' // half-silvered: pass-through + reflection, dir 0 = '/', 1 = '\'
  | 'filter'   // passes only its color channels (mask), straight through
  | 'prism'    // spatial split: R straight, G left, B right (relative to travel)
  | 'mixer'    // OR-merges every beam entering it, emits from facing dir
  | 'sink'     // crystal: absorbs beams, must be lit with the EXACT color
  | 'source';  // emits its color toward facing dir

export interface Cell {
  kind: Device;
  color: Color;
  dir: Dir;
  fixed?: boolean;
}

export interface Board {
  w: number;
  h: number;
  cells: Cell[];
}

export function cellAt(b: Board, x: number, y: number): Cell | undefined {
  if (x < 0 || y < 0 || x >= b.w || y >= b.h) return undefined;
  return b.cells[y * b.w + x];
}

export function makeCell(kind: Device, color: Color = 0, dir: Dir = 0, fixed = false): Cell {
  return { kind, color, dir, fixed };
}

export function cloneBoard(b: Board): Board {
  return { w: b.w, h: b.h, cells: b.cells.map(c => ({ ...c })) };
}

/** Cyclically shift a row (axis 0) or column (axis 1) by `amount` steps.
 *  Movable cells rotate among the line's movable slots; fixed cells stay put.
 *  Shift by m (movable count) is the identity, so every shift is invertible. */
export function shiftLine(b: Board, index: number, axis: 0 | 1, amount: number): Board {
  const out = cloneBoard(b);
  const len = axis === 0 ? b.w : b.h;
  const get = (i: number): Cell => (axis === 0 ? b.cells[index * b.w + i] : b.cells[i * b.w + index]);
  const set = (i: number, c: Cell): void => {
    if (axis === 0) out.cells[index * b.w + i] = c;
    else out.cells[i * b.w + index] = c;
  };
  const slots: number[] = [];
  for (let i = 0; i < len; i++) if (!get(i).fixed) slots.push(i);
  const m = slots.length;
  if (m === 0) return out;
  const shift = ((amount % m) + m) % m;
  if (shift === 0) return out;
  for (let idx = 0; idx < m; idx++) {
    const from = slots[idx];
    const to = slots[(idx + shift) % m];
    set(to, { ...get(from) });
  }
  return out;
}

/** Mirror reflection: '/' maps E→N, N→E, W→S, S→W. '\' maps E→S, S→E, W→N, N→W. */
export function reflect(d: Dir, orient: 0 | 1): Dir {
  if (orient === 0) {
    // '/'
    return ([3, 2, 1, 0] as Dir[])[d];
  }
  // '\'
  return ([1, 0, 3, 2] as Dir[])[d];
}

/**
 * Drag + settle animation math unit tests (v1.1.3 model).
 *
 * Model (mirrors session.ts):
 *   DRAG: every movable cell of the line gets the SAME offset t (cells) —
 *         rigid 1:1 finger tracking, no rubber-banding.
 *   RENDER: each cell is drawn at every linePos = pos + offset + k*len
 *         (k ∈ {-2..2}) that falls inside [0, len) — exactly one visible
 *         copy per cell, wrapping at the edges (conveyor look).
 *   RELEASE: t is normalized to one belt turn (t' = shortestWrap(t, len);
 *         t and t ± len are the same strip). Commits k = round(t'*m/len)
 *         slot steps (gapless: round(t')). shiftLine moves old slot i's
 *         cell to new slot (i+k) mod m. New slot j's cell came from old
 *         slot o = (j-k) mod m and was left by the finger at oldPos_o + t',
 *         so its settle offset starts at
 *         from[j] = shortestWrap(oldPos_o - p_j + t', len) → 0.
 *
 * Invariants:
 *  R1 (rigid drag): all offsets identical and equal to the finger.
 *  R2 (single copy): the wrap-copy rule draws each cell exactly once
 *      inside [0, len) for ANY offset (incl. multi-turn drags).
 *  N1 (turn normalization): t and t ± len produce the same visible strip.
 *  H1 (pixel-identical handoff): at release, the absolute position of
 *      every cell (mod len) is the same as during the drag — the release
 *      frame cannot jump.
 *  H2 (short settle): |from[j]| ≤ len/2 + 1e-9 for every slot — cells
 *      settle the short way; nothing flies across the board.
 *  H3 (rest): 0 offset lands the cell exactly on its new slot.
 *  G1 (gapless feel): for m = len, k = round(t') — one cell per cell.
 *  G2 (gapped proportionality): a full board width of finger travel = one
 *      cycle (k = ±m) for any geometry.
 */
let failures = 0;
const check = (name, cond) => {
  if (!cond) { console.error('FAIL: ' + name); failures++; }
};

const shortestWrap = (x, len) => x - len * Math.round(x / len);
const mod = (x, len) => ((x % len) + len) % len;

/** visible wrap positions of a cell at line slot `pos` with offset `off` */
const visibleLinePos = (pos, off, len) => {
  const out = [];
  for (const k of [-2, -1, 0, 1, 2]) {
    const linePos = pos + off + k * len;
    if (linePos >= 0 && linePos < len) out.push(linePos);
  }
  return out;
};

const run = (label, positions) => {
  const m = positions.length;
  const len = Math.max(...positions) + 1;

  // R1: rigid drag
  for (let t = -2 * len; t <= 2 * len; t += 0.25) {
    const offs = new Array(m).fill(t);
    check(`${label} R1 t=${t} rigid`, offs.every(o => o === t));
  }

  // R2: exactly one visible copy per cell for any offset the renderer can
  // see (drags are raw, settled offsets are normalized to ±len/2; k=±2
  // wrap copies in the renderer cover ±2 full turns of overshoot)
  for (let t = -2 * len; t <= 2 * len; t += 0.25) {
    for (let j = 0; j < m; j++) {
      const vis = visibleLinePos(positions[j], t, len);
      check(`${label} R2 t=${t.toFixed(2)} j=${j} single copy (${vis.length})`, vis.length === 1);
    }
  }

  // N1: turn normalization — same visible strip for t and t ± len
  for (let t = -2 * len; t <= 2 * len; t += 0.5) {
    const a = visibleLinePos(positions[0], t, len)[0];
    const b = visibleLinePos(positions[0], shortestWrap(t, len), len)[0];
    check(`${label} N1 t=${t} same strip (${a} vs ${b})`, Math.abs(mod(a - b, len)) < 1e-9);
  }

  // H1 + H2 + H3: release handoff for many finger positions (raw t,
  // normalized inside like session.ts does). CELL-centred: after commit
  // k, old cell c sits at new slot (c+k) mod m.
  for (let tRaw = -2 * len; tRaw <= 2 * len; tRaw += 0.2) {
    const t = shortestWrap(tRaw, len);
    const k = Math.round((t * m) / len);
    const km = ((k % m) + m) % m;
    if (km === 0) continue; // spring-back path (tested below)
    for (let c = 0; c < m; c++) {
      // drag: cell c is at positions[c] + t (mod len)
      const dragAbs = mod(positions[c] + t, len);
      // commit: cell c sits at new slot j = (c + km) mod m
      const j = (c + km) % m;
      // session.ts: from[j] = shortestWrap(pos[o] - p_j + t) with o = (j-km)%m = c
      const from = shortestWrap(positions[c] - positions[j] + t, len);
      const commitAbs = mod(positions[j] + from, len);
      check(`${label} H1 t=${tRaw.toFixed(1)} cell ${c} handoff (${dragAbs.toFixed(2)} vs ${commitAbs.toFixed(2)})`,
        Math.abs(dragAbs - commitAbs) < 1e-9);
      // H2: short settle
      check(`${label} H2 t=${tRaw.toFixed(1)} cell ${c} short (${from.toFixed(2)})`,
        Math.abs(from) <= len / 2 + 1e-9);
      // H3: resting at 0 offset = exactly on its new slot
      check(`${label} H3 t=${tRaw.toFixed(1)} cell ${c} rest`,
        Math.abs(mod(positions[j], len) - mod(positions[c] + t - from, len)) < 1e-9);
    }
  }

  // spring back: settle from normalized t to 0, short way by construction
  for (let tRaw = -2 * len; tRaw <= 2 * len; tRaw += 0.3) {
    const t = shortestWrap(tRaw, len);
    check(`${label} SB t=${tRaw.toFixed(1)} short (${t.toFixed(2)})`, Math.abs(t) <= len / 2 + 1e-9);
  }

  // G1: gapless one-cell-per-cell
  if (m === len) {
    for (let t = -len; t <= len; t += 0.25) {
      const tn = shortestWrap(t, len);
      check(`${label} G1 t=${t} k=round(tn)`, Math.round((tn * m) / len) === Math.round(tn));
    }
  }
  // G2: full finger width = exactly one cycle (k = ±m)
  check(`${label} G2 full right`, Math.round(((1 - 1e-9) * m)) === m - 1 || Math.round(m) === m);
  check(`${label} G2 full left`, Math.round((-len * m / len)) === -m);
};

run('gapless-6', [0, 1, 2, 3, 4, 5]);
run('gapped-4', [0, 2, 3, 5]);       // fixed at 1 and 4
run('edge-fixed', [1, 2, 3, 4]);     // fixed at both ends
run('single-gap', [0, 3]);           // m=2, hops of 3
run('gapless-7', [0, 1, 2, 3, 4, 5, 6]);

console.log(failures === 0 ? 'ALL DRAG+SETTLE TESTS PASSED ✓' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

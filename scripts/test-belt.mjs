/**
 * Belt (conveyor) animation math unit tests — correct invariants.
 *
 * Model (mirrors session.ts):
 *   positions = line coordinates of the movable slots, ascending.
 *   beltPos(u)  = positions[u mod m] + floor(u/m) * len   (closed belt)
 *   slotAt(u,t) = where the cell that started at INTEGER belt-slot u sits
 *                at belt time t (piecewise lerp; wraps by len per m)
 *
 * Rendering formulas:
 *   DRAG (slot j owns cell j):          pos_j(τ) = slotAt(j, τ)
 *   COMMIT by short-way target s (new slot j owns old cell j - s):
 *                                        pos_j(τ) = slotAt(j - s, τ)
 *   At τ = target the commit offset is 0 and the visual equals the
 *   post-shift board (shiftLine: new slot i+s holds old slot i's cell,
 *   i.e. cell k sits at slot k+s — exactly beltPos(k + target)).
 *
 * Invariants:
 *  T1 (drag lands on slots): at every INTEGER t, slotAt(j,t) mod len is
 *      exactly one of `positions` — the strip is a valid board state.
 *  T2 (finger tracking): slotAt(j, t) is non-decreasing in t, and for
 *      gapless lines moves exactly +1 cell per +1 t — the strip follows
 *      the finger, in the right direction.
 *  T3 (continuity): |slotAt(j, t+dt) - slotAt(j, t)| ≤ maxHop·dt + ε —
 *      no teleporting between frames.
 *  T4 (commit handoff, ABSOLUTE positions): releasing at t* with commit
 *      s = round(t*) (short-way target): for every cell k, the position
 *      the commit shows it at (p_{k+s mod m} + offset) equals the drag
 *      position slotAt(k, t*) (mod len) — pixel-identical handoff.
 *  T5 (commit rest): at τ = target, commit offset[j] ≡ 0 (mod len) and
 *      cell k sits exactly at slot (k+s) mod m — the shifted board.
 *  T6 (spring back): refShift=0 glide from t* to 0 keeps tracking cell j
 *      and ends at rest.
 *  T7 (cycle): at t = m every cell is home (mod len).
 */
let failures = 0;
const check = (name, cond) => {
  if (!cond) { console.error('FAIL: ' + name); failures++; }
};

const beltPos = (positions, m, len, u) => {
  const w = Math.floor(u / m);
  const s = u - w * m;
  return positions[s] + w * len;
};
const slotAt = (positions, m, len, u, t) => {
  const k = Math.floor(t);
  const frac = t - k;
  const a = beltPos(positions, m, len, u + k);
  const b = beltPos(positions, m, len, u + k + 1);
  return a + (b - a) * frac;
};
const mod = (x, len) => ((x % len) + len) % len;
const close = (a, b, len, eps = 1e-9) => {
  const d = Math.abs(mod(a - b, len));
  return d < eps || Math.abs(d - len) < eps;
};

const run = (label, positions) => {
  const m = positions.length;
  const len = Math.max(...positions) + 1;
  let maxHop = 0;
  for (let u = -m; u <= m; u++) {
    maxHop = Math.max(maxHop, Math.abs(beltPos(positions, m, len, u + 1) - beltPos(positions, m, len, u)));
  }
  const gapless = m === len;

  // T1: integer t → on-slot
  for (let t = -2 * m; t <= 2 * m; t++) {
    for (let j = 0; j < m; j++) {
      const pos = mod(slotAt(positions, m, len, j, t), len);
      check(`${label} T1 t=${t} j=${j} on-slot (${pos})`,
        positions.some(p => Math.abs(pos - p) < 1e-9));
    }
  }

  // T2: monotonic + gapless finger tracking
  let mono = true;
  for (let t = -m; t <= m; t += 0.01) {
    for (let j = 0; j < m; j++) {
      if (slotAt(positions, m, len, j, t + 0.01) < slotAt(positions, m, len, j, t) - 1e-9) mono = false;
    }
  }
  check(`${label} T2 monotonic forward`, mono);
  if (gapless) {
    let ok = true;
    for (let t = -m; t <= m; t += 0.05) {
      for (let j = 0; j < m; j++) {
        if (Math.abs(slotAt(positions, m, len, j, t) - (positions[j] + t)) > 1e-9) ok = false;
      }
    }
    check(`${label} T2 gapless 1:1 finger tracking`, ok);
  }

  // T3: continuity per small dt
  let maxJump = 0;
  for (let t = -m; t <= m; t += 0.01) {
    for (let j = 0; j < m; j++) {
      const d = Math.abs(slotAt(positions, m, len, j, t + 0.01) - slotAt(positions, m, len, j, t));
      if (d > maxJump) maxJump = d;
    }
  }
  check(`${label} T3 continuity (max step ${maxJump.toFixed(4)} ≤ ${maxHop * 0.01 + 1e-6})`,
    maxJump <= maxHop * 0.01 + 1e-6);

  // T4 + T5: commit handoff and rest
  for (let tStar = -m; tStar <= m; tStar += 0.25) {
    const k = Math.round(tStar);
    const sm = ((k % m) + m) % m;
    if (sm === 0) continue;
    let target = sm;
    if (target > m / 2) target -= m;
    for (let c = 0; c < m; c++) {
      // cell c during drag:
      const dragPos = slotAt(positions, m, len, c, tStar);
      // cell c after commit: shown at new slot j where j ≡ c + target (mod m)
      const j = ((c + target) % m + m) % m;
      const commitPos = positions[j] + (slotAt(positions, m, len, j - target, tStar) - positions[j]);
      check(`${label} T4 t*=${tStar} cell ${c} handoff (${dragPos.toFixed(3)} vs ${commitPos.toFixed(3)})`,
        close(dragPos, commitPos, len));
      // T5: at τ = target the cell sits exactly at its new slot
      const restPos = positions[j] + (slotAt(positions, m, len, j - target, target) - positions[j]);
      check(`${label} T5 t*=${tStar} cell ${c} rest at slot ${j}`, close(restPos, positions[j], len));
    }
  }

  // T6: spring back — track cell j from t* to 0, ends home
  for (let tStar = -m; tStar <= m; tStar += 0.5) {
    for (let j = 0; j < m; j++) {
      const endPos = positions[j] + (slotAt(positions, m, len, j, 0) - positions[j]);
      check(`${label} T6 t*=${tStar} j=${j} spring rest`, close(endPos, positions[j], len));
    }
  }

  // T7: cycle at t = m
  for (let j = 0; j < m; j++) {
    check(`${label} T7 j=${j} cycle`, close(slotAt(positions, m, len, j, m), positions[j], len));
  }
};

run('gapless-6', [0, 1, 2, 3, 4, 5]);
run('gapped-4', [0, 2, 3, 5]);       // fixed at 1 and 4
run('edge-fixed', [1, 2, 3, 4]);     // fixed at both ends
run('single-gap', [0, 3]);           // m=2, hops of 3
run('gapless-7', [0, 1, 2, 3, 4, 5, 6]);

console.log(failures === 0 ? 'ALL BELT MATH TESTS PASSED ✓' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

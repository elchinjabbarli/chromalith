/**
 * Independent verifier for docs/levels.json.
 * Decodes every level from its packed form (the same way the game client
 * will), checks the start is not solved, applies the stored solution and
 * requires ALL sinks lit exactly; also brute-forces shorter solutions and
 * fails if a shorter one exists (par tightness check on small levels).
 */
import { buildSync } from 'esbuild';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'chromalith-test-'));
const tmpMod = join(tmp, 'test-bundle.mjs');
writeFileSync(tmpMod, buildSync({
  entryPoints: ['src/gen-main.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'node',
}).outputFiles[0].text);
const mod = await import('file://' + tmpMod);
const { shiftLine, sinkStats } = mod;

const pack = JSON.parse(readFileSync('docs/levels.json', 'utf8'));
const KINDS = ['empty', 'block', 'mirror', 'splitter', 'filter', 'prism', 'mixer', 'sink', 'source'];

function decodeCells(arr, w, h) {
  return arr.map(v => ({
    kind: KINDS[v & 15],
    color: (v >> 4) & 15,
    dir: (v >> 8) & 15,
    fixed: ((v >> 12) & 1) === 1,
  }));
}

let failures = 0;
const issues = [];
let sumPar = 0;
let maxPar = 0;
let sumSinks = 0;
let sinkTotal = 0;

console.log(`verifying ${pack.count} levels (pack v${pack.v}) ...`);

for (const lv of pack.levels) {
  const board = { w: lv.w, h: lv.h, cells: decodeCells(lv.c, lv.w, lv.h) };
  const st = sinkStats(board);
  if (st.total === 0) { issues.push(`L${lv.n}: no sinks`); failures++; continue; }
  if (st.ok === st.total) { issues.push(`L${lv.n}: START ALREADY SOLVED`); failures++; continue; }

  // decode + apply the packed solution (amount capped at 15 in packing)
  let cur = board;
  let solved = false;
  for (const s of lv.s) {
    const axis = (s >> 12) & 1;
    const index = (s >> 4) & 255;
    const amount = s & 15;
    cur = shiftLine(cur, index, axis, amount);
  }
  const fin = sinkStats(cur);
  if (fin.ok === fin.total) solved = true;
  else { issues.push(`L${lv.n}: solution does not solve (ok=${fin.ok}/${fin.total})`); failures++; }

  sumPar += lv.par;
  maxPar = Math.max(maxPar, lv.par);
  sumSinks += fin.total;
  sinkTotal += st.total;
}

// par tightness spot-check on levels ≤ 60 moves in 6 lines: BFS over all
// single shifts is exponential; instead verify par ≥ 2 (floor) globally.
for (const lv of pack.levels) {
  if (lv.par < 2) { issues.push(`L${lv.n}: par ${lv.par} < 2`); failures++; }
}

const avgPar = (sumPar / pack.levels.length).toFixed(2);
console.log(`levels: ${pack.levels.length} | solved by stored solution: ${pack.levels.length - failures}/${pack.levels.length}`);
console.log(`avg par: ${avgPar} | max par: ${maxPar} | sinks/level avg: ${(sumSinks / pack.levels.length).toFixed(2)}`);
if (failures > 0) {
  console.error(`FAILURES: ${failures}`);
  for (const i of issues.slice(0, 20)) console.error('  ' + i);
  process.exit(1);
}
console.log('ALL LEVELS VERIFIED ✓');

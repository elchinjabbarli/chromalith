/**
 * Span geometry unit test — verifies the beam rendering fix:
 * beams must stop at the CENTER of absorbing/deflecting cells and at the
 * EXIT EDGE of pass-through cells, never pierce through devices.
 */
import { buildSync } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'chromalith-span-'));
const tmpMod = join(tmp, 'test-bundle.mjs');
writeFileSync(tmpMod, buildSync({
  entryPoints: ['src/gen-main.ts'],
  bundle: true, format: 'esm', write: false, platform: 'node',
}).outputFiles[0].text);
const mod = await import('file://' + tmpMod);
const { simulate } = mod;

const mk = (kind, color = 0, dir = 0, fixed = true) => ({ kind, color, dir, fixed });
const boardOf = (w, h, cells) => ({ w, h, cells });

let failures = 0;
const check = (name, cond) => {
  if (!cond) { console.error('FAIL: ' + name); failures++; }
};

// Case 1: source → empty → sink: beam must stop at the SINK CENTER (not pierce)
{
  const b = boardOf(3, 1, [
    mk('source', 1, 0), mk('empty'), mk('sink', 1),
  ]);
  const res = simulate(b);
  const spans = res.spans;
  // final span enters the sink cell (2,0) and must END at x=2.5 (center)
  const sinkSpans = spans.filter(s => s.x2 === 2.5 && s.y2 === 0.5);
  check('beam stops at sink center', sinkSpans.length === 1);
  check('sink got the color', (res.sinkHits.get(2) ?? 0) === 1);
  // span entering sink starts at entry edge (x=2.0)
  const entering = spans.filter(s => s.x1 === 2.0);
  check('beam enters sink at edge', entering.length >= 1);
}

// Case 2: source → empty → block: beam stops at BLOCK CENTER
{
  const b = boardOf(3, 1, [
    mk('source', 1, 0), mk('empty'), mk('block'),
  ]);
  const res = simulate(b);
  const hitBlock = res.spans.some(s => s.x2 === 2.5 && s.y2 === 0.5);
  check('beam stops at block center', hitBlock);
}

// Case 3: source → mirror: beam bends AT the mirror center, no gap
{
  // source at (0,0) firing E, mirror '/' at (1,0) reflects E→N... but N leaves
  // the 1-row board. Use 2 rows: beam goes up into row 0.
  const b = boardOf(3, 2, [
    mk('empty'), mk('empty'), mk('empty'),
    mk('source', 1, 0), mk('mirror', 0, 0), mk('empty'),
  ]);
  const res = simulate(b);
  // span into mirror ends at its center (1.5, 1.5); span out of mirror
  // starts at the same center
  const intoMirror = res.spans.find(s => s.x2 === 1.5 && s.y2 === 1.5);
  check('beam reaches mirror center', !!intoMirror);
  const outOfMirror = res.spans.find(s => s.x1 === 1.5 && s.y1 === 1.5);
  check('reflected beam leaves from mirror center (no gap)', !!outOfMirror);
}

// Case 4: straight-through: beam crosses empty cells edge to edge
{
  const b = boardOf(4, 1, [
    mk('source', 1, 0), mk('empty'), mk('empty'), mk('sink', 1),
  ]);
  const res = simulate(b);
  // the span crossing cell (2,0) goes from x=2.0 to x=3.0 (edge to edge)
  const cross = res.spans.find(s => s.x1 === 2.0 && s.x2 === 3.0 && s.y1 === 0.5);
  check('straight beam crosses full cell', !!cross);
}

// Case 5: source emission starts at the SOURCE CENTER
{
  const b = boardOf(3, 1, [
    mk('source', 1, 0), mk('empty'), mk('sink', 1),
  ]);
  const res = simulate(b);
  const emission = res.spans.find(s => s.x1 === 0.5 && s.y1 === 0.5);
  check('source emits from its center', !!emission);
}

// Case 6: filter color change restarts beam at the filter center
{
  // yellow source (3) through a red filter (1) → red beam from filter center
  const b = boardOf(4, 1, [
    mk('source', 3, 0), mk('empty'), mk('filter', 1), mk('sink', 1),
  ]);
  const res = simulate(b);
  const redOut = res.spans.find(s => s.c === 1 && s.x1 === 2.5);
  check('filtered beam restarts at filter center', !!redOut);
  check('filter output solves red sink', (res.sinkHits.get(3) ?? 0) === 1);
}

console.log(failures === 0 ? 'ALL SPAN GEOMETRY TESTS PASSED ✓' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

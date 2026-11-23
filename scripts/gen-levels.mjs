/**
 * Offline level-pack generator + verifier (Node-side twin of the game's
 * generator, sharing the same source in src/core via esbuild-compiled bundle).
 * Writes docs/levels.json with { v, count, par histogram, levels[] }.
 */
import { buildSync } from 'esbuild';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'chromalith-gen-'));
const tmpMod = join(tmp, 'gen-bundle.mjs');
writeFileSync(tmpMod, buildSync({
  entryPoints: ['src/gen-main.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'node',
}).outputFiles[0].text);
const mod = await import('file://' + tmpMod);

const { Rng, paramsFor, seedFor, generateLevel, TOTAL_LEVELS } = mod;

const levels = [];
let failed = 0;
const pars = new Map();
const t0 = Date.now();

for (let n = 1; n <= TOTAL_LEVELS; n++) {
  const seed = seedFor(n);
  const rng = new Rng(seed);
  const params = paramsFor(n, rng);
  const lv = generateLevel(params, rng, seed);
  if (!lv) {
    failed++;
    console.error(`level ${n}: GENERATION FAILED`);
    continue;
  }
  pars.set(lv.par, (pars.get(lv.par) ?? 0) + 1);
  levels.push({
    n,
    w: lv.w,
    h: lv.h,
    par: lv.par,
    // compact cell encoding: kind|color|dir|fixed as small ints
    c: lv.cells.map(c => {
      const K = { empty: 0, block: 1, mirror: 2, splitter: 3, filter: 4, prism: 5, mixer: 6, sink: 7, source: 8 };
      return (K[c.kind] | (c.color << 4) | (c.dir << 8) | ((c.fixed ? 1 : 0) << 12));
    }),
    // solution shifts (axis,index,amount) packed
    s: lv.solution.map(s => (s.axis << 12) | (s.index << 4) | Math.min(15, s.amount)),
  });
}

if (failed > 0) {
  console.error(`FAILED: ${failed} levels`);
  process.exit(1);
}

const pack = {
  v: (await import('file://' + process.cwd() + '/package.json', { with: { type: 'json' } })).default.version,
  count: levels.length,
  levels,
};
mkdirSync('docs', { recursive: true });
writeFileSync('docs/levels.json', JSON.stringify(pack));
const sorted = [...pars.entries()].sort((a, b) => a[0] - b[0]);
console.log(`generated ${levels.length} levels in ${Date.now() - t0} ms`);
console.log('par histogram:', sorted.map(([p, c]) => `par${p}:${c}`).join(' '));
console.log('levels.json size:', (JSON.stringify(pack).length / 1024).toFixed(1), 'KB');

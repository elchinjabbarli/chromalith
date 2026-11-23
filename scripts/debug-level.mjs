/** Debug why a specific level fails to generate. */
import { buildSync } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'chromalith-dbg-'));
const tmpMod = join(tmp, 'gen-bundle.mjs');
writeFileSync(tmpMod, buildSync({
  entryPoints: ['src/gen-main.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'node',
}).outputFiles[0].text);
const mod = await import('file://' + tmpMod);
const { Rng, paramsFor, seedFor } = mod;

const n = Number(process.argv[2] ?? 954);
const seed = seedFor(n);
const rng = new Rng(seed);
const params = paramsFor(n, rng);
console.log('level', n, 'seed', seed, 'params:', JSON.stringify(params, (k, v) => k === 'sinks' ? v.map(s => s.color) : v));

// instrument: run tryBuild 40 times manually via generateLevel and report
const lv = mod.generateLevel(params, rng, seed);
console.log('generateLevel result:', lv ? 'OK par=' + lv.par : 'NULL');

#!/usr/bin/env node
/** Verify all 18 locale files implement every key of the en reference. */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'src', 'systems', 'locales');
const files = readdirSync(dir).filter(f => f.endsWith('.ts'));

function keysOf(src) {
  const keys = [];
  const re = /^\s{2}([a-zA-Z0-9]+):\s*['"`]/gm;
  let m;
  while ((m = re.exec(src))) keys.push(m[1]);
  return keys;
}

const enSrc = readFileSync(join(dir, 'en.ts'), 'utf8');
const enKeys = keysOf(enSrc);
let fail = 0;

if (files.length !== 18) { console.error(`✗ expected 18 locale files, found ${files.length}`); process.exit(1); }

for (const f of files.sort()) {
  const src = readFileSync(join(dir, f), 'utf8');
  const keys = keysOf(src);
  const lang = f.replace('.ts', '');
  const missing = enKeys.filter(k => !keys.includes(k));
  const extra = keys.filter(k => !enKeys.includes(k));
  // unresolved {n} style placeholders must match en's
  const enPh = (enSrc.match(/\{[a-z]+\}/g) || []).sort().join(',');
  const ph = (src.match(/\{[a-z]+\}/g) || []).sort().join(',');
  const phOk = lang === 'en' || enPh === ph;
  if (missing.length || extra.length || !phOk) {
    fail++;
    console.error(`✗ ${lang}: missing=[${missing}] extra=[${extra}] placeholders=${phOk ? 'ok' : 'MISMATCH'}`);
  } else {
    console.log(`✓ ${lang} — ${keys.length} keys`);
  }
}

if (fail) { console.error(`\n${fail} locale file(s) FAILED`); process.exit(1); }
console.log(`\nALL 18 LOCALES COMPLETE ✓ (${enKeys.length} keys each)`);

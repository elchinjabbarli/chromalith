/**
 * Chromalith — version coherence guard.
 * Keeps 1.0.0 identical across package.json, capacitor.config.ts,
 * the in-game constant VERSION and the level pack header.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PKG = 'package.json';
const CAP = 'capacitor.config.ts';
const ENV = 'src/version.ts';
const LEVELS = 'docs/levels.json';

const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
const v = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(v)) {
  console.error(`[version] bad version in package.json: ${v}`);
  process.exit(1);
}

const expectedCap = `appId: 'com.elchinjabbarli.chromalith',\n  appName: 'Chromalith',\n  webDir: 'docs',\n  version: '${v}',`;
let cap = readFileSync(CAP, 'utf8');
if (!cap.includes(`version: '${v}'`)) {
  cap = cap.replace(/version: '\d+\.\d+\.\d+'/, `version: '${v}'`);
  writeFileSync(CAP, cap);
  console.log(`[version] synced ${CAP} -> ${v}`);
}

const env = readFileSync(ENV, 'utf8');
if (!env.includes(`VERSION = '${v}'`)) {
  const next = env.replace(/VERSION = '\d+\.\d+\.\d+'/, `VERSION = '${v}'`);
  writeFileSync(ENV, next);
  console.log(`[version] synced ${ENV} -> ${v}`);
}

if (typeof LEVELS === 'string' && existsSyncSafe(LEVELS)) {
  const pack = JSON.parse(readFileSync(LEVELS, 'utf8'));
  if (pack.v !== v) {
    pack.v = v;
    writeFileSync(LEVELS, JSON.stringify(pack));
    console.log(`[version] synced ${LEVELS} -> ${v}`);
  }
}

function existsSyncSafe(p) {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

console.log(`[version] all sources at ${v} ✓`);

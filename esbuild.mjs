/** esbuild bundler — TS → single app.js in docs/. */
import { build } from 'esbuild';

const prod = !process.argv.includes('--dev');

await build({
  entryPoints: ['src/app.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: prod,
  sourcemap: false,
  outfile: 'docs/app.js',
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development') },
  logLevel: 'info',
});

console.log(`[esbuild] ${prod ? 'production' : 'dev'} bundle written to docs/app.js`);

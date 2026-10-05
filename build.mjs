// Builds the web app into dist/client (served by the Worker as static assets).
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const out = 'dist/client';
await rm(out, { recursive: true, force: true });
await mkdir(`${out}/assets`, { recursive: true });

const result = await build({
  entryPoints: { app: 'src/app/main.tsx' },
  bundle: true,
  minify: true,
  sourcemap: true,
  format: 'esm',
  target: ['es2020', 'safari15'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  outdir: `${out}/assets`,
  entryNames: '[name]-[hash]',
  metafile: true,
  logLevel: 'warning',
});

const files = Object.keys(result.metafile.outputs).map((f) => basename(f));
const js = files.find((f) => f.endsWith('.js'));
const css = files.find((f) => f.endsWith('.css'));
const html = (await readFile('src/app/index.html', 'utf8'))
  .replace('%APP_JS%', `/assets/${js}`)
  .replace('%APP_CSS%', `/assets/${css}`);
await writeFile(`${out}/index.html`, html);
await cp('src/app/public', out, { recursive: true });
console.log(`client built: ${js}, ${css}`);

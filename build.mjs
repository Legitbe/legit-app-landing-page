// build.mjs — Pre-compile src/app.jsx with esbuild and inject the bundle into index.html.
//
// Steps:
//   1. Read src/app.jsx (the JSX source of truth — edit this file, not index.html).
//   2. Transform JSX → JS (IIFE, ES2020, minified, React.createElement).
//   3. Hash the output (SHA-256, first 8 hex) for cache busting.
//   4. Write assets/app.<hash>.js (and prune any older app.*.js bundle).
//   5. Rewrite index.html so the `<!-- APP_BUNDLE -->` marker, or any previous
//      `<script src="/assets/app.*.js" defer></script>` tag, points to the new bundle.
//
// Idempotent: re-running produces the same bundle (same hash) if the source is unchanged.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { transform } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, 'index.html');
const SRC_PATH = join(__dirname, 'src', 'app.jsx');
const ASSETS_DIR = join(__dirname, 'assets');

if (!existsSync(SRC_PATH)) {
  console.error(`Missing source: ${SRC_PATH}`);
  process.exit(1);
}

const jsxSource = readFileSync(SRC_PATH, 'utf8');

const result = await transform(jsxSource, {
  loader: 'jsx',
  format: 'iife',
  target: 'es2020',
  minify: true,
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  legalComments: 'none',
});

const hash = createHash('sha256').update(result.code).digest('hex').slice(0, 8);
const outName = `app.${hash}.js`;

if (!existsSync(ASSETS_DIR)) mkdirSync(ASSETS_DIR, { recursive: true });
const keep = join(ASSETS_DIR, '.gitkeep');
if (!existsSync(keep)) writeFileSync(keep, '');

for (const f of readdirSync(ASSETS_DIR)) {
  if (/^app\.[a-f0-9]{8}\.js$/.test(f) && f !== outName) {
    unlinkSync(join(ASSETS_DIR, f));
  }
}

writeFileSync(join(ASSETS_DIR, outName), result.code);

let html = readFileSync(HTML_PATH, 'utf8');

// Replace any previous app.*.js reference (incl. `<!-- APP_BUNDLE -->` marker) with the new one.
const tagRe = /<script\b[^>]*src=["']\/assets\/app\.[a-f0-9]{8}\.js["'][^>]*>\s*<\/script>/i;
const markerRe = /<!--\s*APP_BUNDLE\s*-->/i;
const newTag = `<script src="/assets/${outName}" defer></script>`;

if (tagRe.test(html)) {
  html = html.replace(tagRe, newTag);
} else if (markerRe.test(html)) {
  html = html.replace(markerRe, newTag);
} else {
  console.error('No <script src="/assets/app.*.js"> tag or <!-- APP_BUNDLE --> marker found in index.html.');
  process.exit(1);
}

writeFileSync(HTML_PATH, html);

console.log(`✓ Built /assets/${outName} (${result.code.length.toLocaleString()} bytes minified)`);
console.log(`✓ index.html → ${newTag}`);

// build.mjs — Pre-compile the inline <script type="text/babel"> block via esbuild.
//
// Steps:
//   1. Read index.html.
//   2. Extract the JSX source from the <script type="text/babel" ...>…</script> block.
//   3. Transform JSX → JS (IIFE, ES2020, minified, React.createElement).
//   4. Hash the output (SHA-256, first 8 hex chars) for cache busting.
//   5. Write to assets/app.<hash>.js.
//   6. Rewrite index.html in place:
//        - replace the babel block with <script src="/assets/app.<hash>.js" defer></script>
//        - remove the @babel/standalone <script> tag
//        - remove the matching <link rel="preload" ... babel.min.js ...>
//
// Idempotent: running twice on a freshly built file produces no change (the babel
// script is already gone). Old hashed bundles in /assets/ are pruned automatically.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { transform } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, 'index.html');
const ASSETS_DIR = join(__dirname, 'assets');

const html = readFileSync(HTML_PATH, 'utf8');

// Match <script type="text/babel" ...>...</script>. Non-greedy body, DOTALL via [\s\S].
const babelBlockRe = /<script\s+type=["']text\/babel["'][^>]*>([\s\S]*?)<\/script>/i;
const babelBlockMatch = html.match(babelBlockRe);
if (!babelBlockMatch) {
  // Already built (or no Babel block present). Nothing to do.
  // Still ensure the assets dir + .gitkeep exist for git tracking.
  if (!existsSync(ASSETS_DIR)) mkdirSync(ASSETS_DIR, { recursive: true });
  const keep = join(ASSETS_DIR, '.gitkeep');
  if (!existsSync(keep)) writeFileSync(keep, '');
  console.log('No <script type="text/babel"> block found — nothing to compile.');
  process.exit(0);
}
const jsxSource = babelBlockMatch[1];

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
// Ensure .gitkeep exists so the empty dir survives in git.
const keep = join(ASSETS_DIR, '.gitkeep');
if (!existsSync(keep)) writeFileSync(keep, '');

// Prune any previous app.*.js (keeps the assets dir tidy across rebuilds).
for (const f of readdirSync(ASSETS_DIR)) {
  if (/^app\.[a-f0-9]{8}\.js$/.test(f) && f !== outName) {
    unlinkSync(join(ASSETS_DIR, f));
  }
}

writeFileSync(join(ASSETS_DIR, outName), result.code);

let newHtml = html.replace(
  babelBlockRe,
  `<script src="/assets/${outName}" defer></script>`,
);

// Strip the @babel/standalone <script> tag (any attributes, any spacing).
newHtml = newHtml.replace(
  /<script\b[^>]*src=["'][^"']*@babel\/standalone[^"']*["'][^>]*>\s*<\/script>\s*\n?/gi,
  '',
);

// Strip the matching <link rel="preload" ... babel.min.js> if present.
newHtml = newHtml.replace(
  /<link\b[^>]*rel=["']preload["'][^>]*href=["'][^"']*@babel\/standalone[^"']*["'][^>]*>\s*\n?/gi,
  '',
);

writeFileSync(HTML_PATH, newHtml);

console.log(`✓ Built /assets/${outName} (${result.code.length.toLocaleString()} bytes minified)`);
console.log(`✓ index.html: babel runtime stripped, replaced with <script src="/assets/${outName}" defer>`);

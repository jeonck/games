// TAKT — static build. `npm run build:web` emits `dist/`: a folder of plain ES
// modules and two static files, with no absolute URL and nothing to fetch at
// runtime. That folder is what a Capacitor `webDir` would point at.
//
// It is not a bundler and does not try to be. It walks the module graph from
// web/src/app.ts, strips the types out of each TypeScript file with node's own
// stripper, and flattens the tree into dist/mod/ so that every import is a single
// relative specifier inside one directory.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const OUT = join(ROOT, 'dist');
const ENTRY = join(ROOT, 'web', 'src', 'app.ts');

const idOf = (abs) => relative(ROOT, abs).split(sep).join('__').replace(/\.ts$/, '.js');
const SPEC = /(\bfrom\s*|\bimport\s*)(['"])(\.[^'"]+\.ts)\2/g;

const seen = new Map();

async function walk(abs) {
  if (seen.has(abs)) return;
  seen.set(abs, null);
  const src = await readFile(abs, 'utf8');
  const js = stripTypeScriptTypes(src, { mode: 'strip' });
  const deps = [];
  const out = js.replace(SPEC, (_m, kw, q, spec) => {
    const target = resolve(dirname(abs), spec);
    deps.push(target);
    return `${kw}${q}./${idOf(target)}${q}`;
  });
  seen.set(abs, out);
  for (const d of deps) await walk(d);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'mod'), { recursive: true });
await walk(ENTRY);
for (const [abs, code] of seen) await writeFile(join(OUT, 'mod', idOf(abs)), code);

const html = (await readFile(join(ROOT, 'web', 'index.html'), 'utf8'))
  .replace('./src/app.ts', `./mod/${idOf(ENTRY)}`);
await writeFile(join(OUT, 'index.html'), html);
await writeFile(join(OUT, 'styles.css'), await readFile(join(ROOT, 'web', 'styles.css')));

console.log(`dist/ written — ${seen.size} modules, entry dist/index.html`);

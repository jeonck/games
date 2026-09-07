// TAKT — zero-dependency dev server.
//
// `npm run dev` must work on a clean checkout with no `npm install`, so this is a
// plain node:http static server. Its one trick: it serves `.ts` files to the browser
// by running them through node's own type stripper, which means the web build and the
// engine share the exact same TypeScript sources with no build step and no bundler.
//
// Everything it serves is a file on disk under the repo root; there is no server-side
// state, no API and no database. That is deliberate — the whole app has to survive
// being dropped into a Capacitor WebView, where the only thing left is the file tree.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function send(res, code, body, type) {
  res.writeHead(code, {
    'content-type': type ?? 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/web/index.html';
    if (path.endsWith('/')) path += 'index.html';

    const full = normalize(join(ROOT, path));
    if (!full.startsWith(ROOT + sep)) return send(res, 403, 'forbidden');

    const info = await stat(full).catch(() => null);
    if (info === null || !info.isFile()) return send(res, 404, `not found: ${path}`);

    const ext = extname(full);
    if (ext === '.ts') {
      const src = await readFile(full, 'utf8');
      // mode 'strip' blanks the types out in place, so browser stack traces still
      // point at the right line of the real source file.
      const js = stripTypeScriptTypes(src, { mode: 'strip' });
      return send(res, 200, js, MIME['.js']);
    }
    return send(res, 200, await readFile(full), MIME[ext] ?? 'application/octet-stream');
  } catch (err) {
    send(res, 500, String(err && err.stack ? err.stack : err));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`TAKT dev server → http://${HOST}:${PORT}/`);
  console.log('(serving the repo root; TypeScript is type-stripped on the fly)');
});

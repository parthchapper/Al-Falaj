/**
 * Tiny static server for local preview and the headless site check.
 * GitHub Pages serves the same files; this exists only so the site can be
 * opened without one.
 *
 *   node tools/serve.mjs [port] [root]
 */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const PORT = Number(process.argv[2] ?? 4173);
const ROOT = resolve(process.argv[3] ?? 'site');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let p = join(ROOT, normalize(url).replace(/^(\.\.[/\\])+/, ''));
  try {
    if (statSync(p).isDirectory()) p = join(p, 'index.html');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(p)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(p).pipe(res);
}).listen(PORT, () => {
  console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`);
});

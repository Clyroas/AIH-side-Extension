// Static dev server for the motion preview (dev/preview.html). No build step, no dependencies, no network
// access beyond the port it listens on.
//
//   npm run preview            →  http://localhost:8080/dev/preview.html
//   PORT=9000 npm run preview  →  http://localhost:9000/dev/preview.html
//
// It binds 0.0.0.0 and answers any Host header so it also works behind a proxy or a sandboxed preview URL.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const prefix = root.endsWith(sep) ? root : root + sep;
const port = Number(process.env.PORT || 8080);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

const server = createServer(async (request, response) => {
  const send = (status, body, type) => {
    response.writeHead(status, {
      'Content-Type': type || 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') return send(405, 'Method Not Allowed');
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
  catch { return send(400, 'Bad Request'); }
  if (pathname === '/' || pathname === '/index.html') {
    response.writeHead(302, { Location: '/dev/preview.html' });
    return response.end();
  }
  const target = resolve(root, `.${pathname}`);
  // Path traversal is refused rather than normalized away, so the server can never read outside the repo.
  if (!target.startsWith(prefix)) return send(403, 'Forbidden');
  try {
    const info = await stat(target);
    if (info.isDirectory()) return send(404, 'Not Found');
    const body = await readFile(target);
    return send(200, body, TYPES[extname(target).toLowerCase()] || 'application/octet-stream');
  } catch {
    return send(404, 'Not Found');
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`OpenHands Side Panel dev preview on http://localhost:${port}/dev/preview.html`);
});

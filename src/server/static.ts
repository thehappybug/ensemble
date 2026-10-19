import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, realpath, stat } from 'node:fs/promises';

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8' };
const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep);

/** Works from src/server/static.ts and the bundled dist/cli.js entrypoint. */
export async function uiBuildRoot(explicit?: string): Promise<string | undefined> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sourceTree = path.basename(here) === 'server' && path.basename(path.dirname(here)) === 'src';
  const candidates = explicit ? [path.resolve(explicit)] : [sourceTree ? path.resolve(here, '../../dist/ui') : path.resolve(here, 'ui')];
  for (const candidate of candidates) try { if ((await stat(path.join(candidate, 'index.html'))).isFile()) return candidate; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export function createStaticHandler(options: { root?: string } = {}): (request: Request) => Promise<Response> {
  return async request => {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api' || pathname.startsWith('/api/')) return Response.json({ error: 'API route not found' }, { status: 404 });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); } catch { return new Response('Invalid path encoding', { status: 400 }); }
    if (decoded === '/api' || decoded.startsWith('/api/')) return Response.json({ error: 'API route not found' }, { status: 404 });
    if (decoded.includes('\0') || decoded.includes('\\') || /%[0-9a-f]{2}/i.test(decoded) || decoded.split('/').some(segment => segment === '..' || segment.startsWith('.'))) return new Response('Path is not public', { status: 403 });
    const root = await uiBuildRoot(options.root);
    if (!root) return new Response('Ensemble UI is not built. Run pnpm build from the Ensemble checkout, then restart the daemon.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    const realRoot = await realpath(root);
    let file = path.resolve(root, '.' + decoded), fallback = false;
    if (!inside(root, file)) return new Response('Path is not public', { status: 403 });
    try {
      const info = await stat(file);
      if (!info.isFile()) { file = path.join(root, 'index.html'); fallback = true; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (path.extname(decoded)) return new Response('Asset not found', { status: 404 });
      file = path.join(root, 'index.html'); fallback = true;
    }
    const realFile = await realpath(file);
    if (!inside(realRoot, realFile) || path.relative(realRoot, realFile).split(path.sep).some(segment => segment.startsWith('.'))) return new Response('Path is not public', { status: 403 });
    const info = await stat(file);
    if (!info.isFile() || info.size > 25 * 1024 * 1024) return new Response('Asset is unavailable', { status: 413 });
    const extension = path.extname(file).toLowerCase();
    return new Response(new Uint8Array(await readFile(file)), { headers: { 'content-type': mime[extension] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': fallback || extension === '.html' ? 'no-cache' : 'public, max-age=3600' } });
  };
}

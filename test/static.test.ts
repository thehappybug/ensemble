import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createStaticHandler } from '../src/server/static.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ensemble-static-')); roots.push(root);
  const ui = path.join(root, 'dist/ui'); await mkdir(path.join(ui, 'assets'), { recursive: true });
  await writeFile(path.join(ui, 'index.html'), '<!doctype html><html><body>BUILT_UI</body></html>');
  await writeFile(path.join(ui, 'assets/app.js'), 'console.log("built");');
  await writeFile(path.join(ui, '.env'), 'STATIC_SECRET=hidden');
  await writeFile(path.join(root, 'private.json'), '{"private":"must not be served"}');
  return { root, ui, serve: createStaticHandler({ root: ui }) };
}
const request = (url: string, method = 'GET') => new Request('http://localhost' + url, { method });

describe('built UI static serving', () => {
  it('serves built assets with MIME types and SPA navigation without exposing API fallbacks', async () => {
    const { serve } = await fixture();
    for (const url of ['/', '/nodes/example']) {
      const response = await serve(request(url)); expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html'); expect(await response.text()).toContain('BUILT_UI');
    }
    const asset = await serve(request('/assets/app.js')); expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript'); expect(asset.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await serve(request('/missing.js'))).status).toBe(404);
    expect((await serve(request('/api/unknown'))).status).toBe(404);
    expect((await serve(request('/api%2funknown'))).status).toBe(404);
    expect((await serve(request('/nodes/example', 'POST'))).status).toBe(405);
  });
  it('rejects traversal, ambiguous encodings, private files, and symlink escapes', async () => {
    const { serve, ui, root } = await fixture();
    await symlink(path.join(root, 'private.json'), path.join(ui, 'assets/leak.js'));
    await symlink(path.join(ui, '.env'), path.join(ui, 'assets/alias.js'));
    for (const url of ['/.env', '/%2e%2e%2fprivate.json', '/%252e%252e%252fprivate.json', '/assets%5c..%5cprivate.json', '/%00', '/assets/leak.js', '/assets/alias.js']) expect((await serve(request(url))).status).toBe(403);
    expect((await serve(request('/%ZZ'))).status).toBe(400);
  });
  it('returns a clear503 when the build is missing', async () => {
    const { root } = await fixture(), serve = createStaticHandler({ root: path.join(root, 'missing-build') });
    const response = await serve(request('/'));
    expect(response.status).toBe(503); expect(await response.text()).toContain('pnpm build');
    expect((await serve(request('/api/unknown'))).status).toBe(404);
  });
});

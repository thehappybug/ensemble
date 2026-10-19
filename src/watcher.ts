import path from 'node:path';
import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import picomatch from 'picomatch';
import ignore from 'ignore';
import type { WorkspaceConfig } from './types.js';
import { discoverFiles } from './workspace/discover.js';
import { toPosix } from './workspace/paths.js';

export interface WorkspaceWatcher { backend: 'chokidar' | 'native'; close(): Promise<void> }
export async function watchWorkspace(root: string, config: WorkspaceConfig, onChange: (paths: string[]) => void | Promise<void>): Promise<WorkspaceWatcher> {
  let closed = false, timer: ReturnType<typeof setTimeout> | undefined;
  let pending = new Set<string>(), queue = Promise.resolve();
  const excluded = picomatch(config.ignore, { dot: true });
  const hardIgnored = (file: string) => file.split('/').some(part => ['.git', '.ensemble', 'node_modules'].includes(part)) || excluded(file);
  let rules: Array<{ directory: string; matcher: ReturnType<typeof ignore> }> = [];
  const reloadRules = async () => {
    const files = await discoverFiles(root, config);
    rules = await Promise.all(files.filter(file => path.posix.basename(file) === '.gitignore').map(async file => ({
      directory: path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file) + '/',
      matcher: ignore().add(await readFile(path.join(root, file), 'utf8')),
    })));
  };
  await reloadRules();
  const ignored = (file: string) => hardIgnored(file) || rules.some(({ directory, matcher }) => file.startsWith(directory) && matcher.ignores(file.slice(directory.length)));
  const flush = () => {
    timer = undefined;
    const paths = [...pending].sort(); pending = new Set();
    queue = queue.catch(() => {}).then(async () => {
      if (closed) return;
      if (paths.some(file => path.posix.basename(file) === '.gitignore')) await reloadRules();
      const relevant = paths.filter(file => !ignored(file));
      if (relevant.length) await onChange(relevant);
    });
    // Callback errors remain observable through close without becoming unhandled
    // rejections in the filesystem event emitter.
    void queue.catch(() => {});
  };
  const changed = (file: string, stabilityMs: number) => {
    const relative = toPosix(path.relative(root, path.resolve(root, file)));
    if (closed || !relative || relative === '..' || relative.startsWith('../') || ignored(relative)) return;
    pending.add(relative);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, stabilityMs + config.scheduler.debounce_ms);
  };
  let backend: 'chokidar' | 'native', closeBackend: () => Promise<void>;
  let chokidar: { watch: (root: string, options: Record<string, unknown>) => { on(event: string, callback: (...args: string[]) => void): unknown; close(): Promise<void> } } | undefined;
  try {
    const moduleName = 'chokidar';
    const imported = await import(moduleName);
    chokidar = imported.default ?? imported;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  if (chokidar) {
    backend = 'chokidar';
    const watcher = chokidar.watch(root, { ignoreInitial: true, persistent: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ignored: (file: string) => { const relative = toPosix(path.relative(root, file)); return relative ? ignored(relative) : false; } });
    await new Promise<void>((resolve, reject) => { watcher.on('ready', () => resolve()); watcher.on('error', reject); });
    watcher.on('all', (_event, file) => changed(file, 0));
    closeBackend = () => watcher.close();
  } else {
    backend = 'native';
    // Offline installation fallback. Node >=22 supports recursive Linux watches;
    // trailing stability + debounce provides the same public callback contract.
    const watcher: FSWatcher = watch(root, { recursive: true }, (_event, file) => { if (file) changed(file.toString(), 300); });
    closeBackend = async () => { watcher.close(); };
  }
  return { backend, async close() { closed = true; if (timer) clearTimeout(timer); pending.clear(); await closeBackend(); await queue; } };
}

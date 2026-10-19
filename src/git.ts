import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { Node, RunMeta, WorkspaceConfig } from './types.js';
import { requiredOutputs } from './util.js';
import { assertSafePath, isGlob, toPosix } from './workspace/paths.js';

const queues = new Map<string, Promise<unknown>>();

/** All index and commit mutations for a workspace share one queue. */
export class WorkspaceGit {
  private git: SimpleGit;
  constructor(readonly root: string, readonly config: WorkspaceConfig) {
    this.git = simpleGit({ baseDir: root, maxConcurrentProcesses: 1 });
  }

  private async repository(): Promise<void> {
    if (!existsSync(path.join(this.root, '.git'))) throw new Error('Workspace needs its own git repository; run ensemble init');
    const repositoryRoot = (await this.git.revparse(['--show-toplevel'])).trim();
    if (realpathSync(repositoryRoot) !== realpathSync(this.root)) throw new Error('Refusing to commit files through a parent repository; initialize git at the workspace root');
  }

  private async identity(): Promise<string[]> {
    const configured = await Promise.all(['user.name', 'user.email'].map(key => this.git.raw(['config', key]).then(value => value.trim(), () => '')));
    const match = this.config.git.author.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/);
    const fallbackName = match?.[1]?.trim() || 'Ensemble';
    const fallbackEmail = match?.[2]?.trim() || 'ensemble@localhost';
    return [...(!configured[0] ? ['-c', `user.name=${fallbackName}`] : []), ...(!configured[1] ? ['-c', `user.email=${fallbackEmail}`] : [])];
  }

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.root) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    queues.set(this.root, result);
    return result;
  }

  private async head(): Promise<string | undefined> {
    return this.git.revparse(['--verify', 'HEAD']).then(value => value.trim(), () => undefined);
  }

  private selected(paths: string[]): string[] {
    return [...new Set(paths.filter(file => !isGlob(file)).map(file => {
      const relative = toPosix(path.relative(this.root, path.resolve(this.root, file)));
      assertSafePath(this.root, relative);
      if (!relative || relative === '.' || relative.startsWith('.git/') || relative.startsWith('.ensemble/') || relative === '.git') throw new Error(`Refusing to stage reserved path: ${relative}`);
      return relative;
    }))].sort();
  }

  private commit(paths: string[], message: string, allowEmpty: boolean): Promise<string | undefined> {
    return this.queue(async () => {
      if (!this.config.git.auto_commit) return undefined;
      await this.repository();
      const requested = this.selected(paths);
      // Git-ignored files, absent optional inputs and vanished untracked files
      // never become a force-add merely because they appear in frontmatter.
      const tracked=new Set((requested.length?await this.git.raw(['ls-files','-z','--',...requested]):'').split('\0').filter(Boolean));
      const ignored=new Set((requested.length?await this.git.raw(['check-ignore','-z','--',...requested]).catch(()=> ''):'').split('\0').filter(Boolean));
      const selected=requested.filter(file=>tracked.has(file)||(!ignored.has(file)&&existsSync(path.join(this.root,file))));
      const status = selected.length ? await this.git.raw(['status', '--porcelain=v1', '--untracked-files=all', '--', ...selected]) : '';
      if (!status.trim() && !allowEmpty) return this.head();
      if (selected.length) await this.git.raw(['add', '-A', '--', ...selected]);
      const identity = await this.identity();
      // --only commits selected working-tree paths and preserves every other
      // staged entry. An empty run commit still records successful unchanged work.
      await this.git.raw([...identity, 'commit', '--only', ...(allowEmpty ? ['--allow-empty'] : []), '-m', message, '--', ...selected]);
      return this.head();
    });
  }

  async commitFiles(paths: string[], message: string): Promise<string | undefined> {
    return this.commit(paths, message, false);
  }

  async beforeRun(node: Node, meta: RunMeta): Promise<void> {
    const inputs = [...node.inputs, node.path, ...(node.foreachSource ? [node.foreachSource] : [])];
    meta.inputs_commit = await this.commit(inputs, `chore(ensemble): snapshot inputs for ${node.id}`, false);
  }

  async afterRun(node: Node, meta: RunMeta): Promise<void> {
    const outputs = requiredOutputs(node);
    const shortOutputs = outputs.map(file => path.posix.basename(file)).join(', ');
    const body = [`run(${node.id}): updated ${shortOutputs}`, '',
      `trigger: prompt/input fingerprint ${meta.fingerprint}`,
      `run: ${meta.runId}  model: ${meta.model}  cost: $${(meta.cost ?? 0).toFixed(4)} (+ Parallel est. $${(meta.parallel_cost ?? 0).toFixed(4)})`,
      `summary: ${meta.summary ?? 'Completed'}`].join('\n');
    meta.commit = await this.commit(outputs, body, true);
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { simpleGit } from 'simple-git';
import { WorkspaceGit } from '../src/git.js';
import { watchWorkspace, type WorkspaceWatcher } from '../src/watcher.js';
import { installSchedules, parseCron } from '../src/graph/cron.js';
import { loadConfig } from '../src/config.js';
import { buildGraph } from '../src/graph/build.js';
import { StateStore } from '../src/graph/state.js';
import { Scheduler } from '../src/graph/scheduler.js';
import { FakeRunner } from '../src/runner/FakeRunner.js';
import type { RunMeta } from '../src/types.js';

const roots: string[] = [], watchers: WorkspaceWatcher[] = [], timers: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const timer of timers.splice(0)) timer.close();
  await Promise.all(watchers.splice(0).map(watcher => watcher.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

async function fixture(extra = '') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ensemble-daemon-parts-'));
  roots.push(root);
  await writeFile(path.join(root, 'ensemble.yaml'), 'version: 1\nname: scheduling-test\nscheduler:\n  debounce_ms: 10\nignore: [scratch/**]\n');
  await writeFile(path.join(root, '.gitignore'), '.ensemble/\n.env\nignored/\n');
  await writeFile(path.join(root, 'input.md'), 'Input v1');
  await writeFile(path.join(root, 'work.prompt.md'), `---\ninputs: [input.md]\noutputs: [output.md]\n${extra}---\nWrite output.\n`);
  const config = await loadConfig(root), node = (await buildGraph(root, config)).nodes[0];
  return { root, config, node };
}
const meta = (node: string): RunMeta => ({ runId: 'run-test', node, fingerprint: 'sha256:test', status: 'completed', model: 'mock-model', inputs: {}, started_at: new Date().toISOString(), summary: 'Verified output.', cost: 0.01, parallel_cost: 0.002 });

describe('serialized workspace git', () => {
  it('snapshots prompt and inputs, commits only outputs, and preserves unrelated staged changes', async () => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    const f = await fixture(), git = simpleGit(f.root), journal = new WorkspaceGit(f.root, f.config);
    await git.init();
    await writeFile(path.join(f.root, 'unrelated.md'), 'User staged work');
    await git.add('unrelated.md');
    const run = meta(f.node.id);
    await journal.beforeRun(f.node, run);
    expect(run.inputs_commit).toMatch(/^[a-f0-9]{40}$/);
    expect(await git.raw(['show', '--format=', '--name-only', run.inputs_commit!])).toContain('work.prompt.md');
    expect(await git.raw(['show', '--format=', '--name-only', run.inputs_commit!])).not.toContain('unrelated.md');
    await writeFile(path.join(f.root, 'output.md'), 'Generated result');
    await journal.afterRun(f.node, run);
    expect(run.commit).not.toBe(run.inputs_commit);
    expect((await git.raw(['show', '--format=', '--name-only', run.commit!])).trim()).toBe('output.md');
    expect((await git.raw(['diff', '--cached', '--name-only'])).trim()).toBe('unrelated.md');
    expect(await git.raw(['show', '--format=%B', '--no-patch', 'HEAD'])).toContain('run: run-test');
    expect((await git.raw(['show', '--format=%an <%ae>', '--no-patch', 'HEAD'])).trim()).toBe('Ensemble <ensemble@localhost>');
    expect((await git.raw(['config', '--local', 'user.name'])).trim()).toBe('');
    // A successful run that deliberately leaves its output unchanged still has lineage.
    const previous = run.commit;
    await journal.afterRun(f.node, run);
    expect(run.commit).not.toBe(previous);
    expect((await git.raw(['diff', '--cached', '--name-only'])).trim()).toBe('unrelated.md');
  });

  it('serializes independent commits and never force-adds ignored credentials', async () => {
    const f = await fixture(), git = simpleGit(f.root), journal = new WorkspaceGit(f.root, f.config);
    await git.init();
    await writeFile(path.join(f.root, 'one.md'), 'One');
    await writeFile(path.join(f.root, 'two.md'), 'Two');
    const [first, second] = await Promise.all([journal.commitFiles(['one.md'], 'Add one'), journal.commitFiles(['two.md'], 'Add two')]);
    expect(first).not.toBe(second);
    expect((await git.raw(['log', '--format=%s'])).trim().split('\n')).toEqual(['Add two', 'Add one']);
    await writeFile(path.join(f.root, '.env'), 'API_KEY=not-a-real-key');
    await journal.commitFiles(['.env'], 'Must not add ignored files');
    expect((await git.raw(['ls-files', '--', '.env'])).trim()).toBe('');
  });

  it('refuses an inherited parent repository and workspace escapes', async () => {
    const f = await fixture(), git = simpleGit(f.root);
    await git.init();
    const nested = path.join(f.root, 'nested'); await mkdir(nested);
    await expect(new WorkspaceGit(nested, f.config).commitFiles(['input.md'], 'Wrong root')).rejects.toThrow('own git repository');
    await expect(new WorkspaceGit(f.root, f.config).commitFiles(['../outside.md'], 'Escape')).rejects.toThrow('escapes');
  });
});

describe('workspace watch and schedule triggers', () => {
  it('debounces editor bursts and filters runtime, gitignore, and config exclusions', async () => {
    const f = await fixture();
    for (const directory of ['.ensemble', 'ignored', 'scratch']) await mkdir(path.join(f.root, directory));
    const changes: string[][] = [];
    let resolveChange!: () => void;
    const changed = new Promise<void>(resolve => { resolveChange = resolve; });
    const watcher = await watchWorkspace(f.root, f.config, files => { changes.push(files); resolveChange(); });
    watchers.push(watcher);
    await writeFile(path.join(f.root, 'input.md'), 'Input v2');
    await writeFile(path.join(f.root, 'input.md'), 'Input v3');
    await writeFile(path.join(f.root, '.ensemble/state.json'), '{}');
    await writeFile(path.join(f.root, 'ignored/file.md'), 'Ignored');
    await writeFile(path.join(f.root, 'scratch/file.md'), 'Ignored');
    await writeFile(path.join(f.root, '.env'), 'Ignored');
    await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error('watch callback timed out')), 3000))]);
    await watcher.close(); watchers.splice(watchers.indexOf(watcher), 1);
    expect(changes).toEqual([['input.md']]);
    expect(await readFile(path.join(f.root, 'input.md'), 'utf8')).toBe('Input v3');
  });

  it('ticks each matching node once per minute and changes its fingerprint', async () => {
    const f = await fixture('schedule: "* * * * *"\n');
    const store = await new StateStore(f.root).load(), runner = new FakeRunner(), scheduler = new Scheduler(f.root, f.config, store, runner);
    await scheduler.run();
    const initial = scheduler.graph.nodes[0].fingerprint;
    const schedules = installSchedules(scheduler); timers.push(schedules);
    const now = new Date(2026, 9, 19, 12, 0, 0);
    await schedules.tick(now);
    expect(runner.runs).toHaveLength(2);
    expect(scheduler.graph.nodes[0].fingerprint).not.toBe(initial);
    await schedules.tick(new Date(now.getTime() + 30_000));
    expect(runner.runs).toHaveLength(2);
    await schedules.tick(new Date(now.getTime() + 60_000));
    expect(runner.runs).toHaveLength(3);
  });

  it('leaves scheduled manual nodes stale without running them automatically', async () => {
    const f = await fixture('schedule: "* * * * *"\nmode: manual\n');
    const store = await new StateStore(f.root).load(), runner = new FakeRunner(), scheduler = new Scheduler(f.root, f.config, store, runner);
    await scheduler.run({ targets: [f.node.id] });
    const schedules = installSchedules(scheduler); timers.push(schedules);
    await schedules.tick(new Date(2026, 9, 19, 12, 0, 0));
    expect(runner.runs).toHaveLength(1);
    expect(scheduler.graph.nodes[0].status).toBe('stale');
  });

  it('validates five-field syntax, ranges, steps, lists, and day matching', async () => {
    expect(parseCron('*/10 9-17 * * 1,3,5')(new Date(2026, 9, 19, 12, 10))).toBe(true);
    expect(parseCron('*/10 9-17 * * 1,3,5')(new Date(2026, 9, 19, 12, 11))).toBe(false);
    expect(parseCron('0 12 1 * 1')(new Date(2026, 9, 19, 12, 0))).toBe(true);
    expect(parseCron('0 12 * * 7')(new Date(2026, 9, 18, 12, 0))).toBe(true);
    expect(() => parseCron('70 * * * *')).toThrow();
    expect(() => parseCron('*/0 * * * *')).toThrow();
    expect(() => parseCron('* * *')).toThrow();
    const f = await fixture('schedule: "not a schedule"\n');
    expect(f.node.status).toBe('invalid');
  });
});

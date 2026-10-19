import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildGraph } from '../src/graph/build.js';
import type { ComposioBackend } from '../src/integrations/composio/backend.js';
import { makeComposioTools } from '../src/runner/tools/composio.js';

const example = path.resolve('examples/coding-agents-icp');
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('shipped coding-agent workspace', () => {
  it('parses without generated outputs and retains the complete pending DAG', async () => {
    const graph = await buildGraph(example, await loadConfig(example));
    expect(graph.warnings).toEqual([]);
    expect(graph.nodes.filter(node => node.status === 'invalid')).toEqual([]);
    expect(graph.nodes).toHaveLength(7);
    expect(graph.nodes.filter(node => node.kind === 'fanout')).toHaveLength(3);
    const dataset = graph.nodes.find(node => node.path.endsWith('/top-10.prompt.md'))!;
    expect(dataset.outputs).toEqual(['coding-agents/top-10.csv', 'coding-agents/top-10.csv.sources.json']);
    const action = graph.nodes.find(node => node.kind === 'action')!;
    expect(action.dependencies).toContain('coding-agents/outreach/sequence');
    expect(action.body).toContain('you@example.com');
    expect(action.fm.tools.composio).not.toContain('GMAIL_SEND_EMAIL');
  });

  it('expands rows into independent research and fit chains before ranking', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ensemble-example-'));
    temporary.push(root);
    await cp(example, root, { recursive: true });
    await writeFile(path.join(root, 'coding-agents/top-10.csv'), [
      'company_name,product_name,website,hq_country,funding,one_liner',
      'Alpha Tools,Alpha Agent,https://alpha.example,US,Unknown,Test fixture',
      'Beta Tools,Beta Agent,https://beta.example,US,Unknown,Test fixture',
      '',
    ].join('\n'));
    const config = await loadConfig(root);
    const graph = await buildGraph(root, config);
    expect(graph.nodes.filter(node => node.status === 'invalid')).toEqual([]);
    expect(graph.nodes).toHaveLength(10);
    const fit = graph.nodes.find(node => node.id.endsWith('icp-fit[alpha-tools]'))!;
    expect(fit.dependencies).toEqual(expect.arrayContaining([
      'coding-agents/companies/_each/people[alpha-tools]',
      'coding-agents/companies/_each/direction[alpha-tools]',
    ]));
    expect(fit.dependencies).not.toContain('coding-agents/companies/_each/people[beta-tools]');
    const ranking = graph.nodes.find(node => node.id === 'coding-agents/icp-ranking')!;
    expect(ranking.dependencies).toEqual(expect.arrayContaining([
      'coding-agents/companies/_each/icp-fit[alpha-tools]',
      'coding-agents/companies/_each/icp-fit[beta-tools]',
    ]));
    const before = new Map(graph.nodes.map(node => [node.id, node.fingerprint]));
    const icp = path.join(root, 'context/icp.md');
    await writeFile(icp, `${await readFile(icp, 'utf8')}\nMust have a public changelog.\n`);
    const changed = await buildGraph(root, config);
    for (const node of changed.nodes.filter(node => /\/(people|direction)\[/.test(node.id))) {
      expect(node.fingerprint).toBe(before.get(node.id));
    }
    expect(changed.nodes.find(node => node.id === fit.id)!.fingerprint).not.toBe(before.get(fit.id));
    expect(changed.nodes.find(node => node.id === ranking.id)!.fingerprint).not.toBe(before.get(ranking.id));
  });

  it('exposes the published Linear list lookups without exposing any planning writes', async () => {
    const config = await loadConfig(example), graph = await buildGraph(example, config);
    const action = graph.nodes.find(node => node.kind === 'action')!;
    const calls: { slug: string; args: Record<string, unknown> }[] = [];
    // Published CLI schemas use these pagination inputs and omit readonly tags.
    // Keep this fixture independent of any developer's private CLI cache/account.
    const paginationSchema = { type: 'object', properties: {
      first: { type: 'integer', default: 50, minimum: 1, maximum: 250 },
      after: { type: 'string' },
    } };
    const backend: ComposioBackend = {
      async getToolSchema(slug) { return { slug, description: slug, tags: [], inputSchema:
        ['LINEAR_LIST_LINEAR_TEAMS', 'LINEAR_LIST_LINEAR_USERS'].includes(slug) ? paginationSchema : { type: 'object' } }; },
      async searchTools() { return []; },
      async execute(slug, args) {
        if (!['LINEAR_LIST_LINEAR_TEAMS', 'LINEAR_LIST_LINEAR_USERS'].includes(slug)) throw new Error('A write escaped the planning bridge');
        calls.push({ slug, args });
        return { ok: true, data: slug === 'LINEAR_LIST_LINEAR_TEAMS'
          ? { teams: [{ id: 'own-team', identifier: 'GTM' }], page_info: { hasNextPage: false } }
          : { users: [], page_info: { hasNextPage: false } } };
      },
      async connect(): Promise<never> { throw new Error('This regression must never connect accounts'); },
      async connections() { return []; },
    };
    const tools = await makeComposioTools(action, { root: example, config, runId: 'run_example_readonly', signal: new AbortController().signal, emit() {} }, backend);
    expect(tools.map(tool => tool.name)).toEqual(['linear_list_linear_teams', 'linear_list_linear_users', 'composio_search_tools']);
    const invoke = (name: string, args: Record<string, unknown>) => (tools.find(tool => tool.name === name) as unknown as {
      execute(input: Record<string, unknown>, context: object): Promise<unknown>;
    }).execute(args, {});
    expect(await invoke('linear_list_linear_teams', { first: 1 })).toMatchObject({ teams: [{ identifier: 'GTM' }] });
    await invoke('linear_list_linear_users', { first: 1 });
    await expect(invoke('linear_list_linear_teams', { first: 0 })).rejects.toThrow();
    expect(calls).toEqual([
      { slug: 'LINEAR_LIST_LINEAR_TEAMS', args: { first: 1 } },
      { slug: 'LINEAR_LIST_LINEAR_USERS', args: { first: 1 } },
    ]);
  });
});

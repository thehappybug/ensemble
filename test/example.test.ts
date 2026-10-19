import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildGraph } from '../src/graph/build.js';

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
});

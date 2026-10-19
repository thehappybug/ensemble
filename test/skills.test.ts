import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import matter from 'gray-matter';
import { loadConfig } from '../src/config.js';
import { buildGraph } from '../src/graph/build.js';
import { installWorkspaceSkill } from '../src/workspace/skills.js';
import { atomicWrite } from '../src/util.js';

const roots: string[] = [];
const agentPath = '.agents/skills/ensemble/SKILL.md';
const claudePath = '.claude/skills/ensemble/SKILL.md';
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await mkdtemp(path.join(os.tmpdir(), 'ensemble-skills-')); roots.push(root); return root; }

describe('workspace authoring skill', () => {
  it('installs identical discoverable copies and concurrent installation is idempotent', async () => {
    const root = await temporary();
    const template = await readFile(path.resolve('templates/ensemble/SKILL.md'), 'utf8');
    const writes = await Promise.all([installWorkspaceSkill(root), installWorkspaceSkill(root)]);
    expect(writes.flat().sort()).toEqual([agentPath, claudePath].sort());
    expect(await readFile(path.join(root, agentPath), 'utf8')).toBe(template);
    expect(await readFile(path.join(root, claudePath), 'utf8')).toBe(template);
    expect(await installWorkspaceSkill(root)).toEqual([]);
  });

  it('preserves customization and seeds a missing companion from the existing skill', async () => {
    const root = await temporary();
    const customized = '---\nname: ensemble\ndescription: My customized workspace rules\n---\nUse the company conventions.\n';
    await atomicWrite(path.join(root, agentPath), customized);
    expect(await installWorkspaceSkill(root)).toEqual([claudePath]);
    expect(await readFile(path.join(root, agentPath), 'utf8')).toBe(customized);
    expect(await readFile(path.join(root, claudePath), 'utf8')).toBe(customized);
    await writeFile(path.join(root, claudePath), customized + '\nClaude-specific user guidance.\n');
    expect(await installWorkspaceSkill(root)).toEqual([]);
    expect(await readFile(path.join(root, claudePath), 'utf8')).toContain('Claude-specific user guidance.');
  });

  it('does not install through a skill directory symlink outside the workspace', async () => {
    const root = await temporary(), outside = await temporary();
    await symlink(outside, path.join(root, '.agents'), 'dir');
    await expect(installWorkspaceSkill(root)).rejects.toThrow('escapes workspace');
    await expect(access(path.join(outside, 'skills/ensemble/SKILL.md'))).rejects.toThrow();
  });

  it('ships executable authoring examples that form a valid graph without producing outputs', async () => {
    const root = await temporary();
    await atomicWrite(path.join(root, 'ensemble.yaml'), 'version: 1\nname: skill-examples\nvars:\n  demo_recipient: you@example.com\n');
    await atomicWrite(path.join(root, 'context/icp.md'), '# ICP\nPrefer public APIs.\n');
    await atomicWrite(path.join(root, 'context/team.md'), '# Team\nDemo drafts go to the operator only.\n');
    await atomicWrite(path.join(root, 'research/companies.csv'), 'company_name\nAlpha Tools\nBeta Tools\n');
    const skill = await readFile(path.resolve('templates/ensemble/SKILL.md'), 'utf8');
    const frontmatter = matter(skill).data;
    expect(frontmatter.name).toBe('ensemble');
    expect(typeof frontmatter.description).toBe('string');
    const examples = [...skill.matchAll(/### `([^`]+\.(?:prompt|action)\.md)`\n\n```markdown\n([\s\S]*?)\n```/g)];
    expect(examples).toHaveLength(5);
    for (const [, file, content] of examples) await atomicWrite(path.join(root, file), content + '\n');
    const graph = await buildGraph(root, await loadConfig(root));
    expect(graph.warnings).toEqual([]);
    expect(graph.nodes.filter(node => ['invalid', 'blocked'].includes(node.status))).toEqual([]);
    expect(graph.nodes).toHaveLength(6);
    const ranking = graph.nodes.find(node => node.id === 'research/ranking')!;
    expect(ranking.dependencies).toEqual(expect.arrayContaining([
      'research/overview', 'research/companies/_each/people[alpha-tools]', 'research/companies/_each/people[beta-tools]',
    ]));
    expect(graph.nodes.find(node => node.kind === 'action')?.dependencies).toContain('research/ranking');
    expect(graph.nodes.find(node => node.id === 'context/calendar/refresh')?.fm.schedule).toBe('0 9 * * 1-5');
    for (const output of graph.nodes.flatMap(node => node.outputs)) await expect(access(path.join(root, output))).rejects.toThrow();
  });
});

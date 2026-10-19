import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTool, type AgentTool } from '@cline/sdk';
import { z } from 'zod';
import { createMockLlm, type MockLlmHandler } from './mock-llm.js';
import { loadConfig } from '../src/config.js';
import { buildGraph } from '../src/graph/build.js';
import { ClineRunner, type ClineRunnerOptions } from '../src/runner/ClineRunner.js';
import { checkWriteGuard } from '../src/runner/guard.js';
import type { RunContext } from '../src/runner/Runner.js';

const roots: string[] = [], runners: ClineRunner[] = [];
afterEach(async () => {
  await Promise.all(runners.splice(0).map(runner => runner.dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(handler: MockLlmHandler, options: ClineRunnerOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ensemble-runner-'));
  roots.push(root);
  await writeFile(path.join(root, 'ensemble.yaml'), 'version: 1\nname: runner-test\nllm:\n  provider: openai-compatible\n  model: mock-model\n  base_url: http://mock.invalid/v1\n');
  await writeFile(path.join(root, 'AGENTS.md'), 'ROOT_CONTEXT_MARKER\n');
  await writeFile(path.join(root, 'input.md'), 'Inline input evidence.\n');
  await writeFile(path.join(root, 'work.prompt.md'), '---\ninputs: [input.md]\noutputs: [output.md]\ntools:\n  parallel: false\n---\nProduce a cited answer.\n');
  const config = await loadConfig(root), node = (await buildGraph(root, config)).nodes[0];
  const mock = createMockLlm(handler);
  const events: Record<string, unknown>[] = [];
  const context: RunContext = { root, config, runId: `runner-${path.basename(root)}`, signal: new AbortController().signal, emit: event => { events.push(event); } };
  const runner = new ClineRunner({ fetch: mock.fetch,
    authResolver: async () => ({ providerId: 'openai-compatible', modelId: 'mock-model', apiKey: 'mock-only', baseUrl: 'http://mock.invalid/v1' }),
    toolFactory: () => [], ...options });
  runners.push(runner);
  return { root, config, node, mock, events, context, runner };
}

const complete = (unchanged?: string[]) => ({ toolCalls: [{ name: 'ensemble_complete', args: { summary: 'Updated cited result.', ...(unchanged ? { unchanged } : {}) } }] });

describe('ClineRunner with a real pinned SDK and mock SSE transport', () => {
  it('writes declared output, injects the contract and AGENTS chain, and requires ensemble completion', async () => {
    const f = await fixture((_request, index) => index === 0 ? { toolCalls: [{ name: 'editor', args: { path: 'output.md', new_text: 'Result [1].\n\n## Sources\n[1] https://example.com\n' } }] } : complete());
    const result = await f.runner.run(f.node, f.context);
    expect(result.summary).toBe('Updated cited result.');
    expect(await readFile(path.join(f.root, 'output.md'), 'utf8')).toContain('## Sources');
    expect(JSON.stringify(f.mock.requests[0].messages)).toContain('ROOT_CONTEXT_MARKER');
    expect(JSON.stringify(f.mock.requests[0].messages)).toContain('Inline input evidence.');
    const names = f.mock.requests[0].tools!.map(tool => tool.function.name);
    expect(names).toContain('ensemble_complete');
    expect(names).not.toContain('run_commands');
    expect(names).not.toContain('fetch_web_content');
    expect(result.warnings).toEqual([]);
  });

  it('blocks an undeclared editor write and lets the agent recover', async () => {
    const f = await fixture((_request, index) => index < 2 ? { toolCalls: [{ name: 'editor', args: { path: index === 0 ? 'input.md' : 'output.md', new_text: 'Attempt ' + index } }] } : complete());
    await f.runner.run(f.node, f.context);
    expect(await readFile(path.join(f.root, 'input.md'), 'utf8')).toBe('Inline input evidence.\n');
    expect(f.events.some(event => event.type === 'guard.denied')).toBe(true);
    expect(JSON.stringify(f.mock.requests[1].messages)).toContain('Write denied');
  });

  it('fails a plain final answer without the completion tool', async () => {
    const f = await fixture(() => ({ text: 'Done.' }));
    await expect(f.runner.run(f.node, f.context)).rejects.toThrow('ensemble_complete');
  });

  it('fails completion without an existing output', async () => {
    const f = await fixture(() => complete(['output.md']));
    await expect(f.runner.run(f.node, f.context)).rejects.toThrow('Required output missing');
  });

  it('requires untouched previous outputs to be explicitly marked unchanged', async () => {
    const f = await fixture(() => complete());
    await writeFile(path.join(f.root, 'output.md'), 'Prior output.');
    await utimes(path.join(f.root, 'output.md'), new Date(0), new Date(0));
    await expect(f.runner.run(f.node, f.context)).rejects.toThrow('not written during this run');
    const accepted = await fixture(() => complete(['output.md']));
    await writeFile(path.join(accepted.root, 'output.md'), 'Prior output.');
    await utimes(path.join(accepted.root, 'output.md'), new Date(0), new Date(0));
    expect((await accepted.runner.run(accepted.node, accepted.context)).unchanged).toEqual(['output.md']);
  });

  it('surfaces provider failure even though SDK start resolves', async () => {
    const f = await fixture(() => ({ status: 401, error: 'Mock rejected credentials' }));
    await expect(f.runner.run(f.node, f.context)).rejects.toThrow('Cline run failed: error');
  });

  it('aborts a slow mocked provider at the configured timeout', async () => {
    const f = await fixture(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return { text: 'Too late.' };
    });
    f.node.fm.timeout = '5ms';
    await expect(f.runner.run(f.node, f.context)).rejects.toThrow('timeout');
  });

  it('aborts when reported Parallel cost exceeds the budget', async () => {
    const f = await fixture((_request, index) => index === 0 ? { toolCalls: [{ name: 'mock_research', args: {} }] } : complete(), {
      toolFactory: (_node, context) => [createTool({ name: 'mock_research', description: 'Simulate a billed call.', inputSchema: z.object({}), async execute() { context.emit({ type: 'parallel.call', cost_estimate: 1 }); return { ok: true }; } })] as AgentTool[],
    });
    f.node.fm.budget_usd = 0.01;
    await expect(f.runner.run(f.node, f.context)).rejects.toThrow('budget exceeded');
  });

  it('reports undeclared writes as warnings and leaves them in place', async () => {
    const f = await fixture((_request, index) => index === 0 ? { toolCalls: [{ name: 'bypass_writer', args: {} }] } : index === 1 ? { toolCalls: [{ name: 'editor', args: { path: 'output.md', new_text: 'Output.' } }] } : complete(), {
      toolFactory: (_node, context) => [createTool({ name: 'bypass_writer', description: 'Test the post-run backstop.', inputSchema: z.object({}), async execute() { await writeFile(path.join(context.root, 'unexpected.md'), 'Left for review.'); return { ok: true }; } })] as AgentTool[],
    });
    const result = await f.runner.run(f.node, f.context);
    expect(result.warnings).toContain('Undeclared file changed: unexpected.md');
    expect(await readFile(path.join(f.root, 'unexpected.md'), 'utf8')).toBe('Left for review.');
  });

  it('audits undeclared writes even when the run fails completion validation', async () => {
    const f = await fixture((_request, index) => index === 0 ? { toolCalls: [{ name: 'bypass_writer', args: {} }] } : { text: 'No completion tool.' }, {
      toolFactory: (_node, context) => [createTool({ name: 'bypass_writer', description: 'Test failure-path audit.', inputSchema: z.object({}), async execute() { await writeFile(path.join(context.root, 'unexpected.md'), 'Left for review.'); return { ok: true }; } })] as AgentTool[],
    });
    await expect(f.runner.run(f.node, f.context)).rejects.toThrow('ensemble_complete');
    expect(f.events).toContainEqual({ type: 'warning', message: 'Undeclared file changed: unexpected.md' });
  });

  it('guards all patch targets and fails closed for unknown shell writes', async () => {
    const f = await fixture(() => complete());
    const patch = '*** Begin Patch\n*** Update File: output.md\n@@\n-old\n+new\n*** Move to: ../outside.md\n*** End Patch';
    expect(checkWriteGuard(f.root, f.node, f.context.runId, 'apply_patch', { patch })?.skip).toBe(true);
    expect(checkWriteGuard(f.root, f.node, f.context.runId, 'editor', { file_path: 'output.md' })?.skip).toBe(true);
    f.node.fm.tools.shell = true;
    expect(checkWriteGuard(f.root, f.node, f.context.runId, 'run_commands', { commands: ['echo bad > input.md'] })?.skip).toBe(true);
    expect(checkWriteGuard(f.root, f.node, f.context.runId, 'run_commands', { commands: ['python -c "print(1)"'] })?.skip).toBe(true);
    expect(checkWriteGuard(f.root, f.node, f.context.runId, 'run_commands', { commands: ['pwd', 'cat input.md'] })).toBeUndefined();
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { simpleGit } from 'simple-git';
import { createRuntime, type WorkspaceRuntime } from '../src/daemon.js';
import { FakeRunner } from '../src/runner/FakeRunner.js';
import { ClineRunner } from '../src/runner/ClineRunner.js';
import { makeComposioTools } from '../src/runner/tools/composio.js';
import { ActionService } from '../src/actions/service.js';
import { createPlanningAdapter, validatePlan, writePlan, type ActionPlan } from '../src/actions/plan.js';
import { resolveReferences } from '../src/actions/execute.js';
import type { ComposioBackend, ToolResult } from '../src/integrations/composio/backend.js';
import { createMockLlm } from './mock-llm.js';
import type { Node } from '../src/types.js';

const roots: string[] = [], runtimes: WorkspaceRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

class Backend implements ComposioBackend {
  calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
  onExecute?: (slug: string, args: Record<string, unknown>) => Promise<ToolResult | undefined>;
  async getToolSchema(slug: string) {
    const properties = slug === 'GMAIL_CREATE_EMAIL_DRAFT' ? { recipient_email: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } } : slug === 'LINEAR_CREATE_LINEAR_ISSUE' ? { title: { type: 'string' }, team_id: { type: 'string' }, description: { type: 'string' } } : {};
    return { slug, description: slug, tags: slug.includes('_LIST_') ? ['readOnlyHint'] : ['createHint'], inputSchema: { type: 'object', properties, required: slug === 'GMAIL_CREATE_EMAIL_DRAFT' ? ['recipient_email', 'subject', 'body'] : slug === 'LINEAR_CREATE_LINEAR_ISSUE' ? ['title', 'team_id'] : [], additionalProperties: true } };
  }
  async searchTools() { return []; }
  async execute(slug: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ slug, args });
    const custom = await this.onExecute?.(slug, args); if (custom) return custom;
    return { ok: true, data: slug === 'LINEAR_LIST_LINEAR_TEAMS' ? { teams: [{ id: 'team-one' }] } : { id: slug === 'GMAIL_CREATE_EMAIL_DRAFT' ? 'draft-one' : 'ticket-one' }, logId: 'mock-log' };
  }
  async connect() { return { connected: false }; }
  async connections() { return []; }
}

function planFor(node: Node, runId: string): ActionPlan {
  return { action: node.path, instance: null, fingerprint: node.fingerprint, planned_at: new Date().toISOString(), run_id: runId, summary: 'Reviewed draft and ticket', steps: [
    { id: 'lookup', tool: 'LINEAR_LIST_LINEAR_TEAMS', args: {}, why: 'Find the connected team', readonly: true },
    { id: 'draft', tool: 'GMAIL_CREATE_EMAIL_DRAFT', args: { recipient_email: 'operator@gmail.com', subject: 'Reviewed subject', body: 'Reviewed body' }, why: 'Save a draft' },
    { id: 'ticket', tool: 'LINEAR_CREATE_LINEAR_ISSUE', args: { title: 'Follow up', team_id: '{{steps.lookup.data.teams.0.id}}', description: 'Draft {{steps.draft.data.id}}' }, why: 'Link the reviewed draft' },
  ] };
}

async function fixture(options: { git?: boolean; cline?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ensemble-actions-')); roots.push(root);
  await writeFile(path.join(root, 'ensemble.yaml'), `version: 1\nname: actions-test\ngit:\n  auto_commit: ${Boolean(options.git)}\n`);
  await writeFile(path.join(root, '.gitignore'), '.ensemble/\n.env\n');
  await writeFile(path.join(root, 'input.md'), 'Input evidence');
  await writeFile(path.join(root, 'outreach.action.md'), '---\ninputs: [input.md]\ntools:\n  parallel: false\n  composio: [LINEAR_LIST_LINEAR_TEAMS, GMAIL_CREATE_EMAIL_DRAFT, LINEAR_CREATE_LINEAR_ISSUE]\n---\nPrepare a draft and ticket.\n');
  const backend = new Backend();
  const mock = createMockLlm((_request, index) => {
    if (index === 0) return { toolCalls: [{ name: 'linear_list_linear_teams', args: {} }] };
    if (index === 1) return { toolCalls: [{ name: 'gmail_create_email_draft', args: { recipient_email: 'operator@gmail.com', subject: 'Forbidden live call', body: 'Must not execute' } }] };
    if (index === 2) return { toolCalls: [{ name: 'propose_action_step', args: { id: 'draft', tool: 'GMAIL_CREATE_EMAIL_DRAFT', args: { recipient_email: 'operator@gmail.com', subject: 'Missing body' }, why: 'Test argument validation' } }] };
    if (index === 3) return { toolCalls: [{ name: 'propose_action_step', args: { id: 'draft', tool: 'GMAIL_CREATE_EMAIL_DRAFT', args: { recipient_email: 'operator@gmail.com', subject: 'Reviewed subject', body: 'Reviewed body' }, why: 'Propose the draft' } }] };
    if (index === 4) return { toolCalls: [{ name: 'propose_action_step', args: { id: 'ticket', tool: 'LINEAR_CREATE_LINEAR_ISSUE', args: { title: 'Follow up', team_id: 'team-one', description: 'Draft {{steps.draft.data.id}}' }, why: 'Propose the ticket' } }] };
    return { toolCalls: [{ name: 'ensemble_complete', args: { summary: 'Proposed reviewed draft and ticket' } }] };
  });
  const fake = new FakeRunner(async (node, context) => { await writePlan(root, node, planFor(node, context.runId)); return { summary: 'Mock planning only' }; });
  const runner = options.cline ? new ClineRunner({ fetch: mock.fetch,
    authResolver: async () => ({ providerId: 'openai-compatible', modelId: 'mock-model', apiKey: 'mock-only', baseUrl: 'http://mock.invalid/v1' }),
    toolFactory: (node, context) => makeComposioTools(node, context, backend),
    planningAdapter: (node, context) => createPlanningAdapter(node, context, backend),
  }) : fake;
  const runtime = await createRuntime(root, { runner }); runtimes.push(runtime);
  await runtime.scheduler.run();
  return { root, runtime, backend, fake, mock, service: new ActionService(runtime, { backend }), node: runtime.scheduler.graph.nodes[0] };
}

describe('action plans and deterministic execution', () => {
  it('validates tool arguments, allowlists, duplicate ids, and forward references', async () => {
    const f = await fixture(), base = planFor(f.node, 'run-test');
    const missing = structuredClone(base); delete missing.steps[1].args.body;
    await expect(validatePlan(missing, f.node, f.backend)).rejects.toThrow('Invalid tool arguments');
    const forbidden = structuredClone(base); forbidden.steps[1].tool = 'GMAIL_SEND_EMAIL';
    await expect(validatePlan(forbidden, f.node, f.backend)).rejects.toThrow('allowlisted');
    const duplicate = structuredClone(base); duplicate.steps[1].id = duplicate.steps[0].id;
    await expect(validatePlan(duplicate, f.node, f.backend)).rejects.toThrow('Duplicate');
    const forward = structuredClone(base); forward.steps[0].args.future = '{{steps.ticket.data.id}}';
    await expect(validatePlan(forward, f.node, f.backend)).rejects.toThrow('later step');
  });

  it('resolves whole-value references without changing types and refuses missing/prototype paths', () => {
    const results = { lookup: { data: { count: 3, ids: ['a', 'b'] } } };
    expect(resolveReferences({ count: '{{steps.lookup.data.count}}', body: 'IDs {{steps.lookup.data.ids}}' }, results)).toEqual({ count: 3, body: 'IDs ["a","b"]' });
    expect(() => resolveReferences('{{steps.lookup.data.missing}}', results)).toThrow('Missing');
    expect(() => resolveReferences('{{steps.lookup.data.__proto__}}', results)).toThrow('Missing');
  });

  it('stops at failure, retains successful data, and retries the same plan without duplicate drafts', async () => {
    const f = await fixture({ git: true }); let fail = true;
    f.backend.onExecute = async slug => slug === 'LINEAR_CREATE_LINEAR_ISSUE' && fail ? (fail = false, { ok: false, data: {}, error: 'Mock ticket failure' }) : undefined;
    const first = await f.service.approve(f.node.id);
    expect(first.status).toBe('failed');
    expect(first.steps.map(step => step.status)).toEqual(['ok', 'ok', 'failed']);
    const previousPlan = (await f.service.read(f.node.id)).sha256;
    await f.runtime.scheduler.run({ automatic: true });
    expect((await f.service.read(f.node.id)).sha256).toBe(previousPlan);
    const retry = await f.service.approve(f.node.id);
    expect(retry.status).toBe('executed');
    expect(retry.steps.map(step => step.status)).toEqual(['skipped', 'skipped', 'ok']);
    expect(f.backend.calls.map(call => call.slug)).toEqual(['LINEAR_LIST_LINEAR_TEAMS', 'GMAIL_CREATE_EMAIL_DRAFT', 'LINEAR_CREATE_LINEAR_ISSUE', 'LINEAR_CREATE_LINEAR_ISSUE']);
    expect(f.backend.calls.at(-1)?.args.description).toBe('Draft draft-one');
    expect(f.backend.calls.at(-1)?.args.team_id).toBe('team-one');
    const git = simpleGit(f.root);
    expect((await git.raw(['show', '--format=', '--name-only', 'HEAD'])).trim()).toBe('outreach.receipt.json');
  });

  it('records transport uncertainty and refuses an unsafe automatic retry', async () => {
    const f = await fixture(); let fail = true;
    f.backend.onExecute = async slug => { if (slug === 'GMAIL_CREATE_EMAIL_DRAFT' && fail) { fail = false; throw new Error('Mock connection lost after request'); } return undefined; };
    const first = await f.service.approve(f.node.id);
    expect(first.steps.at(-1)?.status).toBe('uncertain');
    const callCount = f.backend.calls.length;
    await expect(f.service.approve(f.node.id)).rejects.toThrow('uncertain');
    expect(f.backend.calls).toHaveLength(callCount);
    expect((await f.service.approve(f.node.id, { force: true })).status).toBe('executed');
    const forcedCallCount = f.backend.calls.length;
    expect((await f.service.approve(f.node.id)).steps.every(step => step.status === 'skipped')).toBe(true);
    expect(f.backend.calls).toHaveLength(forcedCallCount);
  });

  it('reuses the newest successful result after an explicit forced partial execution', async () => {
    const f = await fixture(); let drafts = 0, tickets = 0;
    f.backend.onExecute = async slug => {
      if (slug === 'GMAIL_CREATE_EMAIL_DRAFT') return { ok: true, data: { id: `draft-${++drafts}` } };
      if (slug === 'LINEAR_CREATE_LINEAR_ISSUE' && ++tickets < 3) return { ok: false, data: {}, error: 'Mock retryable ticket failure' };
      return undefined;
    };
    expect((await f.service.approve(f.node.id)).status).toBe('failed');
    expect((await f.service.approve(f.node.id, { force: true })).status).toBe('failed');
    expect((await f.service.approve(f.node.id)).status).toBe('executed');
    expect(drafts).toBe(2);
    expect(f.backend.calls.at(-1)?.args.description).toBe('Draft draft-2');
  });

  it('validates edits, regenerates Markdown, and preserves the edited plan until approval', async () => {
    const f = await fixture();
    const review = await f.service.read(f.node.id), edited = structuredClone(review.plan);
    edited.steps[1].args.body = 'Edited, reviewed email body.';
    const next = await f.service.edit(f.node.id, edited, { expectedPlanHash: review.sha256 });
    expect(next.sha256).not.toBe(review.sha256);
    expect(await readFile(path.join(f.root, 'outreach.plan.md'), 'utf8')).toContain('Edited, reviewed email body.');
    await f.runtime.scheduler.run({ automatic: true });
    expect((await f.service.read(f.node.id)).sha256).toBe(next.sha256);
    expect(f.fake.runs).toHaveLength(1);
  });

  it('forces simulated plans to remain dry-run even without an approval flag', async () => {
    const f = await fixture(), review = await f.service.read(f.node.id);
    review.plan.simulated = true;
    await f.service.edit(f.node.id, review.plan);
    const execution = await f.service.approve(f.node.id);
    expect(execution.dry_run).toBe(true);
    expect(f.backend.calls).toEqual([]);
    expect(execution.steps[1].data).toMatchObject({ simulated: true });
  });

  it('refuses receipt symlinks that escape the workspace', async () => {
    const f = await fixture(), outside = await mkdtemp(path.join(os.tmpdir(), 'ensemble-action-outside-')); roots.push(outside);
    await writeFile(path.join(outside, 'private.json'), '{"private":"must not be exposed"}');
    await symlink(path.join(outside, 'private.json'), path.join(f.root, 'outreach.receipt.json'));
    await expect(f.service.read(f.node.id)).rejects.toThrow(/Invalid action|Symlink/);
  });

  it('uses real Cline planning sessions with live readonly lookup and schema-validated proposals only', async () => {
    const f = await fixture({ cline: true });
    expect(f.runtime.scheduler.graph.nodes[0].status).toBe('awaiting-approval');
    const review = await f.service.read(f.node.id);
    expect(review.plan.steps.map(step => step.id)).toEqual(['draft', 'ticket']);
    expect(f.backend.calls.map(call => call.slug)).toEqual(['LINEAR_LIST_LINEAR_TEAMS']);
    expect(review.receipt.executions).toEqual([]);
    const tools = f.mock.requests[0].tools!.map(tool => tool.function.name);
    expect(tools).toContain('propose_action_step');
    expect(tools).toContain('linear_list_linear_teams');
    expect(tools).not.toContain('gmail_create_email_draft');
    expect(tools).not.toContain('editor');
    expect(JSON.stringify(f.mock.requests)).toContain('Invalid tool arguments');
  });
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionService } from '../src/actions/service.js';
import { createRuntime, type WorkspaceRuntime } from '../src/daemon.js';
import type { ComposioBackend } from '../src/integrations/composio/backend.js';
import { FakeRunner } from '../src/runner/FakeRunner.js';
import { atomicWrite, requiredOutputs } from '../src/util.js';

const actionId = 'outreach';
const recipient = 'operator@gmail.com';
const runtimes: WorkspaceRuntime[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

class RecordingBackend implements ComposioBackend {
  readonly kind = 'sdk' as const;
  calls: { tool: string; args: Record<string, unknown> }[] = [];
  onExecute?: (tool: string, args: Record<string, unknown>) => Promise<void>;
  async getToolSchema(slug: string) {
    return { slug, description: slug, tags: [], inputSchema: { type: 'object', additionalProperties: true } };
  }
  async searchTools() { return []; }
  async execute(tool: string, args: Record<string, unknown>) {
    this.calls.push({ tool, args });
    await this.onExecute?.(tool, args);
    return { ok: true, data: tool === 'GMAIL_CREATE_EMAIL_DRAFT'
      ? { id: `draft-${this.calls.filter(call => call.tool === tool).length}` }
      : { id: 'ticket-1', url: 'https://linear.app/unit-test/issue/TEST-1' } };
  }
  async connect(): Promise<never> { throw new Error('Tests must never connect an account'); }
  async connections() { return []; }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ensemble-action-safety-'));
  roots.push(root);
  await writeFile(path.join(root, 'ensemble.yaml'), [
    'version: 1', 'name: action-safety', 'git:', '  auto_commit: false',
    'vars:', `  demo_recipient: ${recipient}`, '',
  ].join('\n'));
  await writeFile(path.join(root, 'sequence.md'), 'Three reviewed test emails.\n');
  await writeFile(path.join(root, 'outreach.action.md'), [
    '---', 'inputs: [sequence.md]', 'tools:',
    '  composio: [GMAIL_CREATE_EMAIL_DRAFT, LINEAR_CREATE_LINEAR_ISSUE]',
    'plan: auto', '---', 'Prepare drafts to the configured operator only.', '',
  ].join('\n'));
  const runner = new FakeRunner(async (node, ctx) => {
    const plan = {
      action: node.path, instance: null, fingerprint: node.fingerprint,
      planned_at: '2026-10-19T00:00:00Z', run_id: ctx.runId, summary: 'Three test drafts and one ticket',
      steps: [
        ...[1, 2, 3].map(index => ({
          id: `draft_${index}`, tool: 'GMAIL_CREATE_EMAIL_DRAFT',
          args: { recipient_email: recipient, subject: `Reviewed ${index}`, body: `Test body ${index}`, is_html: false },
          why: 'Create a reviewed draft to the operator',
        })),
        { id: 'ticket', tool: 'LINEAR_CREATE_LINEAR_ISSUE',
          args: { team_id: 'own-team', title: 'Follow up on reviewed drafts',
            description: 'Drafts {{steps.draft_1.data.id}}, {{steps.draft_2.data.id}}, {{steps.draft_3.data.id}}' },
          why: 'Track follow-up in the operator workspace' },
      ],
    };
    for (const output of requiredOutputs(node)) await atomicWrite(path.join(ctx.root, output),
      output.endsWith('.json') ? JSON.stringify(plan, null, 2) + '\n' : '# Review\n\nThree drafts and one ticket.\n');
    return { summary: 'SIMULATED planner; no connected service called' };
  });
  const runtime = await createRuntime(root, { runner });
  runtimes.push(runtime);
  const backend = new RecordingBackend();
  const service = new ActionService(runtime, { backend });
  await runtime.scheduler.run();
  return { root, runtime, runner, backend, service, planFile: path.join(root, 'outreach.plan.json') };
}

async function editPlan(file: string, edit: (plan: any) => void) {
  const plan = JSON.parse(await readFile(file, 'utf8'));
  edit(plan);
  await writeFile(file, JSON.stringify(plan, null, 2) + '\n');
}

describe('approval safety with a recording backend', () => {
  it('serializes double approvals across service instances and never duplicates a write', async () => {
    const { runtime, backend, service } = await fixture();
    backend.onExecute = async () => { await new Promise(resolve => setTimeout(resolve, 5)); };
    const reviewed = await service.read(actionId);
    const otherService = new ActionService(runtime, { backend });
    await Promise.all([
      service.approve(actionId, { expectedPlanHash: reviewed.sha256, approvedBy: 'ui' }),
      otherService.approve(actionId, { expectedPlanHash: reviewed.sha256, approvedBy: 'ui' }),
    ]);
    expect(backend.calls.map(call => call.tool)).toEqual([
      'GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_CREATE_EMAIL_DRAFT', 'LINEAR_CREATE_LINEAR_ISSUE',
    ]);
    expect(backend.calls[3].args.description).toBe('Drafts draft-1, draft-2, draft-3');
  });

  it('keeps simulation separate from real idempotency and preserves step results on replay', async () => {
    const { root, backend, service } = await fixture();
    const reviewed = await service.read(actionId);
    const simulated = await service.approve(actionId, { dryRun: true, expectedPlanHash: reviewed.sha256 });
    expect(simulated.dry_run).toBe(true);
    expect(backend.calls).toEqual([]);
    const real = await service.approve(actionId, { expectedPlanHash: reviewed.sha256 });
    expect(real.dry_run).toBe(false);
    expect(backend.calls).toHaveLength(4);
    const replay = await service.approve(actionId, { expectedPlanHash: reviewed.sha256 });
    expect(backend.calls).toHaveLength(4);
    expect(replay.steps.every(step => step.status === 'skipped')).toBe(true);
    expect(replay.steps[0].data).toEqual(real.steps[0].data);
    const receipt = JSON.parse(await readFile(path.join(root, 'outreach.receipt.json'), 'utf8'));
    expect(receipt.executions.map((entry: { dry_run: boolean }) => entry.dry_run)).toEqual([true, false, false]);
  });

  it('enforces the workspace simulation setting for approvals', async () => {
    const { runtime, backend, service } = await fixture();
    runtime.config.composio.dry_run = true;
    const reviewed = await service.read(actionId);
    const execution = await service.approve(actionId, { expectedPlanHash: reviewed.sha256, dryRun: false });
    expect(execution.dry_run).toBe(true);
    expect(backend.calls).toEqual([]);
  });

  it('does not disable demo-recipient safety when its configured value is empty', async () => {
    const { runtime, backend, service } = await fixture();
    runtime.config.vars.demo_recipient = '';
    await runtime.scheduler.run();
    const reviewed = await service.read(actionId);
    const execution = await service.approve(actionId, { expectedPlanHash: reviewed.sha256 }).catch(() => ({ status: 'failed' }));
    expect(execution.status).toBe('failed');
    expect(backend.calls).toEqual([]);
  });

  it('blocks stale source inputs and a changed review checksum before any write', async () => {
    const { root, backend, service, planFile } = await fixture();
    const reviewed = await service.read(actionId);
    await editPlan(planFile, plan => { plan.steps[0].args.subject = 'Changed after review'; });
    await expect(service.approve(actionId, { expectedPlanHash: reviewed.sha256 })).rejects.toThrow();
    expect(backend.calls).toEqual([]);
    const edited = await service.read(actionId);
    await writeFile(path.join(root, 'sequence.md'), 'The upstream sequence has changed.\n');
    await expect(service.approve(actionId, { expectedPlanHash: edited.sha256 })).rejects.toThrow();
    expect(backend.calls).toEqual([]);
  });

  it('invalidates approval when the plan changes while a backend call is pending', async () => {
    const { backend, service, planFile } = await fixture();
    let changed = false;
    backend.onExecute = async () => {
      if (!changed) {
        changed = true;
        await editPlan(planFile, plan => { plan.steps[1].args.subject = 'Changed during execution'; });
      }
    };
    const reviewed = await service.read(actionId);
    await service.approve(actionId, { expectedPlanHash: reviewed.sha256 }).catch(() => undefined);
    expect(backend.calls).toHaveLength(1);
  });

  it.each([
    ['prospect recipient on a later step', (plan: any) => { plan.steps[2].args.recipient_email = 'prospect@unrelated-company.dev'; }],
    ['extra cc recipient on a later step', (plan: any) => { plan.steps[2].args.cc = ['prospect@unrelated-company.dev']; }],
    ['extra bcc recipient on a later step', (plan: any) => { plan.steps[2].args.bcc = ['prospect@unrelated-company.dev']; }],
  ])('rejects a demo Gmail draft with %s', async (_label, edit) => {
    const { backend, service, planFile } = await fixture();
    await editPlan(planFile, edit);
    const reviewed = await service.read(actionId);
    const execution = await service.approve(actionId, { expectedPlanHash: reviewed.sha256 }).catch(() => ({ status: 'failed' }));
    expect(execution.status).toBe('failed');
    expect(backend.calls).toEqual([]);
  });
});

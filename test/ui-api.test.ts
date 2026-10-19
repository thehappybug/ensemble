import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntime, type WorkspaceRuntime } from '../src/daemon.js';
import { createApi } from '../src/server/api.js';
import { FakeRunner } from '../src/runner/FakeRunner.js';
import { ActionService } from '../src/actions/service.js';
import { writePlan, type ActionPlan } from '../src/actions/plan.js';
import type { ComposioBackend } from '../src/integrations/composio/backend.js';

const roots: string[] = [], runtimes: WorkspaceRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.close())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(path.join(os.tmpdir(), 'ensemble-ui-api-')); roots.push(value); return value; }
const json = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('UI detail and approval endpoints', () => {
  it('shows previous output history, changed input flags, and persisted activity after restart', async () => {
    const directory = await root(); let version = 0;
    await writeFile(path.join(directory, 'ensemble.yaml'), 'version: 1\nname: history-test\n');
    await writeFile(path.join(directory, '.gitignore'), '.ensemble/\n.env\n');
    await writeFile(path.join(directory, 'input.md'), 'Input one');
    await writeFile(path.join(directory, 'work.prompt.md'), '---\ninputs: [input.md]\noutputs: [out.md]\n---\nWrite output');
    const runner = new FakeRunner(async (_node, context) => { await writeFile(path.join(context.root, 'out.md'), `Version ${++version}\n`); return { summary: 'Test output' }; });
    const runtime = await createRuntime(directory, { runner }); runtimes.push(runtime); const app = createApi(runtime);
    await runtime.scheduler.run(); await writeFile(path.join(directory, 'input.md'), 'Input two'); await runtime.scheduler.run();
    const response = await app.request('/api/nodes/work/diff?path=out.md'); expect(response.status).toBe(200);
    const diff = await response.json(); expect(diff.before).toBe('Version 1\n'); expect(diff.after).toBe('Version 2\n'); expect(diff.diff).toContain('-Version 1'); expect(diff.diff).toContain('+Version 2');
    expect((await app.request('/api/nodes/work/diff?path=input.md')).status).toBe(403);
    expect((await app.request('/api/nodes/work/diff?path='+encodeURIComponent('../outside.md'))).status).toBe(403);
    await writeFile(path.join(directory, 'input.md'), 'Input three');
    const detail = await (await app.request('/api/nodes/work')).json(); expect(detail.inputDetails).toMatchObject([{ path: 'input.md', changed: true, missing: false }]); expect(detail.lastSuccess.commit).toMatch(/^[a-f0-9]{40}$/);
    expect((await (await app.request('/api/activity')).json()).filter((event: any) => event.type === 'run.finished')).toHaveLength(2);
    await runtime.close();
    const reopened = await createRuntime(directory, { runner: new FakeRunner() }); runtimes.push(reopened);
    const activity = await (await createApi(reopened).request('/api/activity')).json();
    const completed = activity.filter((event: any) => event.type === 'run.finished'); expect(completed).toHaveLength(2); expect(completed.every((event: any) => event.data.persisted && event.data.commit)).toBe(true);
    expect(activity.map((event: any) => event.at)).toEqual(activity.map((event: any) => event.at).sort());
  });

  it('downloads only actual PDFs under exports and rejects private symlink aliases', async () => {
    const directory = await root(); await writeFile(path.join(directory, 'ensemble.yaml'), 'version: 1\ngit:\n  auto_commit: false\n');
    await mkdir(path.join(directory, 'exports')); await writeFile(path.join(directory, 'exports/brief.pdf'), '%PDF-1.4\nTest PDF bytes\n');
    await writeFile(path.join(directory, '.env'), '%PDF-1.4\nPRIVATE_SECRET'); await symlink(path.join(directory, '.env'), path.join(directory, 'exports/alias.pdf'));
    await writeFile(path.join(directory, 'exports/not-pdf.pdf'), 'Not a PDF');
    const runtime = await createRuntime(directory, { runner: new FakeRunner() }); runtimes.push(runtime); const app = createApi(runtime);
    const response = await app.request('/api/download?path=exports/brief.pdf'); expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('application/pdf'); expect(response.headers.get('content-disposition')).toContain('inline'); expect(await response.text()).toContain('%PDF-1.4');
    for (const file of ['.env', 'exports/alias.pdf', '../elsewhere.pdf', 'ensemble.yaml']) expect((await app.request('/api/download?path='+encodeURIComponent(file))).status).toBe(403);
    expect((await app.request('/api/download?path=exports/missing.pdf')).status).toBe(404); expect((await app.request('/api/download?path=exports/not-pdf.pdf')).status).toBe(415);
  });

  it('reviews, edits, rejects, replans, and approves exact plans through an injected recording backend', async () => {
    const directory = await root(); await writeFile(path.join(directory, 'ensemble.yaml'), 'version: 1\ngit:\n  auto_commit: false\nvars:\n  demo_recipient: operator@gmail.com\n');
    await writeFile(path.join(directory, 'outreach.action.md'), '---\ntools:\n  composio: [GMAIL_CREATE_EMAIL_DRAFT]\n---\nPrepare a reviewed draft');
    let calls = 0;
    const backend: ComposioBackend = { getToolSchema: async slug => ({ slug, description: slug, tags: ['createHint'], inputSchema: { type: 'object', additionalProperties: true } }), searchTools: async () => [], execute: async () => { calls++; return { ok: true, data: { id: 'mock-draft' } }; }, connect: async () => ({ connected: false }), connections: async () => [] };
    const runner = new FakeRunner(async (node, context) => { const plan: ActionPlan = { action: node.path, instance: null, fingerprint: node.fingerprint, planned_at: new Date().toISOString(), run_id: context.runId, summary: 'Draft for review', steps: [{ id: 'draft', tool: 'GMAIL_CREATE_EMAIL_DRAFT', args: { recipient_email: 'operator@gmail.com', subject: 'Review subject', body: 'Review body' }, why: 'Save reviewed draft' }] }; await writePlan(directory, node, plan); return { summary: plan.summary }; });
    const runtime = await createRuntime(directory, { runner }); runtimes.push(runtime); await runtime.scheduler.run();
    const app = createApi(runtime, { actionService: new ActionService(runtime, { backend }) });
    let review = await (await app.request('/api/actions/outreach')).json(); expect(calls).toBe(0);
    expect((await app.request('/api/actions/outreach/approve', json({ dryRun: true }))).status).toBe(400);
    review.plan.steps[0].args.body = 'Edited full email body';
    const edited = await app.request('/api/actions/outreach/plan', json({ plan: review.plan, expectedPlanHash: review.sha256 }, 'PUT')); expect(edited.status).toBe(200);
    const next = await edited.json(); expect(next.sha256).not.toBe(review.sha256); expect(await readFile(path.join(directory, 'outreach.plan.md'), 'utf8')).toContain('Edited full email body');
    expect((await app.request('/api/actions/outreach/approve', json({ expectedPlanHash: review.sha256 }))).status).toBe(409);
    expect((await app.request('/api/actions/outreach/reject', json({ reason: 'Revise this plan' }))).status).toBe(200);
    expect((await app.request('/api/actions/outreach/approve', json({ expectedPlanHash: next.sha256 }))).status).toBe(409); expect(calls).toBe(0);
    const replanned = await app.request('/api/actions/outreach/plan', json({})); expect(replanned.status).toBe(200); review = await replanned.json();
    const dry = await app.request('/api/actions/outreach/approve', json({ expectedPlanHash: review.sha256, dryRun: true })); expect(dry.status).toBe(200); expect((await dry.json()).dry_run).toBe(true); expect(calls).toBe(0);
    const approved = await app.request('/api/actions/outreach/approve', json({ expectedPlanHash: review.sha256 })); expect(approved.status).toBe(200); const execution = await approved.json(); expect(execution.approved_by).toBe('ui'); expect(execution.steps[0].data.id).toBe('mock-draft'); expect(calls).toBe(1);
    expect((await app.request('/api/actions/outreach/approve', json({ expectedPlanHash: review.sha256 }))).status).toBe(200); expect(calls).toBe(1);
  });
});

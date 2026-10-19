import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Node, WorkspaceConfig } from '../types.js';
import { canonical, fileHash, readJSON, sha, writeJSON } from '../util.js';
import { assertSafePath } from '../workspace/paths.js';
import { validateToolArgs, type ComposioBackend } from '../integrations/composio/backend.js';
import { actionPaths, readPlan, references, simulatedToolSchema, validatePlan, type ActionPlan, type ActionStep } from './plan.js';

export interface StepReceipt { id: string; tool: string; status: 'running' | 'ok' | 'failed' | 'skipped' | 'uncertain'; resolved_args: Record<string, unknown>; args_sha256: string; data?: unknown; error?: string | null; log_id?: string; at: string; reason?: string }
export interface ExecutionReceipt { id: string; approved_by: string; approved_at: string; plan_sha256: string; dry_run: boolean; steps: StepReceipt[]; status: 'executing' | 'executed' | 'failed'; error?: string; ended_at?: string }
export interface ReceiptFile { executions: ExecutionReceipt[] }
export interface ExecuteOptions { root: string; config: WorkspaceConfig; node: Node; plan: ActionPlan; planHash: string; backend: ComposioBackend; dryRun?: boolean; force?: boolean; approvedBy?: string; checkFresh?: () => Promise<void>; emit?: (event: Record<string, unknown>) => void }

export function resolveReferences(value: unknown, results: Record<string, { data: unknown }>): unknown {
  const lookup = (reference: string): unknown => {
    const parts = reference.trim().split('.');
    if (parts.shift() !== 'steps') throw new Error(`Invalid step reference: ${reference}`);
    let current: unknown = results;
    for (const part of parts) {
      if (!part || ['__proto__', 'prototype', 'constructor'].includes(part) || current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) throw new Error(`Missing step result reference: ${reference}`);
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  };
  if (typeof value === 'string') {
    const whole = value.match(/^{{\s*([^{}]+?)\s*}}$/);
    if (whole) return lookup(whole[1]);
    return value.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, reference: string) => { const result = lookup(reference); return typeof result === 'object' ? JSON.stringify(result) : String(result); });
  }
  if (Array.isArray(value)) return value.map(item => resolveReferences(item, results));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveReferences(item, results)]));
  return value;
}

export function demoSafety(config: WorkspaceConfig, step: ActionStep, args: Record<string, unknown>, dryRun: boolean): void {
  const ownAddress = config.vars.demo_recipient;
  if (!Object.prototype.hasOwnProperty.call(config.vars, 'demo_recipient')) return;
  if (/^GMAIL_SEND(?:_|$)/.test(step.tool)) throw new Error('Demo actions must create drafts, never send email');
  if (step.tool !== 'GMAIL_CREATE_EMAIL_DRAFT') return;
  const own = String(ownAddress).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(own)) throw new Error('Set vars.demo_recipient to your own valid email address');
  const recipient = String(args.recipient_email ?? args.to ?? '').trim().toLowerCase();
  if (!recipient || recipient !== own) throw new Error('Demo Gmail drafts must be addressed only to vars.demo_recipient (your own address)');
  if (args.to !== undefined && String(args.to).trim().toLowerCase() !== own) throw new Error('Demo draft recipient aliases must match your own address');
  for (const field of ['cc', 'bcc', 'extra_recipients']) if (args[field] !== undefined && args[field] !== null && (Array.isArray(args[field]) ? (args[field] as unknown[]).length > 0 : String(args[field]).trim().length > 0)) throw new Error('Demo drafts cannot include cc, bcc, or extra recipients');
  if (!dryRun && /@(?:[^@]+\.)?example\.(?:com|org|net)$/.test(recipient)) throw new Error('Set vars.demo_recipient to your own real email before approving a real demo draft');
}

function simulatedData(step: ActionStep): Record<string, unknown> {
  const id = `simulated-${step.id}`;
  if (step.tool === 'LINEAR_LIST_LINEAR_TEAMS') return { simulated: true, teams: [{ id: '00000000-0000-4000-8000-000000000001', name: 'SIMULATED team' }] };
  if (step.tool === 'LINEAR_LIST_LINEAR_USERS') return { simulated: true, users: [{ id: '00000000-0000-4000-8000-000000000002', name: 'SIMULATED user' }] };
  return { simulated: true, id, ...(step.tool === 'GMAIL_CREATE_EMAIL_DRAFT' ? { message: { id: `${id}-message` } } : {}), ...(step.tool === 'LINEAR_CREATE_LINEAR_ISSUE' ? { url: `https://example.com/simulated/${id}` } : {}) };
}

export async function executeApprovedPlan(options: ExecuteOptions): Promise<ExecutionReceipt> {
  const { root, node, plan, planHash, backend } = options;
  const files = actionPaths(node);
  for (const file of [files.json, files.receipt]) assertSafePath(root, file);
  const current = await readPlan(root, node);
  if (current.sha256 !== planHash || canonical(current.plan) !== canonical(plan)) throw new Error('Approved plan does not match the exact plan file');
  await validatePlan(plan, node, backend);
  const dryRun = Boolean(options.dryRun || options.config.composio.dry_run || plan.simulated);
  // Reject unsafe static plans in full before the first provider call. Demo
  // recipients must be literal own addresses; dynamic result references are
  // useful for ticket links but cannot defer the recipient safety check.
  for (const step of plan.steps) demoSafety(options.config, step, step.args, dryRun);
  const receipt = await readJSON<ReceiptFile>(path.join(root, files.receipt), { executions: [] });
  if (!receipt || !Array.isArray(receipt.executions)) throw new Error('Invalid receipt history; refusing to overwrite it');
  // Replanning changes timestamps/run IDs and therefore the plan checksum. An
  // unresolved provider outcome still belongs to the same tool and payload,
  // even if the new plan gives that step another name.
  const payloadOutcomes = new Map<string, StepReceipt['status']>();
  for (const previous of receipt.executions) if (!previous.dry_run) for (const step of previous.steps) {
    if (['ok', 'running', 'uncertain'].includes(step.status)) payloadOutcomes.set(`${step.tool}:${step.args_sha256 ?? sha(canonical(step.resolved_args))}`, step.status);
  }
  const requireCertainPayload = (tool: string, argsHash: string) => {
    const outcome = payloadOutcomes.get(`${tool}:${argsHash}`);
    if (!dryRun && !options.force && outcome && ['running', 'uncertain'].includes(outcome)) throw new Error('A prior execution of this tool payload has an uncertain outcome; inspect provider state and use force only if safe');
  };
  for (const step of plan.steps) if (!references(step.args).length) requireCertainPayload(step.tool, sha(canonical(step.args)));
  const check = async () => {
    if (await fileHash(path.join(root, files.json)) !== planHash) throw new Error('Plan changed after approval; review and approve the new exact plan');
    await options.checkFresh?.();
  };
  await check();
  // A persisted running marker means a process may have died after the request
  // reached the provider. Explicit --force is needed after checking provider state.
  const latestOutcomes = new Map<string, StepReceipt['status']>();
  for (const previous of receipt.executions) if (previous.plan_sha256 === planHash && !previous.dry_run) for (const step of previous.steps) {
    if (['ok', 'running', 'uncertain'].includes(step.status)) latestOutcomes.set(`${step.id}:${step.tool}:${step.args_sha256}`, step.status);
  }
  if (!options.force && !dryRun && [...latestOutcomes.values()].some(status => ['running', 'uncertain'].includes(status))) throw new Error('A prior step has an uncertain outcome; inspect provider state and use force only if safe');
  const execution: ExecutionReceipt = { id: `execution_${randomUUID()}`, approved_by: options.approvedBy ?? 'cli', approved_at: new Date().toISOString(), plan_sha256: planHash, dry_run: dryRun, steps: [], status: 'executing' };
  receipt.executions.push(execution);
  const persist = () => writeJSON(path.join(root, files.receipt), receipt);
  const results: Record<string, { data: unknown }> = Object.create(null) as Record<string, { data: unknown }>;
  await persist();
  options.emit?.({ type: 'action.executing', execution: execution.id, dry_run: dryRun });
  try {
    for (const step of plan.steps) {
      await check();
      const args = resolveReferences(step.args, results) as Record<string, unknown>;
      const argsHash = sha(canonical(args));
      requireCertainPayload(step.tool, argsHash);
      const schema = plan.simulated ? simulatedToolSchema(step.tool) : await backend.getToolSchema(step.tool);
      validateToolArgs(schema.inputSchema, args);
      demoSafety(options.config, step, args, dryRun);
      const prior = !options.force ? receipt.executions.filter(previous => previous.id !== execution.id && previous.plan_sha256 === planHash && previous.dry_run === dryRun).flatMap(previous => previous.steps).reverse().find(previous => previous.id === step.id && previous.tool === step.tool && previous.args_sha256 === argsHash && previous.status === 'ok') : undefined;
      if (prior) {
        execution.steps.push({ id: step.id, tool: step.tool, status: 'skipped', resolved_args: args, args_sha256: argsHash, data: prior.data, error: null, at: new Date().toISOString(), reason: 'already executed' });
        results[step.id] = { data: prior.data };
        await persist();
        continue;
      }
      const entry: StepReceipt = { id: step.id, tool: step.tool, status: 'running', resolved_args: args, args_sha256: argsHash, at: new Date().toISOString() };
      execution.steps.push(entry);
      // Persist intent before crossing the network boundary.
      await persist();
      await check();
      if (dryRun) { entry.status = 'ok'; entry.data = simulatedData(step); entry.error = null; }
      else {
        try {
          const result = await backend.execute(step.tool, args);
          entry.status = result.ok ? 'ok' : 'failed'; entry.data = result.data; entry.error = result.error ?? null; entry.log_id = result.logId;
          if (!result.ok) throw new Error(result.error ?? `Tool failed: ${step.tool}`);
        } catch (error) {
          if (entry.status === 'running') entry.status = 'uncertain';
          entry.error = error instanceof Error ? error.message : String(error);
          await persist();
          throw error;
        }
      }
      results[step.id] = { data: entry.data };
      await persist();
      options.emit?.({ type: 'action.step.executed', execution: execution.id, step: entry });
    }
    await check();
    execution.status = 'executed';
  } catch (error) {
    execution.status = 'failed'; execution.error = error instanceof Error ? error.message : String(error);
    const pending = execution.steps.at(-1);
    if (pending?.status === 'running') { pending.status = 'failed'; pending.error = execution.error; }
  }
  execution.ended_at = new Date().toISOString();
  await persist();
  options.emit?.({ type: 'action.executed', execution });
  return execution;
}

import path from 'node:path';
import type { Node, NodeRecord, WorkspaceConfig } from '../types.js';
import type { Scheduler } from '../graph/scheduler.js';
import type { StateStore } from '../graph/state.js';
import type { EventBus } from '../server/bus.js';
import type { WorkspaceGit } from '../git.js';
import { readJSON } from '../util.js';
import { assertSafePath } from '../workspace/paths.js';
import { getBackend, type ComposioBackend } from '../integrations/composio/backend.js';
import { actionPaths, readPlan, validatePlan, writePlan, type ActionPlan } from './plan.js';
import { executeApprovedPlan, type ExecutionReceipt, type ReceiptFile } from './execute.js';

export interface ApprovalState { status: 'approved' | 'executing' | 'executed' | 'failed' | 'rejected'; plan_sha256: string; approved_at?: string; approved_by?: string; execution_id?: string; dry_run?: boolean; error?: string }
export interface ActionRuntime { root: string; config: WorkspaceConfig; scheduler: Scheduler; store: StateStore; bus: EventBus; git: WorkspaceGit }
export interface ApproveOptions { dryRun?: boolean; force?: boolean; approvedBy?: string; expectedPlanHash?: string }
const locks = new Map<string, Promise<unknown>>();

export class ActionService {
  constructor(private runtime: ActionRuntime, private options: { backend?: ComposioBackend } = {}) {}
  private get backend(): ComposioBackend { return this.options.backend ?? getBackend(this.runtime.root, this.runtime.config); }
  private lock<T>(id: string, callback: () => Promise<T>): Promise<T> {
    const key = this.runtime.root + ':' + id;
    const promise = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(callback);
    locks.set(key, promise);
    return promise;
  }
  private async node(id: string): Promise<Node> {
    await this.runtime.scheduler.refresh();
    const nodes = this.runtime.scheduler.graph.nodes.filter(node => node.kind === 'action' && (node.id === id || node.path === id));
    if (nodes.length !== 1) throw new Error(nodes.length ? 'Select one action instance to approve' : `Action not found: ${id}`);
    if (nodes[0].status === 'invalid') throw new Error(`Invalid action: ${nodes[0].reason ?? id}`);
    return nodes[0];
  }
  private record(node: Node): NodeRecord & { approval?: ApprovalState } { return this.runtime.store.record(node.id); }
  private async fresh(nodeId: string, plan: ActionPlan): Promise<Node> {
    const node = await this.node(nodeId);
    if (node.fingerprint !== plan.fingerprint) throw new Error('Action inputs changed since planning; replan before approval');
    if (['invalid', 'blocked', 'stale', 'running', 'pending-expansion'].includes(node.status)) throw new Error(`Action is not ready for approval: ${node.reason ?? node.status}`);
    for (const dependency of node.dependencies) {
      const upstream = this.runtime.scheduler.graph.nodes.find(candidate => candidate.id === dependency);
      if (!upstream || !['fresh', 'modified', 'awaiting-approval'].includes(upstream.status) || upstream.kind === 'fanout') throw new Error('Upstream work is not fresh; replan after it finishes');
    }
    return node;
  }
  async read(id: string): Promise<{ node: Node; plan: ActionPlan; sha256: string; receipt: ReceiptFile }> {
    const node = await this.node(id), review = await readPlan(this.runtime.root, node);
    const receiptPath = actionPaths(node).receipt; assertSafePath(this.runtime.root, receiptPath);
    const receipt = await readJSON<ReceiptFile>(path.join(this.runtime.root, receiptPath), { executions: [] });
    return { node, ...review, receipt };
  }
  async plan(id: string): Promise<{ node: Node; plan: ActionPlan; sha256: string; receipt: ReceiptFile }> {
    const node = await this.node(id);
    return this.lock(node.id, async () => {
      if (node.status === 'running' || this.record(node).approval?.status === 'executing') throw new Error('Action is already running');
      this.record(node).approval = undefined;
      await this.runtime.store.save();
      await this.runtime.scheduler.run({ targets: [node.id], force: true });
      const current = await this.node(node.id);
      if (current.status === 'failed') throw new Error(current.reason ?? 'Action planning failed');
      return this.read(node.id);
    });
  }
  async edit(id: string, value: unknown, options: { expectedPlanHash?: string } = {}) {
    const node = await this.node(id);
    return this.lock(node.id, async () => {
      const review = await readPlan(this.runtime.root, node);
      if (options.expectedPlanHash && review.sha256 !== options.expectedPlanHash) throw new Error('Plan changed since review; reload before editing');
      if (this.record(node).approval?.status === 'executing') throw new Error('Cannot edit an executing plan');
      const candidate = review.plan.simulated && value && typeof value === 'object' && !Array.isArray(value) ? { ...value, simulated: true } : value;
      const plan = await validatePlan(candidate, node, this.backend);
      if (plan.fingerprint !== node.fingerprint) throw new Error('Edited plan fingerprint must match current action inputs');
      await writePlan(this.runtime.root, node, plan);
      this.record(node).approval = undefined; this.record(node).rejected = undefined;
      await this.runtime.store.save();
      await this.runtime.git.commitFiles([actionPaths(node).json, actionPaths(node).markdown], `plan(${node.id}): edited action plan`);
      this.runtime.bus.emit('approval.requested', { node: node.id, edited: true });
      return this.read(node.id);
    });
  }
  async reject(id: string, reason = 'Rejected by user'): Promise<void> {
    const node = await this.node(id);
    await this.lock(node.id, async () => {
      const review = await readPlan(this.runtime.root, node);
      const record = this.record(node);
      record.rejected = node.fingerprint;
      record.approval = { status: 'rejected', plan_sha256: review.sha256, error: reason };
      await this.runtime.store.save();
      this.runtime.bus.emit('action.rejected', { node: node.id, reason });
    });
  }
  async approve(id: string, options: ApproveOptions = {}): Promise<ExecutionReceipt> {
    const initial = await this.node(id);
    return this.lock(initial.id, async () => {
      const review = await readPlan(this.runtime.root, initial);
      if (options.expectedPlanHash && options.expectedPlanHash !== review.sha256) throw new Error('Plan changed since review; approve the new exact plan');
      const node = await this.fresh(initial.id, review.plan);
      const plan = await validatePlan(review.plan, node, this.backend);
      const record = this.record(node);
      if (record.rejected === node.fingerprint || record.approval?.status === 'rejected') throw new Error('Plan was rejected; edit or replan before approving');
      record.approval = { status: 'approved', plan_sha256: review.sha256, approved_at: new Date().toISOString(), approved_by: options.approvedBy ?? 'cli' };
      await this.runtime.store.save();
      this.runtime.bus.emit('action.approved', { node: node.id, plan_sha256: review.sha256 });
      record.approval.status = 'executing'; await this.runtime.store.save();
      try {
        const execution = await executeApprovedPlan({ root: this.runtime.root, config: this.runtime.config, node, plan, planHash: review.sha256, backend: this.backend, ...options,
          checkFresh: async () => { await this.fresh(node.id, plan); }, emit: event => { this.runtime.bus.emit(String(event.type), { node: node.id, ...event }); } });
        record.approval = { ...record.approval, status: execution.status === 'executed' ? 'executed' : 'failed', execution_id: execution.id, dry_run: execution.dry_run, error: execution.error };
        await this.runtime.store.save();
        await this.runtime.git.commitFiles([actionPaths(node).receipt], `action(${node.id}): ${execution.dry_run ? 'SIMULATED ' : ''}${execution.status}\n\nplan: ${review.sha256}\nexecution: ${execution.id}`);
        await this.runtime.scheduler.refresh();
        return execution;
      } catch (error) {
        record.approval = { ...record.approval, status: 'failed', error: error instanceof Error ? error.message : String(error) };
        await this.runtime.store.save();
        throw error;
      }
    });
  }
}

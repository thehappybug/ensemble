import { useEffect, useState } from 'react';
import type { ActionPlan, ActionStep } from '../src/actions/plan.js';
import type { ExecutionReceipt, ReceiptFile } from '../src/actions/execute.js';
import type { GraphData, GraphNode } from './types.js';
import { api } from './api.js';
import './components.css';

interface ActionReview { node: GraphNode; plan: ActionPlan; sha256: string; receipt: ReceiptFile }
interface Props { graph: GraphData; onSelect: (node: GraphNode) => void; onRefresh: () => void }
const actionPath = (id: string, suffix = '') => `/api/actions/${encodeURIComponent(id)}${suffix}`;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export function approvalBlockReason(node: GraphNode): string | undefined {
  if (node.approval?.status === 'executing' || node.status === 'executing') return 'Execution is in progress.';
  if (node.approval?.status === 'rejected') return 'This plan was rejected. Edit or re-plan before approving.';
  if (['stale', 'invalid', 'blocked', 'running', 'queued', 'pending-expansion'].includes(node.status)) return node.reason ?? 'Wait for a fresh plan before approving.';
  return undefined;
}

export function isPendingApproval(node: GraphNode): boolean {
  return node.status === 'awaiting-approval' && (node.kind === 'fanout' || (node.kind === 'action' && node.approval?.status !== 'rejected'));
}
export function pendingApprovalNodes(graph: Pick<GraphData, 'nodes'>): GraphNode[] {
  return graph.nodes.filter(isPendingApproval);
}

export function receiptLinks(data: unknown): { label: string; href: string }[] {
  const links = new Map<string, string>();
  const visit = (value: unknown, label: string, depth: number) => {
    if (depth > 6 || links.size >= 30) return;
    if (typeof value === 'string') {
      try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol)) links.set(url.href, label || url.hostname); } catch {}
    } else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${label} ${index + 1}`, depth + 1));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => visit(item, key, depth + 1));
  };
  visit(data, '', 0);
  return [...links].map(([href, label]) => ({ label, href }));
}

function Field({ label, value }: { label: string; value: unknown }) {
  return <div className="review-field"><span className="field-label">{label}</span><div className="preserve-lines">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</div></div>;
}
function StepCard({ step }: { step: ActionStep }) {
  if (step.tool === 'GMAIL_CREATE_EMAIL_DRAFT') return <article className="email-card">
    <div className="card-kicker">Gmail draft · {step.id}</div>
    <Field label="To" value={step.args.recipient_email ?? step.args.to ?? 'Recipient missing'} />
    <Field label="Subject" value={step.args.subject ?? ''} />
    <Field label="Body" value={step.args.body ?? ''} />
    {step.args.cc !== undefined && <Field label="CC" value={step.args.cc} />}
    {step.args.bcc !== undefined && <Field label="BCC" value={step.args.bcc} />}
    <p className="muted">{step.why}</p>
  </article>;
  if (step.tool === 'LINEAR_CREATE_LINEAR_ISSUE') return <article className="ticket-card">
    <div className="card-kicker">Linear issue · {step.id}</div>
    <Field label="Title" value={step.args.title} />
    {Object.entries(step.args).filter(([key]) => key !== 'title').map(([key, value]) => <Field key={key} label={key.replaceAll('_', ' ')} value={value} />)}
    <p className="muted">{step.why}</p>
  </article>;
  return <article className="card"><div className="card-kicker">{step.readonly ? 'Read-only lookup' : 'Action'} · {step.id}</div><strong>{step.tool}</strong><pre>{JSON.stringify(step.args, null, 2)}</pre><p className="muted">{step.why}</p></article>;
}
export function PlanCards({ plan }: { plan: ActionPlan }) {
  return <div className="approval-plan">{plan.simulated && <div className="notice notice-simulated">SIMULATED plan · all execution stays simulated.</div>}<p>{plan.summary}</p>{plan.steps.map(step => <StepCard key={step.id} step={step} />)}</div>;
}

export function ReceiptView({ execution }: { execution: ExecutionReceipt }) {
  return <article className="receipt"><div className="receipt-heading"><strong>{execution.dry_run ? 'SIMULATED receipt' : 'Execution receipt'}</strong><span className={`chip ${execution.status === 'failed' ? 'chip-error' : ''}`}>{execution.status}</span></div>
    <p className="muted">Approved via {execution.approved_by} · {new Date(execution.approved_at).toLocaleString()}</p>
    {execution.error && <div className="notice notice-error">{execution.error}</div>}
    {execution.steps.map((step, index) => <div className="receipt-step" key={`${step.id}-${index}`}><div><strong>{step.id}</strong> <span className="chip">{step.status}</span></div><div className="mono muted">{step.tool}</div>{step.error && <p className="error-text">{step.error}</p>}{step.reason && <p className="muted">{step.reason}</p>}{receiptLinks(step.data).map(link => <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer">{link.label} ↗</a>)}<details><summary>Arguments and returned data</summary><pre>{JSON.stringify({ args: step.resolved_args, data: step.data }, null, 2)}</pre></details></div>)}
  </article>;
}

export function ReviewControls({ node, reviewed, busy, simulated, onApprove, onReject, onEdit }: {
  node: GraphNode; reviewed: boolean; busy: boolean; simulated: boolean;
  onApprove: (dryRun: boolean) => void; onReject: () => void; onEdit: () => void;
}) {
  const reason = approvalBlockReason(node);
  const disabled = busy || !reviewed || !!reason;
  return <div className="review-controls">{reason && <p className="notice">{reason}</p>}<div className="button-row"><button className="button button-primary" disabled={disabled} onClick={() => onApprove(false)}>{simulated ? 'Approve simulation' : 'Approve'}</button><button className="button" disabled={disabled} onClick={() => onApprove(true)}>Approve dry run</button><button className="button button-subtle" disabled={busy || !reviewed || node.approval?.status === 'executing'} onClick={onEdit}>Edit JSON</button><button className="button button-danger" disabled={disabled} onClick={onReject}>Reject</button></div></div>;
}

function ActionReviewPanel({ node, forcedSimulation, onRefresh }: { node: GraphNode; forcedSimulation: boolean; onRefresh: () => void }) {
  const [review, setReview] = useState<ActionReview | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(''), [rejecting, setRejecting] = useState(false), [reason, setReason] = useState('');
  useEffect(() => {
    if (editing) return;
    const controller = new AbortController();
    api<ActionReview>(actionPath(node.id), { signal: controller.signal }).then(value => { setReview(value); setError(''); }).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => controller.abort();
  }, [node.id, node.fingerprint, node.lastRun?.runId, node.status, node.approval?.execution_id]);
  const perform = async (callback: () => Promise<unknown>) => { setBusy(true); setError(''); try { await callback(); onRefresh(); } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); } };
  const approve = (dryRun: boolean) => { if (!review || editing) return; void perform(async () => { await api(actionPath(node.id, '/approve'), { method: 'POST', body: { dryRun, expectedPlanHash: review.sha256 } }); setReview(await api<ActionReview>(actionPath(node.id))); }); };
  const save = () => { if (!review) return; void perform(async () => { const plan: unknown = JSON.parse(draft); const saved = await api<ActionReview>(actionPath(node.id, '/plan'), { method: 'PUT', body: { plan, expectedPlanHash: review.sha256 } }); setReview(saved); setEditing(false); }); };
  const reject = () => void perform(async () => { await api(actionPath(node.id, '/reject'), { method: 'POST', body: { reason } }); setRejecting(false); });
  return <section className="approval-review"><div className="approval-review-header"><div><div className="card-kicker">Exact plan review</div><h2>{node.fm.description ?? node.id}</h2><p className="mono muted">{node.path}</p></div><button className="button" disabled={busy || node.status === 'running' || node.approval?.status === 'executing'} onClick={() => void perform(async () => { setReview(await api<ActionReview>(actionPath(node.id, '/plan'), { method: 'POST', body: {} })); })}>Re-plan</button></div>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {!review ? <p className="empty-state">Loading the reviewable plan…</p> : <>
      <div className="review-hash mono" title={review.sha256}>Reviewed plan · {review.sha256.slice(-16)}</div>
      {(forcedSimulation || review.plan.simulated) && <div className="notice notice-simulated">SIMULATED execution · no connected service writes.</div>}
      {editing ? <div className="json-editor"><label className="field-label" htmlFor="action-plan-json">Edit this plan JSON</label><textarea id="action-plan-json" spellCheck={false} value={draft} onChange={event => setDraft(event.target.value)} /><div className="button-row"><button className="button button-primary" disabled={busy} onClick={save}>Save reviewed plan</button><button className="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button></div><p className="muted">Saving changes never executes the plan. Approval uses its new checksum.</p></div> : <PlanCards plan={review.plan} />}
      {!editing && <ReviewControls node={node} reviewed={!!review.sha256} busy={busy} simulated={forcedSimulation || !!review.plan.simulated} onApprove={approve} onReject={() => setRejecting(true)} onEdit={() => { setDraft(JSON.stringify(review.plan, null, 2)); setEditing(true); }} />}
      {rejecting && <div className="reject-form"><label className="field-label" htmlFor="reject-reason">Reason (optional)</label><input id="reject-reason" value={reason} onChange={event => setReason(event.target.value)} /><div className="button-row"><button className="button button-danger" disabled={busy} onClick={reject}>Reject this plan</button><button className="button" onClick={() => setRejecting(false)}>Cancel</button></div></div>}
      {review.receipt.executions.length > 0 && <div className="receipt-history"><h3>Receipts</h3>{[...review.receipt.executions].reverse().map(execution => <ReceiptView key={execution.id} execution={execution} />)}</div>}
    </>}
  </section>;
}

export function Approvals({ graph, onSelect, onRefresh }: Props) {
  const pending = pendingApprovalNodes(graph);
  const [selectedId, setSelectedId] = useState<string | null>(() => pending.find(node => node.kind === 'action')?.id ?? null), [error, setError] = useState(''), [busyId, setBusyId] = useState('');
  const selected = graph.nodes.find(node => node.id === selectedId && node.kind === 'action');
  useEffect(() => { if (!selectedId) setSelectedId(pending.find(node => node.kind === 'action')?.id ?? null); }, [pending.map(node => node.id).join('|'), selectedId]);
  const approveFanout = async (node: GraphNode) => { setBusyId(node.id); setError(''); try { await api(`/api/fanout/${encodeURIComponent(node.id)}/approve`, { method: 'POST', body: {} }); await api('/api/run', { method: 'POST', body: { targets: [node.id], downstream: true } }); onRefresh(); } catch (error) { setError(errorMessage(error)); } finally { setBusyId(''); } };
  return <div className="approvals-layout"><aside className="approval-queue"><div className="section-kicker">Human approval</div><h1>Approvals <span className="count-badge">{pending.length}</span></h1><p className="muted">Review the exact plan before any action executes.</p>{error && <p className="notice notice-error">{error}</p>}{pending.length === 0 && <div className="empty-state">No pending approvals. New action plans will appear here.</div>}{pending.map(node => node.kind === 'fanout' ? <article className="card" key={node.id}><div className="card-kicker">Fan-out expansion</div><strong>{node.fm.description ?? node.id}</strong><p>Allow {node.expansionCount ?? 'new'} independent instances?</p><p className="muted">Each instance can incur model and research costs.</p><button className="button button-primary" disabled={busyId === node.id} onClick={() => void approveFanout(node)}>Approve {node.expansionCount ?? ''} instances</button></article> : <button key={node.id} className={`approval-card ${selectedId === node.id ? 'selected' : ''}`} onClick={() => { setSelectedId(node.id); }}><span className="card-kicker">{node.approval?.status === 'executing' ? 'Executing' : 'Action plan'}</span><strong>{node.fm.description ?? node.id}</strong><span className="mono muted">{node.path}</span><span className="chip">{graph.simulated || graph.actionsDryRun ? 'SIMULATED' : 'Review required'}</span></button>)}{selected && <button className="button button-subtle" onClick={() => onSelect(selected)}>Open selected node details ↗</button>}</aside><div className="approval-detail">{selected ? <ActionReviewPanel key={selected.id} node={selected} forcedSimulation={!!graph.simulated || !!graph.actionsDryRun} onRefresh={onRefresh} /> : <div className="empty-state approval-empty"><div className="empty-orbit">✓</div><h2>Every action starts with a review.</h2><p>Plans are files. Execution waits for your approval.</p></div>}</div></div>;
}
export default Approvals;

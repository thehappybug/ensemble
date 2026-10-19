import { useEffect, useRef, useState } from 'react';
import type { RunMeta } from '../src/types.js';
import type { GraphNode, NodeDetail, WorkspaceEvent } from './types.js';
import { api, nodePath } from './api.js';
import { Markdown } from './Markdown.js';
import './components.css';

interface Props { node: GraphNode | null; onClose: () => void; onRefresh: () => void; events?: WorkspaceEvent[]; onFile?: (path: string) => void }
type Tab = 'Prompt' | 'Inputs' | 'Outputs' | 'Live' | 'History';
interface Diff { path: string; commit?: string; before: string; after: string; diff: string }
interface LogEvent { at?: string; type?: string; [key: string]: unknown }
interface DetailedNode extends NodeDetail {
  inputDetails?: { path: string; hash: string; previousHash?: string; changed: boolean; missing: boolean }[];
  removedInputs?: string[];
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const price = (value?: number) => `$${(value ?? 0).toFixed(4)}`;

export function promptRunRequest(node: GraphNode, replaceEditedOutputs = false): { targets: string[]; failed?: true; force?: true } {
  return { targets: [node.id], ...(node.status === 'failed' ? { failed: true as const } : {}), ...(node.status === 'modified' && replaceEditedOutputs ? { force: true as const } : {}) };
}

function StreamEvent({ event }: { event: LogEvent }) {
  const payload = event.type === 'cline.event' && event.event && typeof event.event === 'object' ? event.event as Record<string, unknown> : event;
  const type = String(payload.type ?? event.type ?? 'event');
  const text = typeof payload.text === 'string' ? payload.text : typeof payload.delta === 'string' ? payload.delta : undefined;
  if (text && (payload.contentType === 'text' || /text|content_delta/.test(type))) return <div className="stream-text preserve-lines">{text}</div>;
  if (type === 'ensemble.note' || type === 'simulation' || type === 'warning' || type === 'error') return <div className={`stream-note ${type === 'error' ? 'notice-error' : ''}`}><span className="card-kicker">{type}</span>{String(payload.message ?? '')}</div>;
  const tool = payload.toolName ?? payload.tool ?? payload.endpoint;
  if (tool || payload.contentType === 'tool' || type === 'parallel.call' || type === 'tool_result') return <details className="stream-event"><summary><span className="mono">{String(tool ?? 'Tool result')}</span>{payload.cached === true && <span className="chip">cached</span>}{typeof payload.elapsed_ms === 'number' && <span className="muted">{(payload.elapsed_ms / 1000).toFixed(1)}s</span>}<span className="muted">{type}</span></summary><pre>{JSON.stringify(payload.input ?? payload, null, 2)}</pre></details>;
  return <details className="stream-event muted"><summary>{type}{event.at && <time>{new Date(event.at).toLocaleTimeString()}</time>}</summary><pre>{JSON.stringify(payload, null, 2)}</pre></details>;
}

export function UnifiedDiff({ content }: { content: string }) {
  return content ? <pre className="unified-diff">{content.split('\n').map((line, index) => <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''}>{line}{'\n'}</span>)}</pre> : <p className="empty-state">No changes against the previous committed version.</p>;
}

export function NodeDrawer({ node, onClose, onRefresh, onFile }: Props) {
  const [detail, setDetail] = useState<DetailedNode | null>(null), [tab, setTab] = useState<Tab>('Prompt');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [force, setForce] = useState(false), [revision, setRevision] = useState(0);
  const [output, setOutput] = useState(''), [fileContent, setFileContent] = useState(''), [diff, setDiff] = useState<Diff | null>(null), [showDiff, setShowDiff] = useState(false), [outputError, setOutputError] = useState('');
  const [logs, setLogs] = useState<LogEvent[]>([]), [logError, setLogError] = useState(''), [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const streamEnd = useRef<HTMLDivElement>(null);
  const id = node?.id;
  useEffect(() => { setDetail(null); setTab('Prompt'); setOutput(''); setFileContent(''); setDiff(null); setError(''); setSelectedRun(null); setForce(false); }, [id]);
  useEffect(() => { if (node?.status !== 'modified') setForce(false); }, [id, node?.status]);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    api<DetailedNode>(nodePath(id), { signal: controller.signal }).then(value => { setDetail(value); setError(''); }).catch(error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => controller.abort();
  }, [id, node?.fingerprint, node?.status, node?.lastRun?.runId, revision]);
  const selectedDetail = detail?.id === node?.id ? detail : null;
  const current = selectedDetail ?? node;
  const activeRunId = selectedRun ?? current?.lastRun?.runId;
  const runIsActive = !!activeRunId && activeRunId === node?.lastRun?.runId && node?.lastRun?.status === 'running';
  useEffect(() => {
    if (!activeRunId || tab !== 'Live') { setLogs([]); return; }
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(activeRunId)}/events`, { signal: controller.signal });
        if (response.status === 404) { setLogs([]); setLogError(''); return; }
        if (!response.ok) throw new Error(`Cannot load run events (${response.status})`);
        const text = await response.text();
        const lines = text.split('\n').filter(Boolean);
        const parsed: LogEvent[] = [];
        for (const line of lines) { try { parsed.push(JSON.parse(line) as LogEvent); } catch {} }
        setLogs(parsed); setLogError('');
      } catch (error) { if (!controller.signal.aborted) setLogError(message(error)); }
    };
    void load();
    const timer = runIsActive ? setInterval(() => void load(), 1000) : undefined;
    return () => { controller.abort(); if (timer) clearInterval(timer); };
  }, [activeRunId, runIsActive, node?.status, tab]);
  useEffect(() => {
    if (!current) return;
    if (!current.outputs.includes(output)) setOutput(current.outputs.find(path => !path.endsWith('.receipt.json')) ?? current.outputs[0] ?? '');
  }, [id, current?.outputs.join('|')]);
  useEffect(() => {
    if (!output || !id || tab !== 'Outputs') return;
    const controller = new AbortController();
    setFileContent(''); setDiff(null); setOutputError('');
    api<{ content: string }>(`/api/files?path=${encodeURIComponent(output)}`, { signal: controller.signal }).then(file => setFileContent(file.content)).catch(error => { if (!controller.signal.aborted) setOutputError(message(error)); });
    api<Diff>(`${nodePath(id, '/diff')}?path=${encodeURIComponent(output)}`, { signal: controller.signal }).then(setDiff).catch(() => {});
    return () => controller.abort();
  }, [id, output, node?.lastRun?.runId, node?.status, revision, tab]);

  useEffect(() => { if (tab === 'Live' && follow) streamEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [logs.length, tab, follow]);

  if (!node || !current) return null;
  const act = async (callback: () => Promise<unknown>) => { setBusy(true); setError(''); try { await callback(); setRevision(value => value + 1); onRefresh(); } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  const run = () => void act(() => node.kind === 'action' ? api(`/api/actions/${encodeURIComponent(node.id)}/plan`, { method: 'POST', body: {} }) : api('/api/run', { method: 'POST', body: promptRunRequest(node, force) }));
  const isRunning = node.status === 'running' || node.lastRun?.status === 'running';
  const runs = selectedDetail?.runs ?? [];
  const baseline = runs.find(run => run.status === 'completed')?.inputs ?? current.lastRun?.inputs ?? {};
  const inputs = selectedDetail?.inputDetails ?? current.inputs.map(path => ({ path, hash: selectedDetail?.inputHashes?.[path] ?? 'pending', previousHash: baseline[path], changed: !!baseline[path] && baseline[path] !== selectedDetail?.inputHashes?.[path], missing: selectedDetail?.inputHashes?.[path] === 'missing' }));
  return <aside className="drawer" role="dialog" aria-label={`Node details: ${node.fm.description ?? node.id}`} aria-modal="false"><header className="drawer-header"><div><div className="card-kicker">{node.kind}{node.item ? ` · ${String(node.item._key)}` : ''}</div><h2>{node.fm.description ?? node.id}</h2><p className="mono muted">{node.path}</p></div><button className="button button-subtle close-drawer" aria-label="Close node details" onClick={onClose}>×</button></header>
    <div className="drawer-summary"><div className="chips"><span className={`chip status-${node.status}`}>{node.status}</span><span className="chip">{node.fm.model ?? node.model}</span><span className="chip">{node.kind === 'action' ? `plan: ${node.fm.plan}` : node.fm.mode}</span>{node.fm.schedule && <span className="chip">↻ {node.fm.schedule}</span>}</div>{node.reason && <p className="stale-reason">{node.reason}</p>}{error && <div className="notice notice-error" role="alert">{error}</div>}
      <div className="button-row">{isRunning && node.lastRun ? <button className="button button-danger" disabled={busy} onClick={() => void act(() => api('/api/abort', { method: 'POST', body: { runId: node.lastRun!.runId } }))}>Abort run</button> : <button className="button button-primary" disabled={busy || ['invalid', 'blocked', 'pending-expansion'].includes(node.status) || node.kind === 'fanout' || (node.status === 'modified' && !force)} onClick={run}>{node.kind === 'action' ? 'Re-plan action' : 'Run prompt'}</button>}
      {node.status === 'modified' && <><label className="force-option"><input type="checkbox" checked={force} onChange={event => setForce(event.target.checked)} />Replace edited outputs</label><button className="button" disabled={busy} onClick={() => void act(() => api(nodePath(node.id, '/accept-edit'), { method: 'POST', body: {} }))}>Accept manual edit</button></>}
      </div>
    </div>
    <nav className="tabs" aria-label="Node detail tabs">{(['Prompt', 'Inputs', 'Outputs', 'Live', 'History'] as Tab[]).map(name => <button key={name} className={`tab ${tab === name ? 'active' : ''}`} aria-selected={tab === name} onClick={() => setTab(name)}>{name}{name === 'Inputs' && <span>{current.inputs.length}</span>}{name === 'Live' && isRunning && <span className="live-dot" />}</button>)}</nav>
    <div className="drawer-body">
      {tab === 'Prompt' && <><div className="chips"><span className="chip">{current.inputs.length} inputs</span><span className="chip">{current.outputs.length} outputs</span><span className="chip">Parallel: {Array.isArray(node.fm.tools.parallel) ? node.fm.tools.parallel.join(', ') || 'off' : String(node.fm.tools.parallel)}</span>{node.fm.tools.composio.length > 0 && <span className="chip">Composio: {node.fm.tools.composio.join(', ')}</span>}<span className="chip">Shell: {node.fm.tools.shell ? 'guarded reads' : 'off'}</span></div><Markdown content={current.body} sourcePath={node.path} onFile={onFile} />{current.warnings.length > 0 && <div className="notice">{current.warnings.map(warning => <p key={warning}>{warning}</p>)}</div>}</>}
      {tab === 'Inputs' && <><p className="muted">Content hashes show what changed since the last successful run.</p>{inputs.length === 0 && <p className="empty-state">This node has no declared file inputs.</p>}{inputs.map(input => <div className={`input-row ${input.changed ? 'input-changed' : ''}`} key={input.path}><div><strong className="mono">{input.path}</strong>{input.changed && <span className="chip">changed</span>}{input.missing && <span className="chip chip-error">missing</span>}</div><div className="mono muted hash-line" title={input.hash}>{input.hash}</div>{input.changed && input.previousHash && <div className="mono muted hash-line" title={input.previousHash}>Previously {input.previousHash}</div>}</div>)}{selectedDetail?.removedInputs?.map(path => <div className="input-row" key={path}><span className="mono">{path}</span> <span className="chip">removed</span></div>)}</>}
      {tab === 'Outputs' && <><label className="field-label" htmlFor="selected-node-output">Declared output</label><select id="selected-node-output" className="output-select" value={output} onChange={event => setOutput(event.target.value)}>{current.outputs.map(path => <option key={path} value={path}>{path}</option>)}</select><div className="button-row output-toolbar"><button className={`button ${!showDiff ? 'selected' : ''}`} onClick={() => setShowDiff(false)}>Preview</button><button className={`button ${showDiff ? 'selected' : ''}`} onClick={() => setShowDiff(true)}>Diff{diff?.commit ? ` · ${diff.commit.slice(0, 7)}` : ''}</button></div>{outputError ? <p className="notice">{outputError}</p> : showDiff ? diff ? <UnifiedDiff content={diff.diff} /> : <p className="empty-state">No committed comparison is available yet.</p> : output.endsWith('.md') ? <Markdown content={fileContent} sourcePath={output} onFile={onFile} /> : <pre className="file-preview">{fileContent || 'This output has not been generated yet.'}</pre>}</>}
      {tab === 'Live' && <><div className="stream-heading"><span className="mono muted">{activeRunId ?? 'No runs yet'}</span>{runIsActive && <span className="chip"><span className="live-dot" />Live</span>}<label className="muted"><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} /> Follow latest</label></div>{logError && <p className="notice notice-error">{logError}</p>}<div className="stream" role="log" aria-live="polite">{logs.length === 0 ? <p className="empty-state">{runIsActive ? 'Waiting for the first run event…' : 'Run this node to see agent text, notes, and tool calls.'}</p> : logs.slice(-400).map((event, index) => <StreamEvent key={`${activeRunId}-${index}`} event={event} />)}<div ref={streamEnd} /></div></>}
      {tab === 'History' && <>{runs.length === 0 && <p className="empty-state">No recorded runs yet.</p>}{runs.map((run: RunMeta) => <article className="run-row" key={run.runId}><div className="run-heading"><strong>{run.summary ?? run.status}</strong><span className="chip">{run.status}</span></div><p className="muted">{new Date(run.started_at).toLocaleString()}</p><div className="chips"><span className="chip">{run.model}</span><span className="chip">LLM {price(run.cost)}</span><span className="chip">Parallel {price(run.parallel_cost)}</span>{run.commit && <span className="chip mono" title={run.commit}>git {run.commit.slice(0, 7)}</span>}</div>{run.error && <p className="notice notice-error">{run.error}</p>}<button className="button button-subtle" onClick={() => { setSelectedRun(run.runId); setTab('Live'); }}>View run stream ↗</button></article>)}</>}
    </div>
  </aside>;
}
export default NodeDrawer;

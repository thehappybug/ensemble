import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ActionPlan } from '../src/actions/plan.js';
import type { ExecutionReceipt } from '../src/actions/execute.js';
import { frontmatterSchema } from '../src/workspace/frontmatter.js';
import type { GraphNode } from '../ui/types.js';
import { Markdown, markdownFileTarget } from '../ui/Markdown.js';
import { PlanCards, ReceiptView, ReviewControls, approvalBlockReason, pendingApprovalNodes, receiptLinks } from '../ui/Approvals.js';
import { UnifiedDiff } from '../ui/Drawer.js';

const node: GraphNode = {
  id: 'outreach', path: 'outreach.action.md', kind: 'action', status: 'awaiting-approval',
  fm: frontmatterSchema.parse({ tools: { parallel: [], composio: ['GMAIL_CREATE_EMAIL_DRAFT'] } }),
  body: 'Plan drafts', inputs: [], inputPatterns: [], outputs: [], dependencies: [], fingerprint: 'sha256:unit', model: 'unit-test', warnings: [],
};
const plan: ActionPlan = {
  action: node.path, instance: null, fingerprint: node.fingerprint, planned_at: '2026-10-19T10:00:00Z', run_id: 'run_unit', summary: 'One reviewed draft',
  steps: [{ id: 'draft_1', tool: 'GMAIL_CREATE_EMAIL_DRAFT', why: 'Review before creating',
    args: { recipient_email: 'operator@gmail.com', subject: 'A reviewed subject', body: 'First paragraph.\nSecond paragraph.\n<script>unsafe()</script>', is_html: false } }],
};
const receipt: ExecutionReceipt = {
  id: 'execution_unit', approved_by: 'ui', approved_at: '2026-10-19T10:00:00Z', plan_sha256: 'sha256:unit', dry_run: true, status: 'executed',
  steps: [{ id: 'ticket', tool: 'LINEAR_CREATE_LINEAR_ISSUE', status: 'ok', resolved_args: {}, args_sha256: 'sha256:args', at: '2026-10-19T10:00:00Z',
    data: { url: 'https://linear.app/own-workspace/issue/TEST-1', unsafe: 'javascript:alert(1)', nested: { file: 'file:///etc/passwd' } } }],
};

describe('UI review and document safety', () => {
  it('renders full email content as escaped text, not active HTML', () => {
    const html = renderToStaticMarkup(<PlanCards plan={plan} />);
    expect(html).toContain('operator@gmail.com');
    expect(html).toContain('A reviewed subject');
    expect(html).toContain('First paragraph.\nSecond paragraph.');
    expect(html).toContain('&lt;script&gt;unsafe()&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('escapes raw markdown HTML and disallows executable links while preserving citations', () => {
    const html = renderToStaticMarkup(<Markdown content={'# Research\n\n<script>unsafe()</script>\n\n[bad](javascript:alert(1)) [source](https://example.org/report)'} />);
    expect(html).toContain('<h1>Research</h1>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://example.org/report"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('resolves workspace-relative document links without treating external URLs as files', () => {
    expect(markdownFileTarget('../AGENTS.md', 'coding-agents/companies/AGENTS.md')).toBe('coding-agents/AGENTS.md');
    expect(markdownFileTarget('/context/icp.md', 'coding-agents/AGENTS.md')).toBe('context/icp.md');
    expect(markdownFileTarget('people.md#sources', 'coding-agents/company/AGENTS.md')).toBe('coding-agents/company/people.md');
    expect(markdownFileTarget('https://example.org/report', 'AGENTS.md')).toBeUndefined();
    expect(markdownFileTarget('//example.org/report', 'AGENTS.md')).toBeUndefined();
    expect(markdownFileTarget('javascript:alert(1)', 'AGENTS.md')).toBeUndefined();
    expect(markdownFileTarget('#sources', 'AGENTS.md')).toBeUndefined();
  });

  it('shows simulation clearly and exposes only http(s) receipt links', () => {
    expect(receiptLinks(receipt.steps[0].data)).toEqual([{ label: 'url', href: 'https://linear.app/own-workspace/issue/TEST-1' }]);
    const html = renderToStaticMarkup(<ReceiptView execution={receipt} />);
    expect(html).toContain('SIMULATED receipt');
    expect(html).toContain('href="https://linear.app/own-workspace/issue/TEST-1"');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="file:');
  });

  it('keeps dry-run approvals pending for a subsequent explicit real approval', () => {
    const simulated = { ...node, approval: { status: 'executed' as const, dry_run: true, plan_sha256: 'sha256:unit' } };
    const rejected = { ...node, id: 'rejected', approval: { status: 'rejected' as const, plan_sha256: 'sha256:unit' } };
    const executed = { ...node, id: 'executed', status: 'fresh' as const, approval: { status: 'executed' as const, dry_run: false, plan_sha256: 'sha256:unit' } };
    expect(pendingApprovalNodes({ nodes: [simulated, rejected, executed] })).toEqual([simulated]);
  });

  it('disables approval until a reviewed checksum exists and while the action is stale or executing', () => {
    const controls = (value: GraphNode, reviewed: boolean) => renderToStaticMarkup(<ReviewControls node={value} reviewed={reviewed} busy={false} simulated={false} onApprove={() => {}} onReject={() => {}} onEdit={() => {}} />);
    expect(controls(node, false)).toMatch(/disabled=""[^>]*>Approve<\/button>/);
    expect(controls(node, true)).not.toMatch(/disabled=""[^>]*>Approve<\/button>/);
    const stale = { ...node, status: 'stale' as const, reason: 'Upstream changed' };
    expect(approvalBlockReason(stale)).toBe('Upstream changed');
    expect(controls(stale, true)).toMatch(/disabled=""[^>]*>Approve<\/button>/);
    const executing = { ...node, approval: { status: 'executing' as const, plan_sha256: 'sha256:unit' } };
    expect(controls(executing, true)).toMatch(/disabled=""[^>]*>Approve<\/button>/);
    expect(controls(node, true)).toContain('Approve dry run');
  });

  it('escapes untrusted lines in git diffs and distinguishes additions from removals', () => {
    const html = renderToStaticMarkup(<UnifiedDiff content={'@@ -1 +1 @@\n-Old\n+<img src=x onerror=unsafe()>'} />);
    expect(html).toContain('diff-add');
    expect(html).toContain('diff-remove');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });
});

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createTool, type AgentTool } from '@cline/sdk';
import { z } from 'zod';
import type { Node } from '../types.js';
import type { RunContext } from '../runner/Runner.js';
import { atomicWrite, sha, writeJSON } from '../util.js';
import { assertSafePath } from '../workspace/paths.js';
import { getBackend, isReadOnlyTool, validateToolArgs, type ComposioBackend, type ToolSchema } from '../integrations/composio/backend.js';

export const stepSchema = z.object({ id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/), tool: z.string().regex(/^[A-Z][A-Z0-9_]+$/), args: z.record(z.string(), z.unknown()), why: z.string().min(1), readonly: z.boolean().optional() }).strict();
export const planSchema = z.object({ action: z.string(), instance: z.union([z.string(), z.null()]), fingerprint: z.string(), planned_at: z.string(), run_id: z.string(), summary: z.string().min(1), steps: z.array(stepSchema).min(1), simulated: z.boolean().optional() }).strict();
export type ActionStep = z.infer<typeof stepSchema>;
export type ActionPlan = z.infer<typeof planSchema>;
export interface PlanningAdapter { tools: AgentTool[]; instruction: string; finalize(summary: string): Promise<void> }

export function actionPaths(node: Node): { json: string; markdown: string; receipt: string } {
  const json = node.outputs.find(file => file.endsWith('.plan.json'));
  const markdown = node.outputs.find(file => file.endsWith('.plan.md'));
  const receipt = node.outputs.find(file => file.endsWith('.receipt.json'));
  if (!json || !markdown || !receipt) throw new Error('Action is missing its fixed plan/receipt paths');
  return { json, markdown, receipt };
}
export function toolAllowed(node: Node, slug: string): boolean {
  return node.fm.tools.composio.some(allowed => allowed === slug || allowed.toLowerCase() === slug.split('_')[0].toLowerCase());
}

export function references(value: unknown): string[] {
  if (typeof value === 'string') return [...value.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map(match => match[1].trim());
  if (Array.isArray(value)) return value.flatMap(references);
  if (value && typeof value === 'object') return Object.values(value).flatMap(references);
  return [];
}
export function validateReferences(step: ActionStep, earlier: Set<string>): void {
  for (const reference of references(step.args)) {
    const match = reference.match(/^steps\.([A-Za-z][A-Za-z0-9_-]*)\.data(?:\.[A-Za-z0-9_-]+)*$/);
    if (!match || !earlier.has(match[1]) || /(?:^|\.)(?:__proto__|constructor|prototype)(?:\.|$)/.test(reference)) throw new Error(`Step ${step.id} references a missing or later step: ${reference}`);
  }
}

/** Only explicit simulated plans use fixtures; real plans always fetch schemas. */
export function simulatedToolSchema(slug: string): ToolSchema {
  const properties = slug === 'GMAIL_CREATE_EMAIL_DRAFT' ? { recipient_email: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, is_html: { type: 'boolean' } }
    : slug === 'LINEAR_CREATE_LINEAR_ISSUE' ? { title: { type: 'string' }, team_id: { type: 'string' }, description: { type: 'string' } }
    : /LINEAR_LIST_LINEAR_(TEAMS|USERS)/.test(slug) ? {} : undefined;
  if (!properties) throw new Error(`No simulated schema fixture for ${slug}`);
  return { slug, description: 'SIMULATED schema fixture', inputSchema: { type: 'object', properties, required: slug === 'LINEAR_CREATE_LINEAR_ISSUE' ? ['title', 'team_id'] : slug === 'GMAIL_CREATE_EMAIL_DRAFT' ? ['recipient_email', 'subject', 'body'] : [], additionalProperties: true }, tags: slug.includes('_LIST_') ? ['readOnlyHint'] : ['createHint'] };
}

export async function validatePlan(value: unknown, node: Node, backend: ComposioBackend): Promise<ActionPlan> {
  const plan = planSchema.parse(value);
  if (plan.action !== node.path || plan.instance !== (node.item ? String(node.item._key) : null)) throw new Error('Plan belongs to a different action or instance');
  const earlier = new Set<string>();
  for (const step of plan.steps) {
    if (earlier.has(step.id)) throw new Error(`Duplicate action step id: ${step.id}`);
    if (!toolAllowed(node, step.tool)) throw new Error(`Tool is not allowlisted for this action: ${step.tool}`);
    validateReferences(step, earlier);
    const schema = plan.simulated ? simulatedToolSchema(step.tool) : await backend.getToolSchema(step.tool);
    validateToolArgs(schema.inputSchema, step.args, { allowReferences: true });
    earlier.add(step.id);
  }
  return plan;
}

export function renderPlan(plan: ActionPlan): string {
  return [`# ${plan.simulated ? 'SIMULATED — ' : ''}Action plan`, '', plan.summary, '', `Action: ${plan.action}${plan.instance ? ` [${plan.instance}]` : ''}`, `Fingerprint: \`${plan.fingerprint}\``, '', 'Execution requires approval of this exact JSON plan.',
    ...plan.steps.flatMap(step => ['', `## ${step.id} — ${step.tool}`, '', step.why, '', '```json', JSON.stringify(step.args, null, 2), '```'])].join('\n') + '\n';
}

export async function writePlan(root: string, node: Node, plan: ActionPlan): Promise<void> {
  const files = actionPaths(node);
  for (const file of [files.json, files.markdown]) assertSafePath(root, file);
  await writeJSON(path.join(root, files.json), plan);
  await atomicWrite(path.join(root, files.markdown), renderPlan(plan));
}
export async function readPlan(root: string, node: Node): Promise<{ plan: ActionPlan; sha256: string }> {
  const file = actionPaths(node).json; assertSafePath(root, file);
  const source = await readFile(path.join(root, file), 'utf8');
  return { plan: planSchema.parse(JSON.parse(source)), sha256: sha(source) };
}

export async function createPlanningAdapter(node: Node, context: RunContext, backend: ComposioBackend = getBackend(context.root, context.config)): Promise<PlanningAdapter> {
  const steps: ActionStep[] = [];
  const propose = createTool({ name: 'propose_action_step', description: 'Propose one allowlisted Composio step for approval. This never executes it. Arguments may refer only to earlier proposed step results with {{steps.ID.data.path}}.', inputSchema: stepSchema,
    async execute(input) {
      const step = stepSchema.parse(input);
      if (steps.some(existing => existing.id === step.id)) throw new Error(`Duplicate action step id: ${step.id}`);
      if (!toolAllowed(node, step.tool)) throw new Error(`Tool is not allowlisted: ${step.tool}`);
      validateReferences(step, new Set(steps.map(existing => existing.id)));
      const schema = await backend.getToolSchema(step.tool);
      validateToolArgs(schema.inputSchema, step.args, { allowReferences: true });
      step.readonly = isReadOnlyTool(step.tool, schema.tags);
      steps.push(step);
      context.emit({ type: 'action.step.proposed', step });
      return { proposed: true, id: step.id, count: steps.length };
    },
  });
  return { tools: [propose] as AgentTool[], instruction: '\n## Action planning contract\nPropose exact tool calls using propose_action_step in dependency order. Read-only Composio tools may be used to resolve identifiers. Never execute write tools, send messages, or create drafts during planning. Do not edit plan files: Ensemble generates JSON and Markdown from the proposed steps after ensemble_complete. Include all email bodies and exact arguments in the proposed steps. Finish with ensemble_complete once the complete plan is proposed.\n',
    async finalize(summary) {
      const plan: ActionPlan = { action: node.path, instance: node.item ? String(node.item._key) : null, fingerprint: node.fingerprint, planned_at: new Date().toISOString(), run_id: context.runId, summary, steps };
      await validatePlan(plan, node, backend);
      await writePlan(context.root, node, plan);
    },
  };
}

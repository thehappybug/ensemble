import { createTool, type AgentTool } from '@cline/sdk';
import { z } from 'zod';
import type { Node } from '../../types.js';
import type { RunContext } from '../Runner.js';
import { requiredOutputs } from '../../util.js';
import { normalizeWritePath } from '../guard.js';

export interface CompletionState { called: boolean; summary: string; unchanged: string[] }
export function makeEnsembleTools(node: Node, context: RunContext, completion: CompletionState): AgentTool[] {
  const complete = createTool({
    name: 'ensemble_complete',
    description: 'Finish this run exactly once after writing every output. List any previously existing output deliberately left unchanged.',
    inputSchema: z.object({ summary: z.string().trim().min(1), unchanged: z.array(z.string()).optional() }),
    lifecycle: { completesRun: true },
    async execute(input) {
      if (completion.called) throw new Error('ensemble_complete may only be called once');
      const unchanged = (input.unchanged ?? []).map(file => normalizeWritePath(context.root, file));
      for (const file of unchanged) if (!requiredOutputs(node).includes(file)) throw new Error(`Unchanged path is not a declared output: ${file}`);
      Object.assign(completion, { called: true, summary: input.summary, unchanged });
      context.emit({ type: 'ensemble.complete', summary: input.summary, unchanged });
      return { ok: true };
    },
  });
  const note = createTool({
    name: 'ensemble_note', description: 'Record a short progress note or uncertainty in this run log.',
    inputSchema: z.object({ message: z.string() }),
    async execute(input) { context.emit({ type: 'ensemble.note', message: input.message }); return { ok: true }; },
  });
  return [complete, note] as AgentTool[];
}

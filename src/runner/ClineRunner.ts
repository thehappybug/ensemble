import path from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { ClineCore, getClineDefaultSystemPrompt, type AgentTool, type CoreSessionEvent } from '@cline/sdk';
import type { Node } from '../types.js';
import { discoverFiles } from '../workspace/discover.js';
import { fileHash, durationMs, requiredOutputs } from '../util.js';
import type { Runner, RunContext, RunOutcome } from './Runner.js';
import { resolveAuth, type ResolvedAuth } from './auth.js';
import { agentsChain, ENSEMBLE_SYSTEM_ADDENDUM, runContract } from './contract.js';
import { allowedOutputPaths, assertAllowedWrite, checkWriteGuard } from './guard.js';
import { makeEnsembleTools, type CompletionState } from './tools/ensemble.js';

type CoreOptions = NonNullable<Parameters<typeof ClineCore.create>[0]>;
export interface ClineRunnerOptions {
  fetch?: typeof fetch;
  coreFactory?: (options: CoreOptions) => Promise<ClineCore>;
  toolFactory?: (node: Node, context: RunContext) => AgentTool[] | Promise<AgentTool[]>;
  authResolver?: (node: Node, context: RunContext) => Promise<ResolvedAuth>;
}

export class ClineRunner implements Runner {
  private cores = new Map<string, Promise<ClineCore>>();
  private sessions = new Map<string, { core: ClineCore; sessionId: string }>();
  constructor(private options: ClineRunnerOptions = {}) {}

  private core(root: string): Promise<ClineCore> {
    let promise = this.cores.get(root);
    if (!promise) {
      promise = (async () => {
        process.env.CLINE_DATA_DIR = path.join(root, '.ensemble', 'cline');
        process.env.CLINE_DIR = path.join(root, '.ensemble', 'cline-home');
        await mkdir(process.env.CLINE_DATA_DIR, { recursive: true });
        return (this.options.coreFactory ?? ClineCore.create)({ clientName: 'ensemble', distinctId: 'ensemble-local', backendMode: 'local', ...(this.options.fetch ? { fetch: this.options.fetch } : {}) });
      })();
      this.cores.set(root, promise);
    }
    return promise;
  }

  async run(node: Node, context: RunContext): Promise<RunOutcome> {
    if (node.kind !== 'prompt') throw new Error('Action planning requires the action adapter introduced in M4');
    if (context.signal.aborted) throw new Error('interrupted');
    const auth = this.options.authResolver ? await this.options.authResolver(node, context) : await resolveAuth(node, context.config, context.root);
    const core = await this.core(context.root);
    const started = Date.now();
    const snapshot = async () => Object.fromEntries(await Promise.all((await discoverFiles(context.root, context.config)).map(async file => [file, await fileHash(path.join(context.root, file))])));
    const before = await snapshot();
    const outputBefore = Object.fromEntries(await Promise.all(requiredOutputs(node).map(async file => [file, await fileHash(path.join(context.root, file))])));
    const completion: CompletionState = { called: false, summary: '', unchanged: [] };
    let llmCost = 0, parallelCost = 0, stopped: string | undefined;
    const budget = node.fm.budget_usd ?? context.config.defaults.budget_usd;
    const stop = (reason: string) => { stopped ??= reason; void core.abort(context.runId, reason).catch(() => {}); };
    const emit = (event: Record<string, unknown>) => {
      if (event.type === 'parallel.call' && typeof event.cost_estimate === 'number') parallelCost += event.cost_estimate;
      context.emit(event);
      if (llmCost + parallelCost > budget) stop(`budget exceeded ($${budget})`);
    };
    const toolContext = { ...context, emit };
    const factory = this.options.toolFactory ?? (async (currentNode, currentContext) => {
      const { makeParallelTools } = await import('./tools/parallel.js');
      return makeParallelTools(currentNode, currentContext);
    });
    const tools = [...makeEnsembleTools(node, toolContext, completion), ...await factory(node, toolContext)];
    const chain = await agentsChain(context.root, node.path);
    const systemPrompt = [getClineDefaultSystemPrompt({ rootPath: context.root, cwd: context.root, platform: process.platform, mode: 'act', ide: 'Terminal Shell' }), ENSEMBLE_SYSTEM_ADDENDUM, chain].filter(Boolean).join('\n\n');
    const prompt = await runContract(node, context);
    const unsubscribe = core.subscribe((event: CoreSessionEvent) => {
      if (event.type !== 'agent_event') return;
      const current = event.payload.event;
      if (current.type === 'usage') {
        llmCost = current.totalCost ?? llmCost + (current.cost ?? 0);
        if (llmCost + parallelCost > budget) stop(`budget exceeded ($${budget})`);
      }
      emit({ type: 'cline.event', event: current });
    }, { sessionId: context.runId });
    const interrupted = () => stop('interrupted');
    context.signal.addEventListener('abort', interrupted, { once: true });
    const timer = setTimeout(() => stop('timeout'), durationMs(node.fm.timeout ?? context.config.defaults.timeout));
    this.sessions.set(context.runId, { core, sessionId: context.runId });
    let audited = false;
    const audit = async (): Promise<string[]> => {
      if (audited) return [];
      audited = true;
      const after = await snapshot();
      const allowed = new Set(allowedOutputPaths(node));
      const warnings = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => before[file] !== after[file] && !allowed.has(file)).map(file => `Undeclared file changed: ${file}`);
      for (const warning of warnings) emit({ type: 'warning', message: warning });
      return warnings;
    };
    try {
      if (context.signal.aborted) throw new Error('interrupted');
      const session = await core.start({ prompt, interactive: false,
        config: { ...auth, sessionId: context.runId, cwd: context.root, workspaceRoot: context.root, systemPrompt,
          mode: 'act', enableTools: true, enableSpawnAgent: false, enableAgentTeams: false,
          disableMcpSettingsTools: true, maxIterations: context.config.llm.max_iterations },
        toolPolicies: { '*': { autoApprove: true }, run_commands: { enabled: node.fm.tools.shell }, fetch_web_content: { enabled: false }, submit_and_exit: { enabled: false }, ask_question: { enabled: false } },
        localRuntime: { configExtensions: [], extraTools: tools, hooks: { beforeTool: ({ tool, input }) => {
          const denied = checkWriteGuard(context.root, node, context.runId, tool.name, input);
          if (denied) emit({ type: 'guard.denied', tool: tool.name, reason: denied.reason });
          return denied;
        } } },
      });
      if (stopped || context.signal.aborted) throw new Error(stopped ?? 'interrupted');
      if (session.result?.finishReason !== 'completed') throw new Error(`Cline run failed: ${session.result?.finishReason ?? 'no result'}${session.result?.text ? `: ${session.result.text}` : ''}`);
      if (!completion.called) throw new Error('Cline run did not call ensemble_complete');
      for (const output of requiredOutputs(node)) {
        assertAllowedWrite(context.root, node, context.runId, output);
        const file = path.join(context.root, output), hash = await fileHash(file);
        if (hash === 'missing') throw new Error(`Required output missing: ${output}`);
        if (hash === outputBefore[output] && (await stat(file)).mtimeMs < started && !completion.unchanged.includes(output)) throw new Error(`Output was not written during this run: ${output}; report unchanged explicitly`);
      }
      const warnings = await audit();
      return { summary: completion.summary, unchanged: completion.unchanged, usage: session.result.usage, cost: session.result.usage?.totalCost ?? llmCost, parallel_cost: parallelCost, warnings };
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', interrupted);
      unsubscribe();
      this.sessions.delete(context.runId);
      await audit();
    }
  }

  async abort(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (session) await session.core.abort(session.sessionId, 'interrupted');
  }
  async dispose(): Promise<void> {
    await Promise.all([...this.cores.values()].map(async promise => (await promise).dispose('Ensemble shutdown')));
    this.cores.clear();
  }
}

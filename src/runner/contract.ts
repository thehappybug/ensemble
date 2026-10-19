import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { Node } from '../types.js';
import type { RunContext } from './Runner.js';
import { fileHash, requiredOutputs } from '../util.js';

export const ENSEMBLE_SYSTEM_ADDENDUM = `You are running unattended inside an Ensemble workspace.
Write only the required outputs or the run's temporary directory. Preserve existing valid content when updating outputs.
Markdown outputs must cite factual claims inline as [n], with a ## Sources list of URLs.
Never invent facts; mark unknowns explicitly. Prefer Parallel tools for web research.
Do not call side-effecting external tools. Actions are planned for approval, never executed by this agent.
Finish by calling ensemble_complete exactly once, after all outputs are written. Report unchanged paths explicitly.`;

export async function agentsChain(root: string, promptPath: string): Promise<string> {
  const directories = [''];
  const parts = path.posix.dirname(promptPath).split('/').filter(part => part && part !== '.');
  for (let index = 0; index < parts.length; index++) directories.push(parts.slice(0, index + 1).join('/'));
  const rules: string[] = [];
  for (const directory of directories) {
    const relative = path.posix.join(directory, 'AGENTS.md');
    try { rules.push(`## ${relative}\n${await readFile(path.join(root, relative), 'utf8')}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return rules.join('\n\n');
}

export async function runContract(node: Node, context: RunContext): Promise<string> {
  const lines = ['# Ensemble run', `Prompt file: ${node.path}${node.item ? ` (instance: ${node.item._key})` : ''}`, `Run id: ${context.runId}    Today: ${new Date().toISOString().slice(0, 10)}`, '', '## Inputs (read these first; paths relative to workspace root)'];
  let inlineBytes = 0;
  for (const file of node.inputs) {
    const currentHash = await fileHash(path.join(context.root, file));
    const previousHash = context.previous?.inputs[file];
    const changed = node.fm.incremental && previousHash && previousHash !== currentHash;
    lines.push(`- ${file}${changed ? ' [changed since previous run]' : ''}`);
    if (currentHash === 'missing') { lines.push('  Input has not been produced yet.'); continue; }
    const info = await stat(path.join(context.root, file));
    if (info.size < 8 * 1024 && inlineBytes + info.size < 40 * 1024) {
      const content = await readFile(path.join(context.root, file), 'utf8');
      inlineBytes += Buffer.byteLength(content);
      lines.push(`<input path=${JSON.stringify(file)}>\n${content}\n</input>`);
    }
  }
  if (node.fm.incremental && context.previous) {
    const removed = Object.keys(context.previous.inputs).filter(file => !node.inputs.includes(file));
    if (removed.length) lines.push('', 'Inputs removed since previous run:', ...removed.map(file => `- ${file}`));
  }
  lines.push('', node.kind==='action'?'## Generated plan outputs (Ensemble writes these after you propose steps and complete)':'## Required outputs (write every file; do not write anywhere else)');
  for (const file of requiredOutputs(node)) {
    lines.push(`- ${file}`);
    if (node.fm.incremental && await fileHash(path.join(context.root, file)) !== 'missing') lines.push('  Previous version exists — update it, preserve still-valid content, or report this exact path as unchanged.');
  }
  lines.push('', `Temporary directory: .ensemble/tmp/${context.runId}/`, '', '## Tools', '- Use the available Parallel tools for web research.', '- ensemble_note records a progress note.', '- ensemble_complete must be called exactly once after outputs are written.', '', '## Task', node.body);
  return lines.join('\n');
}

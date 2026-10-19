import path from 'node:path';
import { assertSafePath, toPosix } from '../workspace/paths.js';
import type { Node } from '../types.js';
import { requiredOutputs } from '../util.js';

export function allowedOutputPaths(node: Node): string[] {
  const outputs = requiredOutputs(node);
  return [...new Set([...outputs, ...outputs.filter(file => /\.(csv|json)$/.test(file)).map(file => file + '.sources.json')])];
}

export function normalizeWritePath(root: string, value: string): string {
  if (!value || value.includes('\0') || value.includes('\\')) throw new Error('Invalid write path');
  const relative = toPosix(path.relative(root, path.resolve(root, value)));
  assertSafePath(root, relative);
  return relative;
}

export function assertAllowedWrite(root: string, node: Node, runId: string, value: string): string {
  const relative = normalizeWritePath(root, value);
  const temporary = `.ensemble/tmp/${runId}/`;
  if (!allowedOutputPaths(node).includes(relative) && !relative.startsWith(temporary)) throw new Error(`Write denied: ${relative}; write only the declared outputs or ${temporary}`);
  return relative;
}

export function patchTargets(patch: string): string[] {
  if (!patch.startsWith('*** Begin Patch\n') || !patch.trimEnd().endsWith('*** End Patch')) throw new Error('Unrecognized apply_patch format');
  const targets = [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(match => match[1]);
  if (!targets.length) throw new Error('Patch has no recognized file targets');
  // A malformed operation header must never hide an unchecked path.
  for (const line of patch.split('\n')) {
    if (/^\*\*\* /.test(line) && !/^\*\*\* (?:Begin Patch|End Patch|End of File|(?:Add File|Update File|Delete File|Move to): .+)$/.test(line)) throw new Error('Unrecognized patch header');
  }
  return targets;
}

export function checkWriteGuard(root: string, node: Node, runId: string, toolName: string, input: unknown): { skip: true; reason: string } | undefined {
  try {
    const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    if (toolName === 'editor') {
      if (typeof args.path !== 'string' || typeof args.new_text !== 'string') throw new Error('Unrecognized editor write shape');
      assertAllowedWrite(root, node, runId, args.path);
    } else if (toolName === 'apply_patch') {
      const patch = args.patch ?? args.input;
      if (typeof patch !== 'string') throw new Error('Unrecognized apply_patch write shape');
      for (const target of patchTargets(patch)) assertAllowedWrite(root, node, runId, target);
    } else if (toolName === 'run_commands') {
      if (!node.fm.tools.shell) throw new Error('Shell is disabled for this prompt');
      if (!Array.isArray(args.commands) || !args.commands.length || !args.commands.every(command => typeof command === 'string')) throw new Error('Unrecognized shell command shape');
      // Shell is opt-in, but arbitrary commands cannot be proven write-safe.
      // Permit a small set of commands with no writing or code-execution options.
      for (const command of args.commands as string[]) {
        if (/[$`;&|<>\r\n]/.test(command) || !/^(?:pwd|ls|cat|head|tail)(?:\s|$)/.test(command.trim())) throw new Error('Shell command denied: use editor/apply_patch for guarded writes; only pwd/ls/cat/head/tail reads are allowed');
      }
    }
  } catch (error) {
    return { skip: true, reason: error instanceof Error ? error.message : 'Write denied' };
  }
}

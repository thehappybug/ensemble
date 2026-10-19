import { lstat,readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '../util.js';
import { assertSafePath } from '../workspace/paths.js';

export const MANAGED_BEGIN='<!-- ensemble:begin — generated, do not edit inside this block -->';
export const MANAGED_END='<!-- ensemble:end -->';
/** Replaces exactly the managed block, preserving every outside byte. */
export function mergeManagedBlock(existing:string,content:string):string {
  const starts=[...existing.matchAll(/<!-- ensemble:begin\b[^\r\n]*?-->/g)],ends=[...existing.matchAll(/<!-- ensemble:end\s*-->/g)];
  const startTokens=[...existing.matchAll(/<!--\s*ensemble:begin/g)],endTokens=[...existing.matchAll(/<!--\s*ensemble:end/g)];
  const block=`${MANAGED_BEGIN}\n${content.trimEnd()}\n${MANAGED_END}`;
  if(!startTokens.length&&!endTokens.length)return existing+(existing.endsWith('\n\n')?'':existing.endsWith('\n')?'\n':existing?'\n\n':'')+block+'\n';
  if(starts.length!==1||ends.length!==1||startTokens.length!==1||endTokens.length!==1||starts[0].index!>=ends[0].index!)throw new Error('Malformed Ensemble managed block markers; preserving this file unchanged');
  return existing.slice(0,starts[0].index)+block+existing.slice(ends[0].index!+ends[0][0].length);
}
export async function updateAgentsFile(root:string,directory:string,content:string):Promise<boolean> {
  const relative=path.posix.join(directory==='.'?'':directory,'AGENTS.md'),absolute=path.join(root,relative);assertSafePath(root,relative);
  let existing:string;
  try{if((await lstat(absolute)).isSymbolicLink())throw new Error('Refusing to replace a symlink AGENTS.md');existing=await readFile(absolute,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;existing=`# ${directory==='.'?'Workspace':directory}\n\n`;}
  const next=mergeManagedBlock(existing,content);if(next===existing)return false;await atomicWrite(absolute,next);return true;
}
export async function createClaudeShim(root:string,directory:string):Promise<boolean> {
  const relative=path.posix.join(directory==='.'?'':directory,'CLAUDE.md'),absolute=path.join(root,relative);
  try{await lstat(absolute);return false;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  assertSafePath(root,relative);
  await atomicWrite(absolute,'@AGENTS.md\n');return true;
}

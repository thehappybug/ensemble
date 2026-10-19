import path from 'node:path';
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import picomatch from 'picomatch';

export const toPosix=(value:string):string=>value.split(path.sep).join('/');
export const isGlob=(value:string):boolean=>/[*?\[\]{}()!]/.test(value);
export function isManagedPath(value:string):boolean {
  return value.split('/').includes('.ensemble') || ['AGENTS.md','CLAUDE.md'].includes(path.posix.basename(value)) || value.endsWith('.plan.md');
}
export function assertSafePath(root:string,relative:string):void {
  const base=path.resolve(root), abs=path.resolve(base,relative);
  if(abs!==base && !abs.startsWith(base+path.sep)) throw new Error(`Path escapes workspace: ${relative}`);
  // Verify every existing ancestor, including output parents and symlinks before glob segments.
  const realBase=realpathSync(base);
  let current=base;
  for(const part of path.relative(base,abs).split(path.sep)) {
    if(isGlob(part)) break;
    current=path.join(current,part);
    try {if(lstatSync(current).isSymbolicLink()) {const target=path.resolve(path.dirname(current),readlinkSync(current));if(target!==base&&!target.startsWith(base+path.sep))throw new Error(`Symlink escapes workspace: ${relative}`);}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(!existsSync(current)) break;
    const real=realpathSync(current);
    if(real!==realBase && !real.startsWith(realBase+path.sep)) throw new Error(`Symlink escapes workspace: ${relative}`);
  }
}
export function resolvePath(root:string,promptPath:string,pattern:string):string {
  if(pattern.includes('\0') || pattern.includes('\\')) throw new Error(`Invalid path: ${pattern}`);
  const base=pattern.startsWith('/') ? root : path.dirname(path.resolve(root,promptPath));
  const relative=toPosix(path.relative(path.resolve(root),path.resolve(base,pattern.replace(/^\//,''))));
  assertSafePath(root,relative);
  return relative || '.';
}
export function matchesPattern(pattern:string,file:string):boolean {
  return picomatch(pattern,{dot:true})(file);
}

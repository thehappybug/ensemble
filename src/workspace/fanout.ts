import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { parseCSV } from './csv.js';
import type { PromptFM } from '../types.js';
import { renderTemplate,slugify } from './frontmatter.js';
import { assertSafePath,isGlob,resolvePath } from './paths.js';

export async function expandFanout(root:string,promptPath:string,foreach:NonNullable<PromptFM['foreach']>,variables:Record<string,unknown>,workspaceFiles?:string[]):Promise<{source:string;items:Record<string,unknown>[]}> {
  const source=resolvePath(root,promptPath,renderTemplate(foreach.from,variables));
  let rows:unknown[];let csv=false;
  if(isGlob(source)||foreach.from.endsWith('/')) {
    const dirs=foreach.from.endsWith('/');
    const files=await fg(source.replace(/\/$/,''),{cwd:root,dot:false,onlyFiles:!dirs,onlyDirectories:dirs,followSymbolicLinks:false,ignore:['**/.git/**','**/.ensemble-git/**','**/.ensemble/**','**/node_modules/**']});
    rows=files.filter(file=>!workspaceFiles || (dirs?workspaceFiles.some(candidate=>candidate.startsWith(file+'/')):workspaceFiles.includes(file))).sort().map(file=>{assertSafePath(root,file);return {path:file,name:path.posix.basename(file),dir:path.posix.dirname(file)};});
  } else {
    const content=await readFile(path.join(root,source),'utf8');
    if(source.endsWith('.csv')) {
      csv=true;
      rows=parseCSV(content);
    } else {
      const parsed:unknown=JSON.parse(content);
      if(Array.isArray(parsed))rows=parsed;
      else if(parsed&&typeof parsed==='object') {const arrays=Object.values(parsed).filter(Array.isArray);if(arrays.length!==1)throw new Error(`${source}: JSON object must contain exactly one array field`);rows=arrays[0];}
      else throw new Error(`${source}: expected a JSON array`);
    }
  }
  const keys=new Set<string>();
  const items=rows.map((row,index)=>{
    const item:Record<string,unknown>=row&&typeof row==='object'&&!Array.isArray(row)?{...row as Record<string,unknown>}:{value:row};
    const first=csv?Object.values(item)[0]:(item.name??Object.values(item)[0]);
      const key=foreach.key?renderTemplate(foreach.key,{...variables,[foreach.as]:{...item,_index:index}}):slugify(first);
    if(!key || /[\/\\\[\]\0]/.test(key) || key==='.' || key==='..')throw new Error(`Invalid fan-out key: ${key}`);
    if(keys.has(key))throw new Error(`Duplicate fan-out key: ${key}`);keys.add(key);
    return {...item,_key:key,_index:index};
  });
  return {source,items};
}

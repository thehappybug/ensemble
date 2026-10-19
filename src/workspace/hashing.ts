import { createHash } from 'node:crypto';
import { readFile,stat } from 'node:fs/promises';
import path from 'node:path';
import type { Node,WorkspaceConfig } from '../types.js';
export const ENSEMBLE_FINGERPRINT_VERSION=1;
export function canonicalJSON(value:unknown):string {
  if(value===undefined)return 'null';
  if(value===null || typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonicalJSON).join(',')+']';
  return '{'+Object.keys(value).sort().filter(key=>(value as Record<string,unknown>)[key]!==undefined).map(key=>JSON.stringify(key)+':'+canonicalJSON((value as Record<string,unknown>)[key])).join(',')+'}';
}
export function hash(value:string|Buffer):string { return 'sha256:'+createHash('sha256').update(value).digest('hex'); }
const cache=new Map<string,{mtime:number;size:number;ctime:number;hash:string}>();
export async function hashFile(file:string):Promise<string> {
  try {const info=await stat(file);const previous=cache.get(file);if(previous?.mtime===info.mtimeMs&&previous.size===info.size&&previous.ctime===info.ctimeMs)return previous.hash;
    const value=hash(await readFile(file));cache.set(file,{mtime:info.mtimeMs,ctime:info.ctimeMs,size:info.size,hash:value});return value;
  } catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return 'missing';throw error;}
}
export async function hashInputs(root:string,inputs:string[]):Promise<Record<string,string>> {return Object.fromEntries(await Promise.all([...inputs].sort().map(async file=>[file,await hashFile(path.join(root,file))])));}
export async function fingerprintNode(root:string,node:Node,config:WorkspaceConfig,scheduledTick?:string):Promise<string> {
  const fm=node.fm;
  return hash(canonicalJSON({body:node.body,fm:{inputs:node.inputPatterns,outputs:node.outputs,vars:{...config.vars,...fm.vars},tools:fm.tools,model:node.model,foreach:fm.foreach},item:node.item,inputs:Object.entries(await hashInputs(root,node.inputs)).sort(([a],[b])=>a.localeCompare(b)),model:node.model,engine:ENSEMBLE_FINGERPRINT_VERSION,scheduledTick}));
}

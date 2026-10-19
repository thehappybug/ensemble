import {mkdir,readFile,rename,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const sha = (data:string|Buffer) => 'sha256:'+createHash('sha256').update(data).digest('hex');
export function canonical(value:unknown):string { if(value===undefined)return 'null'; if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value); }
export async function atomicWrite(file:string,data:string){await mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+process.pid+'.'+Math.random().toString(36).slice(2)+'.tmp';await writeFile(tmp,data);await rename(tmp,file);}
export const writeJSON = (file:string,data:unknown)=>atomicWrite(file,JSON.stringify(data,null,2)+'\n');
export async function readJSON<T>(file:string,fallback?:T):Promise<T>{try{return JSON.parse(await readFile(file,'utf8'));}catch(e:any){if(e.code==='ENOENT'&&fallback!==undefined)return fallback;throw e;}}
export async function fileHash(file:string){try{return sha(await readFile(file));}catch(e:any){if(e.code==='ENOENT')return 'missing';throw e;}}
export async function exists(file:string){try{await stat(file);return true;}catch{return false;}}
export function durationMs(input:string){const m=input.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);if(!m)throw new Error('Invalid duration: '+input);return Number(m[1])*({ms:1,s:1000,m:60000,h:3600000}[m[2]]!);}
export const message=(e:unknown)=>e instanceof Error?e.message:String(e);

export const requiredOutputs=(node:import('./types.js').Node)=>node.kind==='action'?node.outputs.filter(p=>!p.endsWith('.receipt.json')):node.outputs;

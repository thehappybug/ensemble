import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import ignore from 'ignore';
import picomatch from 'picomatch';
import type { WorkspaceConfig } from '../types.js';
import { assertSafePath } from './paths.js';

const always=['**/.git/**','**/.ensemble-git/**','**/.ensemble/**','**/node_modules/**'];
async function rulesFor(root:string,config:WorkspaceConfig,files:string[]) {
  const rules: {dir:string;matcher:ReturnType<typeof ignore>}[]=[];
  for(const file of files.filter(f=>path.posix.basename(f)==='.gitignore').sort()) {
    const parent=path.posix.dirname(file); rules.push({dir:parent==='.'?'':parent+'/',matcher:ignore().add(await readFile(path.join(root,file),'utf8'))});
  }
  const excluded=picomatch(config.ignore,{dot:true});
  return (file:string,directory=false)=>!excluded(file)&&(!directory||!excluded(file+'/'))&&!rules.some(({dir,matcher})=>file.startsWith(dir)&&matcher.ignores(file.slice(dir.length)+(directory?'/':'')));
}
export async function discoverFiles(root:string,config:WorkspaceConfig):Promise<string[]> {
  const files=await fg('**/*',{cwd:root,dot:true,onlyFiles:true,followSymbolicLinks:false,ignore:always}),allowed=await rulesFor(root,config,files);
  return files.filter(file=>allowed(file)).filter(file=>{try{assertSafePath(root,file);return true;}catch{return false;}}).sort();
}
export async function discoverDirectories(root:string,config:WorkspaceConfig):Promise<string[]> {
  const [files,directories]=await Promise.all([fg('**/.gitignore',{cwd:root,dot:true,onlyFiles:true,followSymbolicLinks:false,ignore:always}),fg('**/*',{cwd:root,dot:true,onlyDirectories:true,followSymbolicLinks:false,ignore:always})]);
  const allowed=await rulesFor(root,config,files);
  return directories.filter(directory=>!directory.split('/').some(part=>['.git','.ensemble-git','.ensemble','node_modules'].includes(part))&&allowed(directory,true)).filter(directory=>{try{assertSafePath(root,directory);return true;}catch{return false;}}).sort();
}

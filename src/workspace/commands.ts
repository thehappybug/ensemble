import {mkdir,readFile,writeFile,cp,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import matter from 'gray-matter';
import YAML from 'yaml';
import {installWorkspaceSkill} from './skills.js';
import {atomicWrite,exists} from '../util.js';
import {assertSafePath,resolvePath} from './paths.js';
const exec=promisify(execFile);
export async function initWorkspace(dir:string,example?:string){
 const root=path.resolve(dir);await mkdir(root,{recursive:true});if(await exists(path.join(root,'ensemble.yaml')))throw new Error('Workspace already initialized');
 if(example){if(example!=='coding-agents-icp')throw new Error('Unknown example: '+example);const candidate=fileURLToPath(new URL('../../examples/coding-agents-icp',import.meta.url));const bundled=fileURLToPath(new URL('../examples/coding-agents-icp',import.meta.url));const source=await exists(candidate)?candidate:bundled;for(const entry of await readdir(source))await cp(path.join(source,entry),path.join(root,entry),{recursive:true,force:false,errorOnExist:true});}
 else {await atomicWrite(path.join(root,'ensemble.yaml'),YAML.stringify({version:1,name:path.basename(root),llm:{provider:'cline',model:'anthropic/claude-sonnet-5.5'},vars:{demo_recipient:'you@example.com'}}));for(const name of ['company','icp','team'])await atomicWrite(path.join(root,'context',name+'.md'),'# '+name+'\n\nTODO: describe your '+name+'.\n');}
 const ignoreFile=path.join(root,'.gitignore');const existing=await readFile(ignoreFile,'utf8').catch(()=> '');await atomicWrite(ignoreFile,existing+'\n.ensemble/\n.env\n.env.*\n!.env.example\nnode_modules/\nexports/*.tmp\n');
 await exec('git',['init'],{cwd:root});
 await atomicWrite(path.join(root,'AGENTS.md'),'# '+path.basename(root)+'\n\nThis is an Ensemble workspace. Prompts are files; action execution requires approval.\n');
 await installWorkspaceSkill(root);
 const {createRuntime}=await import('../daemon.js');const {rebuildIndex}=await import('../librarian/index.js');const {discoverFiles}=await import('./discover.js');
 const runtime=await createRuntime(root);try{await rebuildIndex(runtime,{noLlm:true});await runtime.git.commitFiles(await discoverFiles(root,runtime.config),'chore(ensemble): initialize workspace');}finally{await runtime.close();}
 return root;
}
export async function newPrompt(root:string,target:string,options:{foreach?:string;fromDescription?:string}={}){
 assertSafePath(root,target);if(!/\.(prompt|action)\.md$/.test(target))throw new Error('Use .prompt.md or .action.md');if(await exists(path.join(root,target)))throw new Error('File exists: '+target);
 const action=target.endsWith('.action.md'),fm:Record<string,unknown>={description:options.fromDescription??'Describe this repeatable step',inputs:[],...(action?{tools:{composio:[]},plan:'manual'}:{outputs:[path.basename(target).replace('.prompt.md','.md')],tools:{parallel:['search','extract']},mode:'manual'})};if(options.foreach)fm.foreach={from:options.foreach,as:'item'};
 await atomicWrite(path.join(root,target),'---\n'+YAML.stringify(fm)+'---\n'+(options.fromDescription??'Describe the task. Cite public sources and mark unknowns.')+'\n');return target;
}
export async function clonePrompt(root:string,source:string,destination?:string){
 assertSafePath(root,source);const parsed=matter(await readFile(path.join(root,source),'utf8'));let version=2,target=destination;
 if(!target){do{target=source.replace(/\.(prompt|action)\.md$/,`-v${version++}.$1.md`);}while(await exists(path.join(root,target)));}
 assertSafePath(root,target);if(await exists(path.join(root,target)))throw new Error('File exists: '+target);
 const data:Record<string,any>={...parsed.data,derived_from:source};delete data.id;
 if(Array.isArray(data.outputs)){const used=new Set<string>();const collect=async(dir:string)=>{for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.name.startsWith('.')||entry.name==='node_modules')continue;const file=path.join(dir,entry.name);if(entry.isDirectory())await collect(file);else if(entry.name.endsWith('.prompt.md'))try{const p=matter(await readFile(file,'utf8'));for(const o of p.data.outputs??[])used.add(resolvePath(root,path.relative(root,file),o));}catch{}}};await collect(root);
  const originals:string[]=data.outputs,mapped=new Map<string,string>();
  const relocate=(output:string)=>output.startsWith('/')?output:path.posix.join(path.posix.relative(path.posix.dirname(target!),path.posix.dirname(source)),output);
  const occupied=(output:string)=>used.has(resolvePath(root,target!,output))||existsSyncWorkspace(root,target!,output);
  const versionOutput=(output:string)=>{const baseOutput=relocate(output);let v=2,newOutput:string;do{newOutput=baseOutput.replace(/(\.[^/.]+)?$/,(extension)=>`-v${v++}${extension}`);}while(occupied(newOutput)||(originals.includes(output+'.sources.json')&&occupied(newOutput+'.sources.json')));return newOutput;};
  for(const output of originals)if(!output.endsWith('.sources.json'))mapped.set(output,versionOutput(output));
  for(const output of originals)if(output.endsWith('.sources.json')){const base=output.slice(0,-'.sources.json'.length);mapped.set(output,mapped.has(base)?mapped.get(base)!+'.sources.json':versionOutput(output));}
  data.outputs=originals.map(output=>mapped.get(output)!);

 }
 if(Array.isArray(data.inputs))data.inputs=data.inputs.map((input:string)=>input.startsWith('/')?input:path.posix.join(path.posix.relative(path.posix.dirname(target!),path.posix.dirname(source)),input));
 if(data.foreach){if(typeof data.foreach==='string')data.foreach=path.posix.join(path.posix.relative(path.posix.dirname(target!),path.posix.dirname(source)),data.foreach);else if(!data.foreach.from.startsWith('/'))data.foreach={...data.foreach,from:path.posix.join(path.posix.relative(path.posix.dirname(target!),path.posix.dirname(source)),data.foreach.from)};}
 await atomicWrite(path.join(root,target),'---\n'+YAML.stringify(data)+'---\n'+parsed.content);return target;
}
import {existsSync} from 'node:fs';
function existsSyncWorkspace(root:string,prompt:string,p:string){return existsSync(path.join(root,resolvePath(root,prompt,p)));}

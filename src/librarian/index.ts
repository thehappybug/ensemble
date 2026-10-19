import path from 'node:path';
import type { Graph,Node } from '../types.js';
import type { WorkspaceRuntime } from '../daemon.js';
import { discoverDirectories,discoverFiles } from '../workspace/discover.js';
import { updateAgentsFile,createClaudeShim } from './agentsmd.js';
import { summarizeFiles,type SummaryProvider } from './summarize.js';

export { mergeManagedBlock,MANAGED_BEGIN,MANAGED_END } from './agentsmd.js';
export const ROOT_GUIDANCE=`## How this workspace works

- Research and synthesis live in \`*.prompt.md\` files; approved actions live in \`*.action.md\` files. YAML frontmatter declares inputs, outputs, tools and automatic or manual execution.
- Paths resolve from the prompt directory. A leading \`/\` means the workspace root. Inputs may use globs; output paths must be concrete and have one owner. A \`foreach\` creates an incremental instance per item.
- \`context/\` holds shared company and team context, \`exports/\` holds rendered documents, and \`.ensemble/\` holds ignored runtime state. Other directories are yours to organize.
- Use \`ensemble status\` to inspect freshness and \`ensemble run <prompt>\` to run a step. \`ensemble dev\` watches inputs and runs stale automatic steps in dependency order. Use \`ensemble clone\` to iterate on a prompt.
- To create a new research step, write a \`*.prompt.md\` file; don't do the research ad hoc if it should be repeatable.
- Actions follow plan → approve → execute. Review the exact plan before approval; external writes never execute automatically. Successful runs and librarian updates are committed to git.
`;
const managed=(file:string)=>['AGENTS.md','CLAUDE.md'].includes(path.posix.basename(file));
const excluded=(file:string)=>file==='exports'||file.startsWith('exports/');
const privateFile=(file:string)=>file.split('/').some(part=>part==='.env'||part.startsWith('.env.')||['.aws','.cline','.composio'].includes(part));
const escape=(value:unknown):string=>String(value??'').replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ').trim();
function link(label:string,target:string):string {return `[${escape(label).replace(/([\[\]\\])/g,'\\$1')}](${target.split('/').map(encodeURIComponent).join('/')})`;}
function relative(directory:string,file:string):string {return path.posix.relative(directory,file)||path.posix.basename(file);}
function nodeLink(directory:string,node:Node):string {return link(relative(directory,node.path)+(node.item?`[${node.item._key}]`:''),relative(directory,node.path));}
function stateLabel(node:Node,runtime:WorkspaceRuntime):string {
  const record=runtime.store.data.nodes[node.id],date=record?.lastSuccess?.at??record?.lastRun?.ended_at;
  return escape(`${node.status}${node.reason?` (${node.reason})`:''}${date?' · '+date.slice(0,10):''}`);
}
function promptRows(directory:string,graph:Graph):string[] {
  const groups=new Map<string,Node[]>();for(const node of graph.nodes)if(path.posix.dirname(node.path)===directory)groups.set(node.path,[...(groups.get(node.path)??[]),node]);
  return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([file,nodes])=>{
    const node=nodes[0],inputs=node.fm.inputs.length?node.fm.inputs.map(input=>'`'+escape(input)+'`').join(', '):'_no file inputs_',outputs=node.fm.outputs.map(output=>'`'+escape(output)+'`').join(', ');
    return `- ${link(path.posix.basename(file),relative(directory,file))}: ${inputs} → ${outputs}${node.fm.foreach?` (${nodes.length} ${nodes.length===1?'instance':'instances'})`:''}${node.fm.mode==='manual'?' · manual':''}`;
  });
}
export interface IndexOptions {noLlm?:boolean;summarizer?:SummaryProvider}
export interface IndexResult {changed:string[];directories:number;warnings:string[];usage:unknown;cacheHits:number;commit?:string}
const queues=new Map<string,Promise<IndexResult>>();
export async function rebuildIndex(runtime:WorkspaceRuntime,options:IndexOptions={}):Promise<IndexResult> {
  const key=path.resolve(runtime.root),previous=queues.get(key)??Promise.resolve();
  const pending=previous.catch(()=>{}).then(()=>buildIndex(runtime,options));queues.set(key,pending);
  try{return await pending;}finally{if(queues.get(key)===pending)queues.delete(key);}
}
async function buildIndex(runtime:WorkspaceRuntime,options:IndexOptions):Promise<IndexResult> {
  if(!runtime.config.agents_md.enabled)return {changed:[],directories:0,warnings:[],usage:{calls:0,inputTokens:0,outputTokens:0,cost:0},cacheHits:0};
  const graph=await runtime.scheduler.refresh(),allFiles=(await discoverFiles(runtime.root,runtime.config)).filter(file=>!excluded(file)&&!privateFile(file)),allDirectories=['.',...(await discoverDirectories(runtime.root,runtime.config)).filter(directory=>!excluded(directory)&&!privateFile(directory))];
  const directories=allDirectories.filter(directory=>allFiles.some(file=>path.posix.dirname(file)===directory)||allDirectories.some(child=>child!==directory&&path.posix.dirname(child)===directory));
  const files=allFiles.filter(file=>!managed(file)),directorySet=new Set(directories);
  const summaries=await summarizeFiles(runtime.root,files,runtime.config,{noLlm:options.noLlm||!runtime.config.agents_md.summaries,provider:options.summarizer,directories});
  const warnings=[...summaries.warnings],changed:string[]=[];
  const owners=new Map<string,Node>();for(const node of graph.nodes)for(const output of node.outputs)owners.set(output,node);
  const promptsByPath=new Map<string,Node[]>();for(const node of graph.nodes)promptsByPath.set(node.path,[...(promptsByPath.get(node.path)??[]),node]);
  for(const directory of directories.sort()) {
    const directFiles=[...new Set([...files.filter(file=>path.posix.dirname(file)===directory),...owners.keys()].filter(file=>path.posix.dirname(file)===directory&&!managed(file)&&!privateFile(file)))].sort();
    const table=directFiles.map(file=>{
      const owner=owners.get(file),prompts=promptsByPath.get(file),description=summaries.summaries[file]??prompts?.[0].fm.description??(allFiles.includes(file)?'Workspace file.':'Declared output; not generated yet.');
      const producer=owner?nodeLink(directory,owner):prompts?'prompt (user-authored)':'source (hand-written)';
      const state=owner?stateLabel(owner,runtime):prompts?[...new Set(prompts.map(node=>node.status))].join(', '):'—';
      return `| ${link(path.posix.basename(file),relative(directory,file))} | ${escape(description)} | ${producer} | ${state} |`;
    });
    const parent=directory==='.'?'':`**Parent:** ${link('../AGENTS.md','../AGENTS.md')} · `;
    const rootLink=link('/AGENTS.md',relative(directory,'AGENTS.md'));
    const children=allDirectories.filter(child=>child!==directory&&path.posix.dirname(child)===directory).sort().map(child=>link(path.posix.basename(child)+'/',relative(directory,child)+(directorySet.has(child)?'/AGENTS.md':'/'))+(summaries.purposes[child]?' — '+escape(summaries.purposes[child]):''));
    const consumers=graph.nodes.filter(node=>path.posix.dirname(node.path)!==directory&&node.inputs.some(input=>path.posix.dirname(input)===directory)).sort((a,b)=>a.id.localeCompare(b.id));
    const prompts=promptRows(directory,graph);
    const content=[`**Purpose:** ${escape(summaries.purposes[directory]??(directory==='.'?`Workspace ${runtime.config.name}.`:`Files and subdirectories in ${directory}.`))}`,`${parent}**Workspace root:** ${rootLink}`,'','| File | What it is | Produced by | Status |','|---|---|---|---|',...table,'','**Prompts here:**',...(prompts.length?prompts:['_none_']),'',`**Subdirectories:** ${children.join(' · ')||'_none_'}`,`**Downstream consumers:** ${consumers.map(node=>nodeLink(directory,node)).join(', ')||'_none_'}`,...(directory==='.'?['',ROOT_GUIDANCE.trimEnd()]:[])].join('\n');
    try{if(await updateAgentsFile(runtime.root,directory,content))changed.push(path.posix.join(directory==='.'?'':directory,'AGENTS.md'));if(runtime.config.agents_md.claude_md_shim&&await createClaudeShim(runtime.root,directory))changed.push(path.posix.join(directory==='.'?'':directory,'CLAUDE.md'));}
    catch(error){warnings.push(`${directory}/AGENTS.md: ${String(error)}`);}
  }
  const commit=changed.length?await runtime.git.commitFiles(changed,`chore(agents-md): update ${new Set(changed.map(file=>path.posix.dirname(file))).size} directories`):undefined;
  const result={changed:changed.sort(),directories:directories.length,warnings,usage:summaries.usage,cacheHits:summaries.cacheHits,...(commit?{commit}:{})};
  if(changed.length)runtime.bus.emit('librarian.updated',result);
  return result;
}

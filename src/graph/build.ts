import { readFile,stat } from 'node:fs/promises';
import path from 'node:path';
import type { Graph,Node,PromptFM,StateData,WorkspaceConfig } from '../types.js';
import { discoverFiles } from '../workspace/discover.js';
import { frontmatterSchema,parsePrompt,renderTemplate } from '../workspace/frontmatter.js';
import { expandFanout } from '../workspace/fanout.js';
import { assertSafePath,isGlob,isManagedPath,matchesPattern,resolvePath } from '../workspace/paths.js';
import { canonicalJSON,fingerprintNode,hash } from '../workspace/hashing.js';

function errorText(error:unknown):string {return error instanceof Error?error.message:String(error);}
function invalidate(node:Node,reason:string):void {node.status='invalid';node.reason=node.reason?`${node.reason}; ${reason}`:reason;}
function overlaps(a:string,b:string):boolean {
  if(a===b || matchesPattern(a,b) || matchesPattern(b,a))return true;
  // Pending expansion paths contain only template placeholders substituted with *.
  const aa=a.split('/'),bb=b.split('/');
  return aa.length===bb.length && aa.every((segment,i)=>segment===bb[i] || segment==='*' || bb[i]==='*' || segment==='**' || bb[i]==='**');
}
export async function buildGraph(root:string,config:WorkspaceConfig,state?:StateData):Promise<Graph> {
  const files=await discoverFiles(root,config),nodes:Node[]=[],warnings:string[]=[];
  function makeNode(promptPath:string,fm:PromptFM,body:string,nodeWarnings:string[],item?:Record<string,unknown>):Node {
    const baseId=fm.id??promptPath.replace(/\.(prompt|action)\.md$/,'');
    const id=item?`${baseId}[${item._key}]`:baseId;
    return {id,path:promptPath,kind:promptPath.endsWith('.action.md')?'action':'prompt',fm,body,inputs:[],inputPatterns:[],outputs:[],dependencies:[],fingerprint:'',status:'stale',model:fm.model??config.llm.model,warnings:nodeWarnings,...(item?{item,instanceOf:baseId}:{})};
  }
  function context(promptPath:string,fm:PromptFM,item?:Record<string,unknown>):Record<string,unknown> {
    const vars={...config.vars,...fm.vars};
    return {...vars,vars,prompt:{dir:path.posix.dirname(promptPath),path:promptPath},workspace:{root},...(item&&fm.foreach?{[fm.foreach.as]:item}:{})};
  }
  function renderNode(node:Node):void {
    const variables=context(node.path,node.fm,node.item);
    node.body=renderTemplate(node.body,variables);
    node.inputPatterns=node.fm.inputs.map(input=>{const optional=input.endsWith('?');return resolvePath(root,node.path,renderTemplate(optional?input.slice(0,-1):input,variables))+(optional?'?':'');});
    node.outputs=node.fm.outputs.map(output=>{
      const resolved=resolvePath(root,node.path,renderTemplate(output,variables));
      if(isGlob(resolved))throw new Error(`Output must be a concrete path: ${resolved}`);
      if(resolved==='.' || resolved.startsWith('.git/') || resolved.startsWith('.ensemble-git/') || resolved.startsWith('.ensemble/'))throw new Error(`Reserved output path: ${resolved}`);
      return resolved;
    });
    if(new Set(node.outputs).size!==node.outputs.length)throw new Error('Repeated output in one node');
  }
  for(const promptPath of files.filter(file=>/\.(prompt|action)\.md$/.test(file))) {
    let node:Node|undefined;
    try {
      const parsed=parsePrompt(await readFile(path.join(root,promptPath),'utf8'),promptPath);
      warnings.push(...parsed.warnings);
      node=makeNode(promptPath,parsed.fm,parsed.body,parsed.warnings);
      if(!parsed.fm.foreach){renderNode(node);nodes.push(node);continue;}
      const foreach=parsed.fm.foreach,variables=context(promptPath,parsed.fm);
      node.foreachSource=resolvePath(root,promptPath,renderTemplate(foreach.from,variables));
      let expanded:Awaited<ReturnType<typeof expandFanout>>;
      try {expanded=await expandFanout(root,promptPath,foreach,variables,files);} catch(error) {
        if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
        node.kind='fanout';node.status='pending-expansion';node.reason=`Waiting for ${node.foreachSource}`;
        node.inputs=[node.foreachSource];node.inputPatterns=[node.foreachSource];
        node.outputs=parsed.fm.outputs.map(output=>resolvePath(root,promptPath,output.replace(/{{[\s\S]*?}}/g,'*')));
        nodes.push(node);continue;
      }
      const expansionHash=hash(canonicalJSON(expanded.items));
      const instances=expanded.items.map(item=>{const instance=makeNode(promptPath,parsed.fm,parsed.body,parsed.warnings,item);instance.foreachSource=expanded.source;instance.expansionHash=expansionHash;instance.expansionCount=expanded.items.length;renderNode(instance);return instance;});
      if(instances.length>config.scheduler.fanout_confirm_over && state?.fanoutApprovals[node.id]!==expansionHash) {
        node.kind='fanout';node.status='awaiting-approval';node.reason=`Approve expansion to ${instances.length} instances`;
        node.expansionHash=expansionHash;node.expansionCount=instances.length;
        node.outputs=instances.flatMap(instance=>instance.outputs);node.inputPatterns=[...new Set(instances.flatMap(instance=>instance.inputPatterns))];
        nodes.push(node);
      } else nodes.push(...instances);
    } catch(error) {
      node??=makeNode(promptPath,frontmatterSchema.parse({}),'',[]);
      invalidate(node,errorText(error));nodes.push(node);
    }
  }
  const byId=new Map<string,Node[]>(),owners=new Map<string,Node[]>();
  for(const node of nodes) {
    byId.set(node.id,[...(byId.get(node.id)??[]),node]);
    for(const output of node.outputs) if(!isGlob(output))owners.set(output,[...(owners.get(output)??[]),node]);
  }
  for(const [id,duplicates] of byId)if(duplicates.length>1)for(const node of duplicates)invalidate(node,`Duplicate node id: ${id}`);
  for(const [output,duplicates] of owners)if(duplicates.length>1)for(const node of duplicates)invalidate(node,`Output ownership conflict: ${output} (${duplicates.map(n=>n.id).join(', ')})`);
  const candidates=[...new Set([...files,...owners.keys()])].sort();
  const edges:Graph['edges']=[];
  function connect(source:Node,target:Node):void {
    if(!target.dependencies.includes(source.id)){target.dependencies.push(source.id);edges.push({source:source.id,target:target.id});}
  }
  for(const node of nodes) {
    if(node.status==='invalid')continue;
    const missing:string[]=[];
    const inputs=new Set<string>();
    for(const raw of node.inputPatterns) {
      const optional=raw.endsWith('?');let pattern=optional?raw.slice(0,-1):raw;
      let existingFile=false;
      try {const info=await stat(path.join(root,pattern));if(info.isDirectory())pattern=pattern.replace(/\/$/,'')+'/**/*';else existingFile=info.isFile();}catch{}
      const wildcard=isGlob(pattern);
      const matched=candidates.filter(file=>(!wildcard||!isManagedPath(file)) && matchesPattern(pattern,file));
      if(existingFile&&!wildcard&&!matched.includes(pattern))matched.push(pattern);
      // Nonexistent directories may already have declared outputs beneath them.
      if(!matched.length&&!wildcard)matched.push(...candidates.filter(file=>file.startsWith(pattern+'/')&&!isManagedPath(file)));
      for(const file of matched){assertSafePath(root,file);inputs.add(file);for(const owner of owners.get(file)??[])connect(owner,node);}
      const virtual=nodes.filter(other=>other.kind==='fanout'&&other.status==='pending-expansion'&&other.outputs.some(output=>overlaps(output,pattern)));
      for(const source of virtual)connect(source,node);
      if(!matched.length&&!virtual.length&&!optional)missing.push(pattern);
    }
    if(node.foreachSource) {
      const sourceOwners=owners.get(node.foreachSource)??[];
      for(const owner of sourceOwners)connect(owner,node);
      if(node.status==='pending-expansion'&&!sourceOwners.length){node.status='blocked';node.reason=`Missing foreach source ${node.foreachSource}`;}
    }
    node.inputs=[...inputs].sort();
    if(missing.length&&node.status==='stale'){node.status='blocked';node.reason=`Missing input ${missing.join(', ')}`;}
    node.dependencies.sort();
  }
  // Tarjan marks only members of each strongly connected component, not descendants.
  let index=0;const indices=new Map<string,number>(),low=new Map<string,number>(),stack:string[]=[],onStack=new Set<string>();
  const outgoing=new Map<string,string[]>();for(const edge of edges)outgoing.set(edge.source,[...(outgoing.get(edge.source)??[]),edge.target]);
  function visit(id:string):void {
    indices.set(id,index);low.set(id,index++);stack.push(id);onStack.add(id);
    for(const target of outgoing.get(id)??[]) {if(!indices.has(target)){visit(target);low.set(id,Math.min(low.get(id)!,low.get(target)!));}else if(onStack.has(target))low.set(id,Math.min(low.get(id)!,indices.get(target)!));}
    if(low.get(id)===indices.get(id)){const component:string[]=[];let member:string;do{member=stack.pop()!;onStack.delete(member);component.push(member);}while(member!==id);
      if(component.length>1||(outgoing.get(id)??[]).includes(id))for(const cycleId of component)for(const node of byId.get(cycleId)??[])invalidate(node,`Dependency cycle: ${[...component,component[0]].join(' → ')}`);
    }
  }
  for(const node of nodes)if(!indices.has(node.id))visit(node.id);
  for(const node of nodes)if(node.status!=='invalid') {
    try{node.fingerprint=await fingerprintNode(root,node,config,state?.nodes[node.id]?.scheduledTick);}catch(error){invalidate(node,errorText(error));}
  }
  const ordered:Node[]=[],seen=new Set<Node>();
  function order(node:Node):void {if(seen.has(node))return;seen.add(node);for(const dep of node.dependencies)for(const upstream of byId.get(dep)??[])order(upstream);ordered.push(node);}
  for(const node of nodes)order(node);
  return {nodes:ordered,edges,files,warnings};
}

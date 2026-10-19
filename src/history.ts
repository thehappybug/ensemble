import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {simpleGit} from 'simple-git';
import type {WorkspaceRuntime} from './daemon.js';
import {assertSafePath} from './workspace/paths.js';
import {parsePrompt} from './workspace/frontmatter.js';
export async function explainFile(runtime:WorkspaceRuntime,file:string){
 assertSafePath(runtime.root,file);const graph=await runtime.refresh(),node=graph.nodes.find(n=>n.outputs.includes(file)||n.id===file||n.path===file);
 const lineage:string[]=[];let current=node?.fm.derived_from;while(current&&!lineage.includes(current)&&lineage.length<40){assertSafePath(runtime.root,current);lineage.push(current);try{current=parsePrompt(await readFile(path.join(runtime.root,current),'utf8'),current).fm.derived_from;}catch{break;}}
 return {file,producer:node?.id??null,prompt:node?.path??null,derived_from:lineage,lastRun:node?runtime.store.data.nodes[node.id]?.lastRun:null,inputs:node?runtime.store.data.nodes[node.id]?.lastSuccess?.inputs:{},consumers:graph.nodes.filter(n=>n.inputs.includes(file)).map(n=>n.id)};
}
export async function fileHistory(root:string,file:string){assertSafePath(root,file);const git=simpleGit(root);const output=await git.raw(['log','--follow','--format=%H%x09%aI%x09%s%x09%b%x00','--',file]).catch(()=> '');return output.split('\0').filter(s=>s.trim()).map(row=>{const [commit,at,subject,...body]=row.trim().split('\t');return {commit,at,subject,body:body.join('\t')};});}

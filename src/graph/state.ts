import path from 'node:path';
import type {Graph,Node,StateData,NodeRecord} from '../types.js';
import {readJSON,writeJSON,fileHash,requiredOutputs} from '../util.js';
export class StateStore {
 data:StateData={version:1,nodes:{},fanoutApprovals:{}}; private queue=Promise.resolve();
 constructor(readonly root:string){}
 async load(){this.data=await readJSON(path.join(this.root,'.ensemble/state.json'),this.data);for(const record of Object.values(this.data.nodes)){if(['running','queued','executing'].includes(record.lastRun?.status??'')){record.lastRun!.status='failed';record.lastRun!.error='interrupted';}}return this;}
 record(id:string):NodeRecord{return this.data.nodes[id]??={};}
 async save(){const snapshot=JSON.parse(JSON.stringify(this.data));this.queue=this.queue.catch(()=>{}).then(()=>writeJSON(path.join(this.root,'.ensemble/state.json'),snapshot));await this.queue;}
 async acceptEdit(node:Node){const r=this.record(node.id);if(!r.lastSuccess)throw new Error('No successful baseline to accept');r.lastSuccess.outputs=Object.fromEntries(await Promise.all(requiredOutputs(node).map(async p=>[p,await fileHash(path.join(this.root,p))])));await this.save();}
}
export async function applyState(root:string,graph:Graph,state:StateData):Promise<Graph>{
 for(const node of graph.nodes){
  if(['invalid','blocked','pending-expansion','awaiting-approval'].includes(node.status))continue;
  const r=state.nodes[node.id],success=r?.lastSuccess;
  const outputs=Object.fromEntries(await Promise.all(requiredOutputs(node).map(async p=>[p,await fileHash(path.join(root,p))])));
  if(success&&Object.entries(outputs).some(([p,h])=>h!=='missing'&&success.outputs[p]!==h)){node.status='modified';node.reason='output edited by hand; accept edit or rerun with force';continue;}
  if(r?.lastRun?.status==='failed'&&r.lastRun.fingerprint===node.fingerprint){node.status='failed';node.reason=r.lastRun.error;continue;}
  if(success?.fingerprint===node.fingerprint&&Object.values(outputs).every(h=>h!=='missing')){
   node.status=node.kind==='action'?'awaiting-approval':'fresh';node.reason=node.kind==='action'?(r?.rejected===node.fingerprint?'plan rejected; replan to reconsider':'review the exact plan before execution'):undefined;
  }else{node.status='stale';node.reason=!success?'never run':Object.values(outputs).includes('missing')?'output missing':'prompt, input, model or scheduled tick changed';}
 }
 for(const node of graph.nodes){if(node.status!=='stale')continue;const missing=await Promise.all(node.inputs.map(async p=>(await fileHash(path.join(root,p)))==='missing'?p:null));if(missing.some(Boolean)&&node.dependencies.every(id=>{const upstream=graph.nodes.find(n=>n.id===id);return upstream&&['fresh','modified','awaiting-approval'].includes(upstream.status);})){node.status='blocked';node.reason='missing input '+missing.filter(Boolean).join(', ');}}
 // Staleness propagates for display while upstream work is pending. On rebuild,
 // unchanged upstream output content restores a downstream node's fresh baseline.
 for(let i=0;i<graph.nodes.length;i++)for(const node of graph.nodes){
  if(['invalid','pending-expansion','running','modified','failed'].includes(node.status)||node.kind==='fanout')continue;
  const upstream=node.dependencies.map(id=>graph.nodes.find(n=>n.id===id));
  if(upstream.some(n=>n&&['failed','invalid','blocked'].includes(n.status))){node.status='blocked';node.reason='upstream failed or blocked';}
  else if(upstream.some(n=>n&&(['stale','queued','running','pending-expansion'].includes(n.status)||(n.kind==='fanout'&&n.status==='awaiting-approval')))){
   if(node.status==='fresh'||node.status==='awaiting-approval'){node.status='stale';node.reason='upstream changed; waiting for its outputs';}
  }
 }

 return graph;
}

import path from 'node:path';
import {appendFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import type {Graph,Node,WorkspaceConfig,RunMeta} from '../types.js';
import type {Runner} from '../runner/Runner.js';
import {buildGraph} from './build.js';
import {applyState,StateStore} from './state.js';
import {EventBus} from '../server/bus.js';
import {fileHash,writeJSON,message,atomicWrite,requiredOutputs} from '../util.js';
export interface RunOptions{targets?:string[];force?:boolean;downstream?:boolean;failed?:boolean;stale?:boolean;noCache?:boolean;automatic?:boolean;}
export class Scheduler {
 graph:Graph={nodes:[],edges:[],files:[],warnings:[]};paused=false;private active=new Map<string,{controller:AbortController;runId:string}>();private loop?:Promise<void>;private rerun=false;private pending:RunOptions[]=[];
 beforeRun?:(node:Node,meta:RunMeta)=>Promise<void>;afterRun?:(node:Node,meta:RunMeta)=>Promise<void>;
 constructor(readonly root:string,readonly config:WorkspaceConfig,readonly store:StateStore,readonly runner:Runner,readonly bus=new EventBus()){}
 get running(){return this.active.size>0||!!this.loop;}
 async refresh(){this.graph=await applyState(this.root,await buildGraph(this.root,this.config,this.store.data),this.store.data);for(const n of this.graph.nodes)if(this.active.has(n.id))n.status='running';return this.graph;}
 private targetIds(options:RunOptions){const requested=new Set<string>();for(const n of this.graph.nodes)if(options.targets?.some(t=>n.id===t||n.path===t||n.path.startsWith(t.replace(/\/$/,'')+'/')||n.instanceOf===t))requested.add(n.id);if(options.downstream){let changed=true;while(changed){changed=false;for(const n of this.graph.nodes)if(!requested.has(n.id)&&n.dependencies.some(id=>requested.has(id))){requested.add(n.id);changed=true;}}}return requested;}
 async dryRun(options:RunOptions={}){await this.refresh();const targets=this.targetIds(options);return this.graph.nodes.filter(n=>this.eligible(n,options,targets)).map(n=>({id:n.id,path:n.path,state:n.status,reason:n.reason,fingerprint:n.fingerprint,dependencies:n.dependencies}));}
 private eligible(n:Node,o:RunOptions,targets:Set<string>){if(n.kind==='fanout'||['invalid','blocked','pending-expansion'].includes(n.status))return false;if(o.targets?.length&&!targets.has(n.id))return false;if(o.failed&&n.status!=='failed')return false;const manual=n.kind==='action'?n.fm.plan==='manual':n.fm.mode==='manual';if(manual&&(o.automatic||(!o.targets?.length&&!o.failed)))return false;if(o.force)return true;if(n.status!=='stale'&&!(o.failed&&n.status==='failed'))return false;return !o.automatic||(n.kind==='action'?n.fm.plan!=='manual':n.fm.mode!=='manual');}
 async run(options:RunOptions={}){this.pending.push(options);this.rerun=true;if(this.loop)return this.loop;this.loop=this.drain();try{await this.loop;}finally{this.loop=undefined;}}
 private async drain(){while(this.rerun){this.rerun=false;const requests=this.pending.splice(0);for(const options of requests)await this.wave(options);}}
 private async wave(options:RunOptions){if(options.automatic&&this.paused)return;const forced=new Set<string>(),attempted=new Set<string>();
  for(let round=0;round<1000;round++){
   await this.refresh();const targets=this.targetIds(options);let candidates=this.graph.nodes.filter(n=>{const key=n.id+':'+n.fingerprint;return this.eligible(n,{...options,force:options.force&&!forced.has(n.id)},targets)&&!attempted.has(key)&&!this.active.has(n.id)&&n.dependencies.every(id=>{const p=this.graph.nodes.find(x=>x.id===id);return p&&['fresh','modified','awaiting-approval'].includes(p.status)&&p.kind!=='fanout';});});
   // Start batches; every next batch rebuilds so fanout and fan-in observe outputs.
   candidates=candidates.slice(0,this.config.scheduler.concurrency);if(!candidates.length)break;
   await Promise.all(candidates.map(async n=>{attempted.add(n.id+':'+n.fingerprint);forced.add(n.id);await this.execute(n,options);}));
  }await this.refresh();
 }
 private async execute(node:Node,options:RunOptions){
  const runId='run_'+randomUUID(),controller=new AbortController();this.active.set(node.id,{controller,runId});const inputs=Object.fromEntries(await Promise.all(node.inputs.map(async p=>[p,await fileHash(path.join(this.root,p))])));
  const meta:RunMeta={runId,node:node.id,fingerprint:node.fingerprint,status:'running',started_at:new Date().toISOString(),model:node.model,inputs};const record=this.store.record(node.id),previous=record.lastRun;record.lastRun=meta;
  const dir=path.join(this.root,'.ensemble/runs',runId);await mkdir(dir,{recursive:true});let logQueue=Promise.resolve();const emit=(event:Record<string,unknown>)=>{logQueue=logQueue.then(()=>appendFile(path.join(dir,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),...event})+'\n'));this.bus.emit('run.event',{runId,node:node.id,...event});};
  this.bus.emit('run.started',{runId,node:node.id});await this.store.save();
  try{
   await this.beforeRun?.(node,meta);await atomicWrite(path.join(dir,'prompt.md'),node.body);
   const outcome=await this.runner.run(node,{root:this.root,config:this.config,runId,signal:controller.signal,noCache:options.noCache,previous,emit});
   if(controller.signal.aborted)throw new Error('interrupted');
   const outputs=Object.fromEntries(await Promise.all(requiredOutputs(node).map(async p=>[p,await fileHash(path.join(this.root,p))])));if(Object.values(outputs).includes('missing'))throw new Error('Runner did not produce all required outputs');
   Object.assign(meta,outcome,{status:'completed',outputs,ended_at:new Date().toISOString()});
   record.lastSuccess={runId,fingerprint:node.fingerprint,outputs,inputs,at:meta.ended_at!};record.rejected=undefined;
   await this.afterRun?.(node,meta);record.lastSuccess.commit=meta.commit;
   if(node.kind==='action')this.bus.emit('approval.requested',{node:node.id,runId});
  }catch(e){Object.assign(meta,{status:'failed',error:message(e),ended_at:new Date().toISOString()});emit({type:'error',message:meta.error});}
  finally{this.active.delete(node.id);await logQueue;await writeJSON(path.join(dir,'meta.json'),meta);await this.store.save();this.bus.emit('run.finished',{...meta});}
 }
 async approveFanout(id:string){await this.refresh();const n=this.graph.nodes.find(n=>n.id===id||n.path===id);if(!n?.expansionHash)throw new Error('No pending expansion');this.store.data.fanoutApprovals[n.id]=n.expansionHash;await this.store.save();}
 async abort(runId:string){for(const a of this.active.values())if(a.runId===runId){a.controller.abort();await this.runner.abort?.(runId);}}
 async shutdown(){this.paused=true;for(const a of this.active.values()){a.controller.abort();await this.runner.abort?.(a.runId);}await this.loop;await this.runner.dispose?.();}
}

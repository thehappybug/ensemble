import { readFile,readdir,realpath,stat } from 'node:fs/promises';
import path from 'node:path';
import {explainFile} from '../history.js';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { WorkspaceRuntime } from '../daemon.js';
import type { Node,RunMeta } from '../types.js';
import type { WorkspaceEvent } from './bus.js';
import { assertSafePath,toPosix } from '../workspace/paths.js';
import { hashInputs } from '../workspace/hashing.js';

const runOptions=z.object({targets:z.array(z.string()).optional(),force:z.boolean().optional(),downstream:z.boolean().optional(),failed:z.boolean().optional(),stale:z.boolean().optional(),noCache:z.boolean().optional(),dryRun:z.boolean().optional(),vars:z.record(z.string(),z.unknown()).optional()}).strict();
const runId=/^run_[a-zA-Z0-9_-]+$/;
function forbidden(file:string):boolean {return file.split('/').some(part=>['.git','.ensemble-git','.ensemble','.aws','.cline','.composio','node_modules'].includes(part)||part==='.env'||part.startsWith('.env.'));}
async function runsFor(runtime:WorkspaceRuntime,node?:string):Promise<RunMeta[]> {
  const directory=path.join(runtime.root,'.ensemble/runs');let entries:string[];try{entries=await readdir(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  const runs:RunMeta[]=[];
  for(const id of entries.filter(id=>runId.test(id)))try{assertSafePath(runtime.root,`.ensemble/runs/${id}/meta.json`);const meta=JSON.parse(await readFile(path.join(directory,id,'meta.json'),'utf8')) as RunMeta;if(!node||meta.node===node)runs.push(meta);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  return runs.sort((a,b)=>b.started_at.localeCompare(a.started_at));
}
function detail(node:Node,runtime:WorkspaceRuntime) {return {...node,state:node.status,lastRun:runtime.store.data.nodes[node.id]?.lastRun,costs:{llm:runtime.store.data.nodes[node.id]?.lastRun?.cost??0,parallel:runtime.store.data.nodes[node.id]?.lastRun?.parallel_cost??0}};}
export function createApi(runtime:WorkspaceRuntime):Hono {
  const app=new Hono(),ids=new WeakMap<WorkspaceEvent,string>();let sequence=0;
  function eventId(event:WorkspaceEvent):string {let id=ids.get(event);if(!id){id=String(++sequence);ids.set(event,id);}return id;}
  app.onError((error,c)=>c.json({error:error.message},error instanceof z.ZodError||error instanceof SyntaxError?400:500));
  // Browser requests must originate from this local UI; reject cross-site writes.
  app.use('/api/*',async(c,next)=>{const origin=c.req.header('origin');if(origin&&origin!==new URL(c.req.url).origin)return c.json({error:'Cross-origin API requests are not allowed'},403);if(c.req.method==='POST'&&c.req.header('content-length')!=='0'&&['/api/run','/api/abort'].includes(c.req.path)&&!c.req.header('content-type')?.startsWith('application/json'))return c.json({error:'Use application/json'},415);await next();});
  app.get('/api/explain',async c=>{const file=c.req.query('path');if(!file)return c.json({error:'A path is required'},400);return c.json(await explainFile(runtime,file));});
  app.get('/api/graph',async c=>{const graph=await runtime.scheduler.refresh();const runs=await runsFor(runtime);return c.json({...graph,nodes:graph.nodes.map(node=>detail(node,runtime)),paused:runtime.scheduler.paused,costs:{llm:runs.reduce((sum,run)=>sum+(run.cost??0),0),parallel:runs.reduce((sum,run)=>sum+(run.parallel_cost??0),0)}});});
  app.get('/api/nodes/:id',async c=>{await runtime.scheduler.refresh();const node=runtime.scheduler.graph.nodes.find(node=>node.id===c.req.param('id'));if(!node)return c.json({error:'Node not found'},404);return c.json({...detail(node,runtime),inputHashes:await hashInputs(runtime.root,node.inputs),runs:await runsFor(runtime,node.id)});});
  app.get('/api/runs/:runId',async c=>{const id=c.req.param('runId');if(!runId.test(id))return c.json({error:'Invalid run id'},400);const running=Object.values(runtime.store.data.nodes).map(record=>record.lastRun).find(run=>run?.runId===id);if(running?.status==='running')return c.json(running);try{assertSafePath(runtime.root,`.ensemble/runs/${id}/meta.json`);return c.json(JSON.parse(await readFile(path.join(runtime.root,'.ensemble/runs',id,'meta.json'),'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return c.json({error:'Run not found'},404);throw error;}});
  app.get('/api/runs/:runId/events',async c=>{const id=c.req.param('runId');if(!runId.test(id))return c.json({error:'Invalid run id'},400);try{assertSafePath(runtime.root,`.ensemble/runs/${id}/events.jsonl`);const text=await readFile(path.join(runtime.root,'.ensemble/runs',id,'events.jsonl'),'utf8');return c.body(text,200,{'content-type':'application/x-ndjson; charset=utf-8'});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return c.json({error:'Run events not found'},404);throw error;}});
  app.post('/api/run',async c=>{const body=runOptions.parse(await c.req.json());if(body.vars&&runtime.scheduler.running)return c.json({error:'Variable overrides require an idle scheduler'},400);await runtime.scheduler.refresh();for(const target of body.targets??[])if(!runtime.scheduler.graph.nodes.some(node=>node.id===target||node.path===target||node.instanceOf===target||node.path.startsWith(target.replace(/\/$/,'')+'/')))return c.json({error:`Target not found: ${target}`},404);const {vars,dryRun,...options}=body,originalVars=runtime.config.vars;if(vars)runtime.config.vars={...originalVars,...vars};if(dryRun){try{return c.json(await runtime.scheduler.dryRun(options));}finally{if(vars){runtime.config.vars=originalVars;await runtime.refresh();}}}void runtime.scheduler.run(options).catch(error=>runtime.bus.emit('daemon.error',{error:String(error)})).finally(async()=>{if(vars){runtime.config.vars=originalVars;await runtime.refresh();}});return c.json({accepted:true},202);});
  app.post('/api/abort',async c=>{const {runId:id}=z.object({runId:z.string().regex(runId)}).parse(await c.req.json());const running=Object.values(runtime.store.data.nodes).some(record=>record.lastRun?.runId===id&&record.lastRun.status==='running');if(!running)return c.json({error:'Active run not found'},404);await runtime.scheduler.abort(id);return c.json({aborted:true});});
  app.post('/api/pause',c=>{runtime.scheduler.paused=true;runtime.bus.emit('scheduler.paused');return c.json({paused:true});});
  app.get('/api/activity',c=>c.json(runtime.bus.history));
  app.post('/api/resume',c=>{runtime.scheduler.paused=false;runtime.bus.emit('scheduler.resumed');void runtime.scheduler.run({automatic:true}).catch(error=>runtime.bus.emit('daemon.error',{error:String(error)}));return c.json({paused:false});});
  app.post('/api/fanout/:id/approve',async c=>{await runtime.scheduler.refresh();const node=runtime.scheduler.graph.nodes.find(node=>node.id===c.req.param('id'));if(!node||node.kind!=='fanout'||node.status!=='awaiting-approval')return c.json({error:'Pending fan-out expansion not found'},404);await runtime.scheduler.approveFanout(node.id);runtime.bus.emit('fanout.approved',{node:node.id});return c.json({approved:true});});
  app.post('/api/nodes/:id/accept-edit',async c=>{await runtime.scheduler.refresh();const node=runtime.scheduler.graph.nodes.find(node=>node.id===c.req.param('id'));if(!node)return c.json({error:'Node not found'},404);if(node.status!=='modified')return c.json({error:'Node has no manual edit to accept'},409);await runtime.store.acceptEdit(node);await runtime.refresh();return c.json({accepted:true});});
  app.get('/api/files',async c=>{const requested=c.req.query('path');if(!requested)return c.json({error:'A file path is required'},400);const file=toPosix(path.relative(runtime.root,path.resolve(runtime.root,requested)));if(forbidden(file))return c.json({error:'File is private'},403);try{assertSafePath(runtime.root,file);}catch{return c.json({error:'Path escapes workspace'},403);}try{const absolute=path.join(runtime.root,file),real=await realpath(absolute);if(forbidden(toPosix(path.relative(await realpath(runtime.root),real))))return c.json({error:'File is private'},403);const info=await stat(absolute);if(!info.isFile())return c.json({error:'File not found'},404);if(info.size>5*1024*1024)return c.json({error:'File exceeds 5MB viewer limit'},413);return c.json({path:file,content:await readFile(absolute,'utf8')});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return c.json({error:'File not found'},404);throw error;}});
  app.get('/api/events',c=>streamSSE(c,async stream=>{
    let unsubscribe=()=>{},heartbeat:ReturnType<typeof setInterval>|undefined;let finished=false,resolveFinished:()=>void=()=>{};
    const done=new Promise<void>(resolve=>{resolveFinished=resolve;});
    const finish=()=>{if(finished)return;finished=true;unsubscribe();if(heartbeat)clearInterval(heartbeat);resolveFinished();};
    stream.onAbort(finish);
    let queue=Promise.resolve();const send=(event:WorkspaceEvent)=>{queue=queue.then(async()=>{if(!finished)await stream.writeSSE({id:eventId(event),event:event.type,data:JSON.stringify(event)});if(event.type==='daemon.stopping')finish();}).catch(finish);};
    queue=queue.then(()=>stream.writeSSE({event:'connected',data:'{}'})).then(()=>{}).catch(finish);
    const lastId=c.req.header('last-event-id'),history=runtime.bus.history;for(const event of history)eventId(event);const lastIndex=history.findIndex(event=>eventId(event)===lastId);
    for(const event of history.slice(lastIndex+1))send(event);
    unsubscribe=runtime.bus.subscribe(send);
    heartbeat=setInterval(()=>{queue=queue.then(async()=>{if(!finished)await stream.writeSSE({event:'heartbeat',data:'{}'});}).catch(finish);},15000);heartbeat.unref();
    await done;await queue;
  }));
  return app;
}

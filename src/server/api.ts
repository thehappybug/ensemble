import { readFile,readdir,realpath,stat } from 'node:fs/promises';
import path from 'node:path';
import {SimulationRunner} from '../runner/SimulationRunner.js';
import {readLibrarianUsage} from '../librarian/summarize.js';
import {rebuildIndex} from '../librarian/index.js';
import {ActionService} from '../actions/service.js';
import {explainFile} from '../history.js';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { WorkspaceRuntime } from '../daemon.js';
import type { Node,RunMeta } from '../types.js';
import type { WorkspaceEvent } from './bus.js';
import { assertSafePath,toPosix } from '../workspace/paths.js';
import { hashInputs } from '../workspace/hashing.js';
import { simpleGit } from 'simple-git';
import { createStaticHandler } from './static.js';

const runOptions=z.object({targets:z.array(z.string()).optional(),force:z.boolean().optional(),downstream:z.boolean().optional(),failed:z.boolean().optional(),stale:z.boolean().optional(),noCache:z.boolean().optional(),dryRun:z.boolean().optional(),vars:z.record(z.string(),z.unknown()).optional()}).strict();
const runId=/^run_[a-zA-Z0-9_-]+$/;
function forbidden(file:string):boolean {return file.split('/').some(part=>['.git','.ensemble-git','.ensemble','.aws','.cline','.composio','.ssh','.gnupg','node_modules'].includes(part)||part==='.env'||part.startsWith('.env.'));}
async function runsFor(runtime:WorkspaceRuntime,node?:string):Promise<RunMeta[]> {
  const directory=path.join(runtime.root,'.ensemble/runs');let entries:string[];try{entries=await readdir(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  const runs:RunMeta[]=[];
  for(const id of entries.filter(id=>runId.test(id)))try{assertSafePath(runtime.root,`.ensemble/runs/${id}/meta.json`);const meta=JSON.parse(await readFile(path.join(directory,id,'meta.json'),'utf8')) as RunMeta;if(!node||meta.node===node)runs.push(meta);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  return runs.sort((a,b)=>b.started_at.localeCompare(a.started_at));
}
function detail(node:Node,runtime:WorkspaceRuntime) {return {...node,state:node.status,approval:runtime.store.data.nodes[node.id]?.approval,lastRun:runtime.store.data.nodes[node.id]?.lastRun,lastSuccess:runtime.store.data.nodes[node.id]?.lastSuccess,costs:{llm:runtime.store.data.nodes[node.id]?.lastRun?.cost??0,parallel:runtime.store.data.nodes[node.id]?.lastRun?.parallel_cost??0}};}
export function createApi(runtime:WorkspaceRuntime,options:{actionService?:Pick<ActionService,'read'|'approve'|'reject'|'plan'|'edit'>;staticRoot?:string}={}):Hono {
  const app=new Hono(),ids=new WeakMap<WorkspaceEvent,string>();let sequence=0;
  function eventId(event:WorkspaceEvent):string {let id=ids.get(event);if(!id){id=String(++sequence);ids.set(event,id);}return id;}
  app.onError((error,c)=>{const message=error.message,status=error instanceof z.ZodError||error instanceof SyntaxError?400:/Action not found:/.test(message)?404:/changed since|changed after|Plan changed|not ready|already running|uncertain outcome|was rejected|Cannot edit/.test(message)?409:/Invalid tool arguments|not allowlisted|Demo |Set vars\.demo_recipient|different action|later step|Duplicate action/.test(message)?400:500;return c.json({error:message},status);});
  // Browser requests must originate from this local UI; reject cross-site writes.
  app.use('/api/*',async(c,next)=>{const origin=c.req.header('origin');if(origin&&origin!==new URL(c.req.url).origin)return c.json({error:'Cross-origin API requests are not allowed'},403);if(c.req.method==='POST'&&c.req.header('content-length')!=='0'&&['/api/run','/api/abort'].includes(c.req.path)&&!c.req.header('content-type')?.startsWith('application/json'))return c.json({error:'Use application/json'},415);await next();});
  app.post('/api/index',async c=>{if(runtime.scheduler.running)return c.json({error:'Wait for runs to finish before indexing'},409);const body=z.object({noLlm:z.boolean().optional()}).parse(await c.req.json());return c.json(await rebuildIndex(runtime,{noLlm:body.noLlm||runtime.scheduler.runner instanceof SimulationRunner}));});
  const actions=options.actionService??new ActionService(runtime);
  app.get('/api/actions/:id',async c=>c.json(await actions.read(c.req.param('id'))));
  app.post('/api/actions/:id/approve',async c=>{const body=z.object({dryRun:z.boolean().optional(),force:z.boolean().optional(),expectedPlanHash:z.string().min(1)}).strict().parse(await c.req.json());return c.json(await actions.approve(c.req.param('id'),{...body,approvedBy:'ui'}));});
  app.post('/api/actions/:id/reject',async c=>{const body=z.object({reason:z.string().optional()}).parse(await c.req.json());await actions.reject(c.req.param('id'),body.reason);return c.json({rejected:true});});
  app.post('/api/actions/:id/plan',async c=>c.json(await actions.plan(c.req.param('id'))));
  app.put('/api/actions/:id/plan',async c=>{const body=z.object({plan:z.unknown(),expectedPlanHash:z.string().min(1)}).strict().parse(await c.req.json());return c.json(await actions.edit(c.req.param('id'),body.plan,{expectedPlanHash:body.expectedPlanHash}));});
  app.get('/api/explain',async c=>{const file=c.req.query('path');if(!file)return c.json({error:'A path is required'},400);return c.json(await explainFile(runtime,file));});
  app.get('/api/graph',async c=>{const graph=await runtime.scheduler.refresh();const runs=await runsFor(runtime),librarian=await readLibrarianUsage(runtime.root);return c.json({...graph,name:runtime.config.name,simulated:runtime.scheduler.runner instanceof SimulationRunner,actionsDryRun:runtime.config.composio.dry_run,nodes:graph.nodes.map(node=>detail(node,runtime)),paused:runtime.scheduler.paused,costs:{llm:runs.reduce((sum,run)=>sum+(run.cost??0),0)+librarian.cost,librarian:librarian.cost,parallel:runs.reduce((sum,run)=>sum+(run.parallel_cost??0),0)}});});
  app.get('/api/nodes/:id',async c=>{await runtime.scheduler.refresh();const node=runtime.scheduler.graph.nodes.find(node=>node.id===c.req.param('id'));if(!node)return c.json({error:'Node not found'},404);const hashes=await hashInputs(runtime.root,node.inputs),previous=runtime.store.data.nodes[node.id]?.lastSuccess?.inputs;return c.json({...detail(node,runtime),inputHashes:hashes,inputDetails:node.inputs.map(file=>({path:file,hash:hashes[file],previousHash:previous?.[file],changed:!!previous&&previous[file]!==hashes[file],missing:hashes[file]==='missing'})),removedInputs:Object.keys(previous??{}).filter(file=>!node.inputs.includes(file)),runs:await runsFor(runtime,node.id)});});
  app.get('/api/nodes/:id/diff',async c=>{
    await runtime.scheduler.refresh();const node=runtime.scheduler.graph.nodes.find(node=>node.id===c.req.param('id'));if(!node)return c.json({error:'Node not found'},404);
    const requested=c.req.query('path');if(!requested)return c.json({error:'An output path is required'},400);
    const file=toPosix(path.relative(runtime.root,path.resolve(runtime.root,requested)));if(!node.outputs.includes(file)||forbidden(file))return c.json({error:'Diffs are restricted to this node\'s declared outputs'},403);
    try{assertSafePath(runtime.root,file);}catch{return c.json({error:'Path escapes workspace'},403);}
    let after='';
    try{const absolute=path.join(runtime.root,file),real=await realpath(absolute);if(forbidden(toPosix(path.relative(await realpath(runtime.root),real))))return c.json({error:'File is private'},403);const info=await stat(absolute);if(!info.isFile())return c.json({error:'Output is not a file'},400);if(info.size>5*1024*1024)return c.json({error:'Output exceeds 5MB diff limit'},413);after=await readFile(absolute,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const commit=runtime.store.data.nodes[node.id]?.lastSuccess?.commit;let before='',diff='';
    if(commit&&/^[a-f0-9]{40,64}$/.test(commit)){
      const git=simpleGit(runtime.root);let local=false;
      try{await stat(path.join(runtime.root,'.git'));local=(await realpath((await git.revparse(['--show-toplevel'])).trim()))===await realpath(runtime.root);}catch{}
      if(local){const base=commit+'^';before=await git.raw(['show',base+':'+file]).catch(()=>'');diff=await git.raw(['--literal-pathspecs','diff','--no-ext-diff','--no-textconv','--no-color',base,'--',file]).catch(()=>'');}
    }
    if(!diff&&before!==after)diff=['--- previous/'+file,'+++ current/'+file,'@@ previous → current @@',...before.split('\n').filter((line,index,lines)=>line||index<lines.length-1).map(line=>'-'+line),...after.split('\n').filter((line,index,lines)=>line||index<lines.length-1).map(line=>'+'+line)].join('\n');
    return c.json({path:file,commit,before,after,diff});
  });
  app.get('/api/runs/:runId',async c=>{const id=c.req.param('runId');if(!runId.test(id))return c.json({error:'Invalid run id'},400);const running=Object.values(runtime.store.data.nodes).map(record=>record.lastRun).find(run=>run?.runId===id);if(running?.status==='running')return c.json(running);try{assertSafePath(runtime.root,`.ensemble/runs/${id}/meta.json`);return c.json(JSON.parse(await readFile(path.join(runtime.root,'.ensemble/runs',id,'meta.json'),'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return c.json({error:'Run not found'},404);throw error;}});
  app.get('/api/runs/:runId/events',async c=>{const id=c.req.param('runId');if(!runId.test(id))return c.json({error:'Invalid run id'},400);try{assertSafePath(runtime.root,`.ensemble/runs/${id}/events.jsonl`);const text=await readFile(path.join(runtime.root,'.ensemble/runs',id,'events.jsonl'),'utf8');return c.body(text,200,{'content-type':'application/x-ndjson; charset=utf-8'});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return c.json({error:'Run events not found'},404);throw error;}});
  app.post('/api/run',async c=>{const body=runOptions.parse(await c.req.json());if(body.vars&&runtime.scheduler.running)return c.json({error:'Variable overrides require an idle scheduler'},400);await runtime.scheduler.refresh();for(const target of body.targets??[])if(!runtime.scheduler.graph.nodes.some(node=>node.id===target||node.path===target||node.instanceOf===target||node.path.startsWith(target.replace(/\/$/,'')+'/')))return c.json({error:`Target not found: ${target}`},404);const {vars,dryRun,...options}=body,originalVars=runtime.config.vars;if(vars)runtime.config.vars={...originalVars,...vars};if(dryRun){try{return c.json(await runtime.scheduler.dryRun(options));}finally{if(vars){runtime.config.vars=originalVars;await runtime.refresh();}}}void runtime.scheduler.run(options).catch(error=>runtime.bus.emit('daemon.error',{error:String(error)})).finally(async()=>{if(vars){runtime.config.vars=originalVars;await runtime.refresh();}});return c.json({accepted:true},202);});
  app.post('/api/abort',async c=>{const {runId:id}=z.object({runId:z.string().regex(runId)}).parse(await c.req.json());const running=Object.values(runtime.store.data.nodes).some(record=>record.lastRun?.runId===id&&record.lastRun.status==='running');if(!running)return c.json({error:'Active run not found'},404);await runtime.scheduler.abort(id);return c.json({aborted:true});});
  app.post('/api/pause',c=>{runtime.scheduler.paused=true;runtime.bus.emit('scheduler.paused');return c.json({paused:true});});
  app.get('/api/activity',async c=>{const live=runtime.bus.history,known=new Set(live.filter(event=>event.type==='run.finished').map(event=>event.data.runId)),persisted=(await runsFor(runtime)).filter(run=>!known.has(run.runId)).map(run=>({type:'run.finished',at:run.ended_at??run.started_at,data:{...run,persisted:true}}));return c.json([...persisted,...live].sort((a,b)=>a.at.localeCompare(b.at)));});
  app.post('/api/resume',c=>{runtime.scheduler.paused=false;runtime.bus.emit('scheduler.resumed');void runtime.scheduler.run({automatic:true}).catch(error=>runtime.bus.emit('daemon.error',{error:String(error)}));return c.json({paused:false});});
  app.post('/api/fanout/:id/approve',async c=>{await runtime.scheduler.refresh();const node=runtime.scheduler.graph.nodes.find(node=>node.id===c.req.param('id'));if(!node||node.kind!=='fanout'||node.status!=='awaiting-approval')return c.json({error:'Pending fan-out expansion not found'},404);await runtime.scheduler.approveFanout(node.id);runtime.bus.emit('fanout.approved',{node:node.id});return c.json({approved:true});});
  app.post('/api/nodes/:id/accept-edit',async c=>{await runtime.scheduler.refresh();const node=runtime.scheduler.graph.nodes.find(node=>node.id===c.req.param('id'));if(!node)return c.json({error:'Node not found'},404);if(node.status!=='modified')return c.json({error:'Node has no manual edit to accept'},409);await runtime.store.acceptEdit(node);await runtime.refresh();return c.json({accepted:true});});
  app.get('/api/files',async c=>{const requested=c.req.query('path');if(!requested)return c.json({error:'A file path is required'},400);const file=toPosix(path.relative(runtime.root,path.resolve(runtime.root,requested)));if(forbidden(file))return c.json({error:'File is private'},403);try{assertSafePath(runtime.root,file);}catch{return c.json({error:'Path escapes workspace'},403);}try{const absolute=path.join(runtime.root,file),real=await realpath(absolute);if(forbidden(toPosix(path.relative(await realpath(runtime.root),real))))return c.json({error:'File is private'},403);const info=await stat(absolute);if(!info.isFile())return c.json({error:'File not found'},404);if(info.size>5*1024*1024)return c.json({error:'File exceeds 5MB viewer limit'},413);return c.json({path:file,content:await readFile(absolute,'utf8')});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return c.json({error:'File not found'},404);throw error;}});
  app.get('/api/download',async c=>{const requested=c.req.query('path');if(!requested)return c.json({error:'An exports PDF path is required'},400);const file=toPosix(path.relative(runtime.root,path.resolve(runtime.root,requested)));if(!file.startsWith('exports/')||!file.toLowerCase().endsWith('.pdf')||forbidden(file))return c.json({error:'Only exports/*.pdf files can be downloaded'},403);try{assertSafePath(runtime.root,file);}catch{return c.json({error:'Path escapes workspace'},403);}try{const absolute=path.join(runtime.root,file),real=await realpath(absolute),realExports=await realpath(path.join(runtime.root,'exports'));if(!real.startsWith(realExports+path.sep)||forbidden(toPosix(path.relative(await realpath(runtime.root),real))))return c.json({error:'PDF is private'},403);const info=await stat(absolute);if(!info.isFile())return c.json({error:'PDF not found'},404);if(info.size>25*1024*1024)return c.json({error:'PDF exceeds 25MB download limit'},413);const bytes=await readFile(absolute);if(bytes.subarray(0,5).toString()!=='%PDF-')return c.json({error:'File is not a PDF'},415);return c.body(new Uint8Array(bytes),200,{'content-type':'application/pdf','content-disposition':`inline; filename="${path.posix.basename(file).replace(/["\r\n]/g,'_')}"`,'x-content-type-options':'nosniff'});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return c.json({error:'PDF not found'},404);throw error;}});
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
  const staticHandler=createStaticHandler({root:options.staticRoot});
  app.get('*',c=>staticHandler(c.req.raw));
  return app;
}

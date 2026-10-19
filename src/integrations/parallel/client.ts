import { mkdir,readFile,rename,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalJSON,hash } from '../../workspace/hashing.js';
import { assertSafePath } from '../../workspace/paths.js';

export type Request=Record<string,unknown>;
export interface Basis {field:string;citations?:{url:string;title?:string;excerpts?:string[]}[];reasoning?:string;confidence?:string|null}
export interface TaskResult {run?:Request;output:{type:string;content:unknown;basis:Basis[]}}
export interface ParallelClient {
  search(request:Request,options?:Request):Promise<unknown>;
  extract(request:Request,options?:Request):Promise<unknown>;
  taskRun:{create(request:Request,options?:Request):Promise<Request>;retrieve(id:string,options?:Request):Promise<Request>;result(id:string,request:Request,options?:Request):Promise<TaskResult>};
  taskGroup:{create(request:Request,options?:Request):Promise<Request>;addRuns(id:string,request:Request,options?:Request):Promise<Request>;retrieve(id:string,options?:Request):Promise<Request>;getRuns(id:string,request:Request,options?:Request):Promise<AsyncIterable<Request>>};
  beta:{findall:{create(request:Request,options?:Request):Promise<Request>;retrieve(id:string,options?:Request):Promise<Request>;result(id:string,options?:Request):Promise<Request>;cancel(id:string,options?:Request):Promise<unknown>}};
}
export const PROCESSORS=['lite','base','core','core2x','pro','ultra','ultra2x','ultra4x','ultra8x'] as const;
const taskPrices=[.005,.01,.025,.05,.1,.3,.6,1.2,2.4];
export function processorCost(processor:string):number {const index=PROCESSORS.indexOf(processor as typeof PROCESSORS[number]);if(index<0)throw new Error(`Unknown Parallel processor ${processor}`);return taskPrices[index];}
export function checkProcessor(requested:string,workspaceCap:string,promptCap?:string):string {
  processorCost(requested);processorCost(workspaceCap);if(promptCap)processorCost(promptCap);
  const index=(value:string)=>PROCESSORS.indexOf(value as typeof PROCESSORS[number]);
  const limit=Math.min(index(workspaceCap),promptCap?index(promptCap):Infinity);
  if(index(requested)>limit)throw new Error(`Processor ${requested} exceeds allowed maximum ${PROCESSORS[limit]}`);
  return requested;
}
export interface CallOptions {signal:AbortSignal;noCache?:boolean;emit?:(event:Request)=>void}
export interface CachedResult<T> {data:T;cached:boolean;cost_estimate:number;run_id?:string}
interface Entry {created_at:number;data?:unknown;pending?:Request}
export interface ServiceOptions {root:string;cache?:boolean;client?:ParallelClient;now?:()=>number;sleep?:(ms:number,signal:AbortSignal)=>Promise<void>}

export class ParallelService {
  private sdk?:Promise<ParallelClient>;
  private readonly now:()=>number;
  private readonly sleep:(ms:number,signal:AbortSignal)=>Promise<void>;
  private readonly inflight=new Map<string,Promise<CachedResult<unknown>>>();
  constructor(private readonly options:ServiceOptions) {this.now=options.now??Date.now;this.sleep=options.sleep??(async(ms,signal)=>{await delay(ms,undefined,{signal});});}
  private client():Promise<ParallelClient> {
    return this.sdk??=(this.options.client?Promise.resolve(this.options.client):import('parallel-web').then(({default:Parallel})=>new Parallel({maxRetries:2}) as unknown as ParallelClient));
  }
  private async cached<T>(endpoint:string,request:Request,price:number,opts:CallOptions,work:(previous:Request|undefined,persist:(pending:Request)=>Promise<void>)=>Promise<T>,ttl=Infinity):Promise<CachedResult<T>> {
    opts.signal.throwIfAborted();
    const digest=hash(canonicalJSON({endpoint,request})).slice(7),key=`${endpoint}:${digest}`;
    const directory='.ensemble/cache/parallel',file=path.join(this.options.root,directory,`${digest}.json`);
    const useCache=this.options.cache!==false&&!opts.noCache;
    assertSafePath(this.options.root,path.relative(this.options.root,file));
    const emit=(cached:boolean,cost:number)=>opts.emit?.({type:'parallel.call',endpoint,cached,cost_estimate:cost});
    if(useCache&&this.inflight.has(key)) {
      const result=await this.inflight.get(key)!;opts.signal.throwIfAborted();emit(true,0);return {...result,cached:true,cost_estimate:0} as CachedResult<T>;
    }
    const operation=async():Promise<CachedResult<T>>=>{
      let previous:Entry|undefined;
      if(useCache)try {previous=JSON.parse(await readFile(file,'utf8')) as Entry;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
      if(previous?.data!==undefined && this.now()-previous.created_at<ttl){emit(true,0);return {data:previous.data as T,cached:true,cost_estimate:0};}
      async function persist(entry:Entry):Promise<void> {if(!useCache)return;assertSafePath(thisRoot,directory);await mkdir(path.dirname(file),{recursive:true});const temporary=`${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;await writeFile(temporary,JSON.stringify(entry));await rename(temporary,file);}
      const thisRoot=this.options.root;
      const data=await work(previous?.pending,async pending=>persist({created_at:this.now(),pending}));
      await persist({created_at:this.now(),data});emit(false,price);return {data,cached:false,cost_estimate:price};
    };
    const promise=operation();if(useCache)this.inflight.set(key,promise as Promise<CachedResult<unknown>>);
    try{return await promise;}finally{if(this.inflight.get(key)===promise)this.inflight.delete(key);}
  }
  async search(request:Request,opts:CallOptions):Promise<CachedResult<unknown>> {
    const mode=request.mode??'fast';const extra=Math.max(0,Number((request.advanced_settings as Request|undefined)?.max_results??10)-10);
    return this.cached('search',request,(mode==='fast'||mode==='turbo' ? .001 : .005)+extra*.001,opts,async()=>{const client=await this.client();return client.search(request,{signal:opts.signal});},86400000);
  }
  async extract(request:Request,opts:CallOptions):Promise<CachedResult<unknown>> {
    return this.cached('extract',request,(request.urls as unknown[]).length*.001,opts,async()=>{const client=await this.client();return client.extract(request,{signal:opts.signal});},86400000);
  }
  async task(request:Request,opts:CallOptions):Promise<CachedResult<TaskResult>> {
    const processor=String(request.processor),started=this.now();
    return this.cached('task',request,processorCost(processor),opts,async(previous,persist)=>{
      const client=await this.client();let id=previous?.run_id as string|undefined;
      if(!id){const run=await client.taskRun.create(request,{signal:opts.signal});id=String(run.run_id);await persist({run_id:id});}
      try {
        for(;;) {
          opts.signal.throwIfAborted();const run=await client.taskRun.retrieve(id,{signal:opts.signal});
          opts.emit?.({type:'parallel.progress',endpoint:'task',run_id:id,status:run.status,elapsed:this.now()-started});
          if(run.status==='completed')return await client.taskRun.result(id,{timeout:30},{maxRetries:0,signal:opts.signal});
          if(['failed','cancelled','action_required'].includes(String(run.status))){await persist({});throw new Error(`Parallel task ${id} ${run.status}: ${JSON.stringify(run.error??'')}`);}
          await this.sleep(PROCESSORS.indexOf(processor as typeof PROCESSORS[number])<2?5000:15000,opts.signal);
        }
      } catch(error) {if(opts.signal.aborted)opts.emit?.({type:'parallel.progress',endpoint:'task',run_id:id,status:'aborted',note:'Task runs cannot be cancelled remotely; the paid task may continue.'});throw error;}
    });
  }
  async enrich(rows:Request[],processor:string,outputSchema:Request,opts:CallOptions):Promise<CachedResult<Request[]>> {
    if(rows.length>200)throw new Error('Parallel enrichment is limited to 200 rows');
    const request={rows,processor,outputSchema},started=this.now();
    return this.cached('enrich',request,processorCost(processor)*rows.length,opts,async(previous,persist)=>{
      if(!rows.length)return [];
      const client=await this.client();let groupId=previous?.group_id as string|undefined,runIds=previous?.run_ids as string[]|undefined;
      if(!groupId){const group=await client.taskGroup.create({},{signal:opts.signal});groupId=String(group.taskgroup_id);await persist({group_id:groupId});}
      if(!runIds){const added=await client.taskGroup.addRuns(groupId,{default_task_spec:{output_schema:{type:'json',json_schema:outputSchema}},inputs:rows.map(input=>({input,processor}))},{signal:opts.signal});runIds=added.run_ids as string[];await persist({group_id:groupId,run_ids:runIds});}
      for(;;){opts.signal.throwIfAborted();const group=await client.taskGroup.retrieve(groupId,{signal:opts.signal});const status=group.status as Request;opts.emit?.({type:'parallel.progress',endpoint:'enrich',run_id:groupId,status,elapsed:this.now()-started});if(!status.is_active)break;await this.sleep(PROCESSORS.indexOf(processor as typeof PROCESSORS[number])<2?5000:15000,opts.signal);}
      const results:Request[]=rows.map((_,index)=>({index,status:'failed',error:'No result received'}));
      const events=await client.taskGroup.getRuns(groupId,{include_input:true,include_output:true},{signal:opts.signal,maxRetries:0});
      for await(const event of events){opts.signal.throwIfAborted();if(event.type!=='task_run.state')continue;const run=event.run as Request,index=runIds.indexOf(String(run.run_id));if(index>=0)results[index]={index,status:run.status,output:event.output,error:run.error};}
      return results;
    });
  }
  async findall(request:Request,opts:CallOptions):Promise<CachedResult<Request>> {
    const generator=String(request.generator??'base');if(!['preview','base','core'].includes(generator))throw new Error('FindAll generator must be preview, base or core');
    const limit=Number(request.match_limit);if(!Number.isInteger(limit)||limit<5||limit>50||(generator==='preview'&&limit>10))throw new Error('FindAll match_limit must be 5–50 (preview: 5–10)');
    const prices={preview:[.1,0],base:[.25,.03],core:[2,.15]}[generator]!;
    const started=this.now();
    return this.cached('findall',request,prices[0]+prices[1]*limit,opts,async(previous,persist)=>{
      const client=await this.client();let id=previous?.run_id as string|undefined;
      if(!id){const run=await client.beta.findall.create(request,{signal:opts.signal});id=String(run.findall_id);await persist({run_id:id});}
      try{for(;;){opts.signal.throwIfAborted();const run=await client.beta.findall.retrieve(id,{signal:opts.signal});const status=run.status as Request;opts.emit?.({type:'parallel.progress',endpoint:'findall',run_id:id,status,elapsed:this.now()-started});if(!status.is_active){if(['failed','cancelled'].includes(String(status.status))){await persist({});throw new Error(`FindAll ${id} ${status.status}`);}return await client.beta.findall.result(id,{signal:opts.signal,maxRetries:0});}await this.sleep(5000,opts.signal);}}
      catch(error){if(opts.signal.aborted){await client.beta.findall.cancel(id,{maxRetries:0}).then(()=>persist({})).catch(cancelError=>opts.emit?.({type:'parallel.progress',endpoint:'findall',run_id:id,status:'cancel-failed',error:String(cancelError)}));}throw error;}
    });
  }
}

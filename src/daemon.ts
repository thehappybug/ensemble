import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir,open,readFile,stat,unlink,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import type { Graph,WorkspaceConfig } from './types.js';
import { StateStore } from './graph/state.js';
import { Scheduler } from './graph/scheduler.js';
import { ClineRunner } from './runner/ClineRunner.js';
import { SimulationRunner } from './runner/SimulationRunner.js';
import type { Runner } from './runner/Runner.js';
import { EventBus } from './server/bus.js';
import { WorkspaceGit } from './git.js';
import { watchWorkspace } from './watcher.js';
import { installSchedules } from './graph/cron.js';
import { assertSafePath } from './workspace/paths.js';
import { createApi } from './server/api.js';

const execute=promisify(execFile);
export interface RuntimeOptions {runner?:Runner;config?:WorkspaceConfig;store?:StateStore;git?:WorkspaceGit;bus?:EventBus}
export interface WorkspaceRuntime {
  root:string;config:WorkspaceConfig;store:StateStore;scheduler:Scheduler;bus:EventBus;git:WorkspaceGit;
  refresh():Promise<Graph>;close():Promise<void>;
}
export async function createRuntime(root:string,options:RuntimeOptions={}):Promise<WorkspaceRuntime> {
  root=path.resolve(root);const config=options.config??await loadConfig(root);
  assertSafePath(root,'.ensemble');await mkdir(path.join(root,'.ensemble'),{recursive:true});
  if(config.git.auto_commit){assertSafePath(root,'.git');try{await stat(path.join(root,'.git'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await execute('git',['init'],{cwd:root});}}
  const store=options.store??await new StateStore(root).load(),bus=options.bus??new EventBus();
  const runner=options.runner??new ClineRunner(),scheduler=new Scheduler(root,config,store,runner,bus),git=options.git??new WorkspaceGit(root,config);
  scheduler.beforeRun=(node,meta)=>git.beforeRun(node,meta);scheduler.afterRun=(node,meta)=>git.afterRun(node,meta);
  let closed=false;
  const runtime:WorkspaceRuntime={root,config,store,scheduler,bus,git,refresh:async()=>{const graph=await scheduler.refresh();for(const node of graph.nodes)bus.emit('node.state',{node:node.id,state:node.status,reason:node.reason});return graph;},close:async()=>{if(closed)return;closed=true;bus.emit('daemon.stopping');await scheduler.shutdown();await store.save();}};
  await runtime.refresh();return runtime;
}

export interface DaemonLock {pid:number;port:number;token:string;started_at:string}
function lockPath(root:string):string {assertSafePath(root,'.ensemble/daemon.lock');return path.join(root,'.ensemble/daemon.lock');}
function isAlive(pid:number):boolean {try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==='EPERM';}}
async function parseLock(root:string):Promise<DaemonLock|undefined> {
  try{const value=JSON.parse(await readFile(lockPath(root),'utf8')) as Partial<DaemonLock>;if(typeof value.pid!=='number'||!Number.isInteger(value.pid)||value.pid<=0||typeof value.port!=='number'||!Number.isInteger(value.port)||value.port<0||value.port>65535||typeof value.token!=='string')return undefined;return value as DaemonLock;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'||error instanceof SyntaxError)return undefined;throw error;}
}
export async function readDaemonLock(root:string):Promise<DaemonLock|undefined> {const lock=await parseLock(root);return lock&&isAlive(lock.pid)?lock:undefined;}
export async function acquireDaemonLock(root:string,port:number):Promise<DaemonLock> {
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Daemon port must be an integer from 0 to 65535');
  const file=lockPath(root);await mkdir(path.dirname(file),{recursive:true});
  const lock:DaemonLock={pid:process.pid,port,token:randomUUID(),started_at:new Date().toISOString()};
  for(let attempt=0;attempt<2;attempt++)try{const handle=await open(file,'wx');try{await handle.writeFile(JSON.stringify(lock));}finally{await handle.close();}return lock;}catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    const existing=await parseLock(root);if(existing&&isAlive(existing.pid))throw new Error(`Ensemble daemon already running (pid ${existing.pid}, port ${existing.port})`);
    if(!existing&&(Date.now()-(await stat(file)).mtimeMs)<10000)throw new Error('Ensemble daemon lock is being initialized; retry shortly');
    await unlink(file).catch(unlinkError=>{if((unlinkError as NodeJS.ErrnoException).code!=='ENOENT')throw unlinkError;});
  }
  throw new Error('Unable to acquire Ensemble daemon lock');
}
export async function releaseDaemonLock(root:string,lock:DaemonLock):Promise<void> {if((await parseLock(root))?.token===lock.token)await unlink(lockPath(root)).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}
export async function daemonRequest(root:string,apiPath:string,options:{method?:string;body?:unknown}={}):Promise<unknown|undefined> {
  const lock=await readDaemonLock(root);if(!lock)return undefined;
  if(!apiPath.startsWith('/api/'))throw new Error('Daemon request must use an /api/ path');
  let response:Response;
  try{response=await fetch(`http://127.0.0.1:${lock.port}${apiPath}`,{method:options.method??(options.body===undefined?'GET':'POST'),headers:{'content-type':'application/json','x-ensemble-daemon':lock.token},...(options.body===undefined?{}:{body:JSON.stringify(options.body)}),signal:AbortSignal.timeout(5000)});}catch(error){throw new Error(`Daemon pid ${lock.pid} is running but its API is unavailable: ${String(error)}`);}
  const value=await response.json() as unknown;if(!response.ok)throw new Error((value as {error?:string}).error??`Daemon API returned ${response.status}`);return value;
}

export async function startDaemon(root:string,options:RuntimeOptions&{port?:number;simulate?:boolean;paused?:boolean}={}) {
  const config=options.config??await loadConfig(root),requestedPort=options.port??config.ui.port,lock=await acquireDaemonLock(root,requestedPort);
  let runtime:WorkspaceRuntime|undefined,watcher:Awaited<ReturnType<typeof watchWorkspace>>|undefined,schedules:ReturnType<typeof installSchedules>|undefined,server:ReturnType<typeof serve>|undefined;
  try{
    if(options.simulate)config.composio.dry_run=true;
    runtime=await createRuntime(root,{...options,config,runner:options.runner??(options.simulate?new SimulationRunner():undefined)});
    runtime.scheduler.paused=!!options.paused;
    const current=runtime,app=createApi(current);
    server=await new Promise<ReturnType<typeof serve>>((resolve,reject)=>{const listener=serve({fetch:app.fetch,hostname:'127.0.0.1',port:requestedPort},()=>resolve(listener));listener.once('error',reject);});
    const address=server.address();const port=address&&typeof address!=='string'?address.port:requestedPort;
    lock.port=port;await writeFile(lockPath(root),JSON.stringify(lock));
    const automatic=()=>{void current.scheduler.run({automatic:true}).catch(error=>current.bus.emit('daemon.error',{error:String(error)}));};
    watcher=await watchWorkspace(root,config,async paths=>{try{if(paths.includes('ensemble.yaml'))Object.assign(config,await loadConfig(root));await current.refresh();current.bus.emit('fs.changed',{paths});automatic();}catch(error){current.bus.emit('daemon.error',{error:String(error)});}});
    schedules=installSchedules(current.scheduler,current.bus);
    let closed=false;
    const close=async()=>{if(closed)return;closed=true;await watcher?.close();schedules?.close();await current.close();await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));await releaseDaemonLock(root,lock);current.bus.emit('daemon.stopped');};
    current.bus.emit('daemon.started',{port,simulated:!!options.simulate});automatic();
    return {...current,app,server,port,close};
  }catch(error){await watcher?.close();schedules?.close();await runtime?.close();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await releaseDaemonLock(root,lock);throw error;}
}

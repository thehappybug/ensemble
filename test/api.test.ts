import { afterEach,describe,expect,it,vi } from 'vitest';
import { mkdtemp,mkdir,readFile,rm,symlink,writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntime,acquireDaemonLock,readDaemonLock,releaseDaemonLock,daemonRequest,type WorkspaceRuntime } from '../src/daemon.js';
import { createApi } from '../src/server/api.js';
import { FakeRunner } from '../src/runner/FakeRunner.js';
import type { Runner } from '../src/runner/Runner.js';
import { configSchema } from '../src/config.js';

const roots:string[]=[],runtimes:WorkspaceRuntime[]=[];
afterEach(async()=>{await Promise.all(runtimes.splice(0).map(runtime=>runtime.close()));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function setup(runner:Runner=new FakeRunner()) {
  const root=await mkdtemp(path.join(os.tmpdir(),'ensemble-api-'));roots.push(root);
  await writeFile(path.join(root,'ensemble.yaml'),'version: 1\nname: test\n');await writeFile(path.join(root,'input.md'),'Input');
  await writeFile(path.join(root,'a.prompt.md'),'---\ninputs: [input.md]\noutputs: [out.md]\n---\nWrite output');
  const config=configSchema.parse({git:{auto_commit:false}}),runtime=await createRuntime(root,{runner,config});runtimes.push(runtime);
  return {root,runtime,app:createApi(runtime)};
}
const post=(body:unknown)=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
async function idle(runtime:WorkspaceRuntime):Promise<void> {for(let i=0;i<1000&&runtime.scheduler.running;i++)await new Promise(resolve=>setTimeout(resolve,2));expect(runtime.scheduler.running).toBe(false);}

describe('daemon HTTP API and ownership',()=>{
  it('serves live graph and node details, then runs work asynchronously with persisted history',async()=>{
    const runner=new FakeRunner(),{runtime,app,root}=await setup(runner);
    const graph=await (await app.request('/api/graph')).json();expect(graph.nodes[0]).toMatchObject({id:'a',state:'stale'});
    const detail=await (await app.request('/api/nodes/a')).json();expect(detail.inputHashes['input.md']).toMatch(/^sha256:/);
    const response=await app.request('/api/run',post({targets:['a']}));expect(response.status).toBe(202);await idle(runtime);
    expect(await readFile(path.join(root,'out.md'),'utf8')).toContain('SIMULATED');expect(runner.runs).toEqual(['a']);
    const meta=runtime.store.data.nodes.a.lastRun!;expect((await (await app.request('/api/runs/'+meta.runId)).json()).status).toBe('completed');
    expect((await (await app.request('/api/nodes/a')).json()).runs).toHaveLength(1);
    expect((await (await app.request('/api/graph')).json()).nodes[0].state).toBe('fresh');
  });
  it('rejects invalid targets, payloads and cross-origin mutations',async()=>{
    const {app}=await setup();
    expect((await app.request('/api/run',post({targets:['unknown']}))).status).toBe(404);
    expect((await app.request('/api/run',post({force:'yes'}))).status).toBe(400);
    expect((await app.request('/api/run',{method:'POST',body:'{}'})).status).toBe(415);
    expect((await app.request('/api/pause',{method:'POST',headers:{origin:'https://evil.test'}})).status).toBe(403);
    expect((await app.request('/api/nodes/unknown')).status).toBe(404);
    expect((await app.request('/api/runs/invalid')).status).toBe(400);
  });
  it('previews runs without scheduling and restores temporary variable overrides',async()=>{
    const values:unknown[]=[];
    const runner=new FakeRunner(async(_node,ctx)=>{values.push(ctx.config.vars.feature);await writeFile(path.join(ctx.root,'out.md'),'Output with override');return {summary:'Override test'};});
    const {runtime,app}=await setup(runner);
    const preview=await app.request('/api/run',post({dryRun:true,vars:{feature:'preview'}}));expect(preview.status).toBe(200);expect(await preview.json()).toHaveLength(1);expect(runner.runs).toEqual([]);expect(runtime.config.vars.feature).toBeUndefined();
    await app.request('/api/run',post({vars:{feature:'temporary'}}));await idle(runtime);await new Promise(resolve=>setTimeout(resolve,0));
    expect(values).toEqual(['temporary']);expect(runtime.config.vars.feature).toBeUndefined();
  });
  it('pauses automatic work while allowing manual runs; resumes afterward',async()=>{
    const runner=new FakeRunner(),{runtime,app}=await setup(runner);
    expect((await (await app.request('/api/pause',{method:'POST'})).json()).paused).toBe(true);
    await runtime.scheduler.run({automatic:true});expect(runner.runs).toEqual([]);
    await app.request('/api/run',post({targets:['a']}));await idle(runtime);expect(runner.runs).toEqual(['a']);
    expect((await (await app.request('/api/resume',{method:'POST'})).json()).paused).toBe(false);await idle(runtime);
  });
  it('aborts an active run and exposes recorded run events',async()=>{
    let started:()=>void=()=>{};const ready=new Promise<void>(resolve=>{started=resolve;});
    const runner=new FakeRunner(async(_node,ctx)=>{ctx.emit({type:'note',message:'Started test run'});started();await new Promise<void>((_resolve,reject)=>ctx.signal.addEventListener('abort',()=>reject(new Error('interrupted')),{once:true}));return {summary:'unreachable'};});
    const {runtime,app}=await setup(runner);await app.request('/api/run',post({targets:['a']}));await ready;
    expect((await app.request('/api/run',post({vars:{feature:'busy'}}))).status).toBe(400);
    const meta=runtime.store.data.nodes.a.lastRun!;expect((await app.request('/api/abort',post({runId:meta.runId}))).status).toBe(200);await idle(runtime);
    expect(meta.status).toBe('failed');const response=await app.request(`/api/runs/${meta.runId}/events`);expect(response.status).toBe(200);expect(await response.text()).toContain('Started test run');
    expect((await app.request('/api/abort',post({runId:meta.runId}))).status).toBe(404);
  });
  it('restricts file viewing against traversal, private files and symlink aliases',async()=>{
    const {app,root}=await setup();await writeFile(path.join(root,'.env'),'SECRET=hidden');await mkdir(path.join(root,'.ensemble','cline'),{recursive:true});await writeFile(path.join(root,'.ensemble','cline','auth.json'),'secret');
    await symlink(path.join(root,'.env'),path.join(root,'alias.md'));
    expect((await (await app.request('/api/files?path=input.md')).json()).content).toBe('Input');
    for(const file of ['.env','.ensemble/cline/auth.json','../outside.md','alias.md'])expect((await app.request('/api/files?path='+encodeURIComponent(file))).status).toBe(403);
    expect((await app.request('/api/files?path=missing.md')).status).toBe(404);
  });
  it('streams replayed and live events and unsubscribes on cancellation',async()=>{
    const {app,runtime}=await setup();runtime.bus.emit('test.replay',{message:'before'});
    const subscribe=runtime.bus.subscribe.bind(runtime.bus),unsubscribe=vi.fn();vi.spyOn(runtime.bus,'subscribe').mockImplementation(fn=>{const remove=subscribe(fn);return ()=>{unsubscribe();remove();};});
    const response=await app.request('/api/events'),reader=response.body!.getReader(),decoder=new TextDecoder();let content='';
    for(let i=0;i<10&&!content.includes('test.replay');i++)content+=decoder.decode((await reader.read()).value);
    expect(content).toContain('test.replay');runtime.bus.emit('test.live',{message:'after'});
    for(let i=0;i<10&&!content.includes('test.live');i++)content+=decoder.decode((await reader.read()).value);
    expect(content).toContain('test.live');await reader.cancel();await new Promise(resolve=>setTimeout(resolve,0));expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it('holds an exclusive daemon lock, recovers dead owners and releases only its own token',async()=>{
    const {root}=await setup();expect(await daemonRequest(root,'/api/graph')).toBeUndefined();
    const lock=await acquireDaemonLock(root,4567);expect(await readDaemonLock(root)).toMatchObject({pid:process.pid,port:4567});await expect(acquireDaemonLock(root,4568)).rejects.toThrow('already running');
    await releaseDaemonLock(root,{...lock,token:'not-the-owner'});expect(await readDaemonLock(root)).toBeDefined();await releaseDaemonLock(root,lock);expect(await readDaemonLock(root)).toBeUndefined();
    await writeFile(path.join(root,'.ensemble/daemon.lock'),JSON.stringify({pid:99999999,port:4567,token:'stale',started_at:'2020-01-01'}));
    const recovered=await acquireDaemonLock(root,4568);expect(recovered.token).not.toBe('stale');await releaseDaemonLock(root,recovered);
  });
});

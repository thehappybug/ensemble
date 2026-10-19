import { afterEach,describe,expect,it,vi } from 'vitest';
import { mkdtemp,mkdir,readFile,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Parallel from 'parallel-web';
import type { Node } from '../src/types.js';
import type { RunContext } from '../src/runner/Runner.js';
import { configSchema } from '../src/config.js';
import { frontmatterSchema } from '../src/workspace/frontmatter.js';
import { ParallelService,checkProcessor,type ParallelClient,type Request } from '../src/integrations/parallel/client.js';
import { makeParallelTools,datasetSchema } from '../src/runner/tools/parallel.js';
import { parseCSV } from '../src/workspace/csv.js';

const roots:string[]=[];const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{await Promise.all(cleanups.splice(0).map(cleanup=>cleanup()));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function setup() {
  const root=await mkdtemp(path.join(os.tmpdir(),'ensemble-parallel-'));roots.push(root);await mkdir(path.join(root,'out'));
  const controller=new AbortController(),events:Request[]=[];
  const node:Node={id:'research',path:'research.prompt.md',kind:'prompt',fm:frontmatterSchema.parse({outputs:['out/data.csv'],tools:{parallel:true}}),body:'Research',inputs:[],inputPatterns:[],outputs:['out/data.csv'],dependencies:[],fingerprint:'abc',status:'stale',model:'fake',warnings:[]};
  const ctx:RunContext={root,config:configSchema.parse({}),runId:'run_test',signal:controller.signal,emit:event=>events.push(event)};
  return {root,controller,events,node,ctx};
}
function mockClient():ParallelClient {
  return {search:vi.fn(async()=>({results:[{url:'https://acme.test',title:'Acme',excerpts:['Company website']}]})),extract:vi.fn(async()=>({results:[],errors:[{url:'https://bad.test',error_type:'unavailable'}]})),taskRun:{create:vi.fn(async()=>({run_id:'run_1'})),retrieve:vi.fn(async()=>({status:'completed'})),result:vi.fn(async()=>({run:{run_id:'run_1'},output:{type:'json',content:{rows:[{name:'Acme, Inc',employees:42}]},basis:[{field:'rows.0',citations:[{url:'https://acme.test',title:'Acme'}]}]}}))},taskGroup:{create:vi.fn(async()=>({taskgroup_id:'group_1'})),addRuns:vi.fn(async()=>({run_ids:['r1','r2']})),retrieve:vi.fn(async()=>({status:{is_active:false}})),getRuns:vi.fn(async()=>({async *[Symbol.asyncIterator](){yield {type:'task_run.state',run:{run_id:'r2',status:'failed'},error:'No source'};yield {type:'task_run.state',run:{run_id:'r1',status:'completed'},output:{type:'json',content:{ceo:'Alice'},basis:[]}};}}))},beta:{findall:{create:vi.fn(async()=>({findall_id:'find_1'})),retrieve:vi.fn(async()=>({status:{status:'completed',is_active:false}})),result:vi.fn(async()=>({candidates:[{name:'Yes',url:'https://yes.test',description:'A match',match_status:'matched',output:{api:{value:true}}},{name:'No',match_status:'unmatched'}]})),cancel:vi.fn(async()=>({}))}}};
}
async function execute(tools:ReturnType<typeof makeParallelTools>,name:string,input:unknown):Promise<Request> {
  const tool=tools.find(tool=>tool.name===name)!;
  // createTool retains its plain execute callback; the SDK normally validates this input.
  return await (tool as unknown as {execute:(input:unknown,ctx:unknown)=>Promise<Request>}).execute(input,{});
}

describe('Parallel integration',()=>{
  it('enforces processor caps and builds compatible strict dataset schemas',()=>{
    expect(checkProcessor('base','pro','base')).toBe('base');
    expect(()=>checkProcessor('core','pro','base')).toThrow('allowed maximum base');
    expect(()=>checkProcessor('unknown','pro')).toThrow('Unknown');
    const schema=datasetSchema([{name:'name',type:'string',description:'Company'},{name:'revenue',type:'number',description:'Revenue',nullable:true}],10);
    expect(JSON.stringify(schema)).not.toContain('maxItems');expect(JSON.stringify(schema)).toContain('Exactly 10');expect(JSON.stringify(schema)).toContain('["number","null"]');
  });
  it('caches search for 24h and supports explicit no-cache and expiry',async()=>{
    const {root,controller,events}=await setup(),client=mockClient();let now=0;
    const service=new ParallelService({root,client,now:()=>now}),opts={signal:controller.signal,emit:(event:Request)=>events.push(event)};
    const request={objective:'Find Acme',mode:'fast',search_queries:['Acme']};
    expect((await service.search(request,opts)).cached).toBe(false);expect((await service.search(request,opts)).cached).toBe(true);
    expect(client.search).toHaveBeenCalledTimes(1);expect(events.at(-1)).toMatchObject({type:'parallel.call',cached:true,cost_estimate:0});
    now=86400001;expect((await service.search(request,opts)).cached).toBe(false);
    await service.search(request,{...opts,noCache:true});expect(client.search).toHaveBeenCalledTimes(3);
  });
  it('polls retrieve before a single nonretrying result fetch and resumes pending runs after abort',async()=>{
    const {root,controller,events}=await setup(),client=mockClient();
    vi.mocked(client.taskRun.retrieve).mockResolvedValueOnce({status:'running'});
    const service=new ParallelService({root,client,sleep:async(ms)=>{expect(ms).toBe(5000);controller.abort();}});
    const request={input:'Research',processor:'base'},opts={signal:controller.signal,emit:(event:Request)=>events.push(event)};
    await expect(service.task(request,opts)).rejects.toThrow();expect(client.taskRun.result).not.toHaveBeenCalled();
    expect(events.some(event=>String(event.note).includes('cannot be cancelled'))).toBe(true);
    const restarted=new ParallelService({root,client});await restarted.task(request,{signal:new AbortController().signal});
    expect(client.taskRun.create).toHaveBeenCalledTimes(1);
    expect(client.taskRun.result).toHaveBeenCalledWith('run_1',{timeout:30},expect.objectContaining({maxRetries:0}));
  });
  it('writes valid CSV and per-row citations, then serves identical datasets from cache without paying again',async()=>{
    const {root,node,ctx}=await setup(),client=mockClient(),service=new ParallelService({root,client});
    const tools=makeParallelTools(node,ctx,service),input={query:'Find companies',columns:[{name:'name',type:'string',description:'Name'},{name:'employees',type:'integer',description:'Headcount'}],processor:'core',output_path:'out/data.csv'};
    const result=await execute(tools,'parallel_dataset',input);expect(result).toMatchObject({rows:1,path:'out/data.csv',cached:false});
    expect(parseCSV(await readFile(path.join(root,'out/data.csv'),'utf8'))).toEqual([{name:'Acme, Inc',employees:'42'}]);
    const citations=JSON.parse(await readFile(path.join(root,'out/data.csv.sources.json'),'utf8'));expect(citations.rows[0].basis[0].citations[0].url).toBe('https://acme.test');
    expect((await execute(tools,'parallel_dataset',input)).cached).toBe(true);expect(client.taskRun.create).toHaveBeenCalledTimes(1);
  });
  it('rejects unsafe writes and expensive processors before making a paid API call',async()=>{
    const {root,node,ctx}=await setup(),client=mockClient(),service=new ParallelService({root,client});ctx.config.parallel.max_processor='base';
    const tools=makeParallelTools(node,ctx,service),input={query:'Research',processor:'base',output_path:'out/undeclared.md'};
    await expect(execute(tools,'parallel_research',input)).rejects.toThrow('Write denied');
    await expect(execute(tools,'parallel_research',{...input,output_path:'../outside.md'})).rejects.toThrow('escapes');
    await expect(execute(tools,'parallel_research',{query:'Research',processor:'pro'})).rejects.toThrow('maximum base');
    expect(client.taskRun.create).not.toHaveBeenCalled();
    vi.mocked(client.taskRun.result).mockResolvedValueOnce({run:{run_id:'run_1'},output:{type:'text',content:'Report',basis:[]}});
    await execute(tools,'parallel_research',{query:'Research',processor:'base',output_path:'.ensemble/tmp/run_test/report.md'});
    expect(await readFile(path.join(root,'.ensemble/tmp/run_test/report.md'),'utf8')).toContain('Report');
  });
  it('joins TaskGroup results by run id, preserving row order and reporting failed rows',async()=>{
    const {root,node,ctx}=await setup(),client=mockClient();node.outputs=['out/enriched.json'];node.inputs=['input.json'];
    const {writeFile}=await import('node:fs/promises');await writeFile(path.join(root,'input.json'),JSON.stringify([{name:'Acme'},{name:'Beta'}]));
    const tools=makeParallelTools(node,ctx,new ParallelService({root,client}));
    const result=await execute(tools,'parallel_enrich',{input_path:'input.json',key_columns:['name'],new_columns:[{name:'ceo',type:'string',description:'CEO'}],processor:'base',output_path:'out/enriched.json'});
    expect(JSON.parse(await readFile(path.join(root,'out/enriched.json'),'utf8'))).toEqual([{name:'Acme',ceo:'Alice'},{name:'Beta',ceo:''}]);
    expect(result.failures).toHaveLength(1);expect(client.taskGroup.addRuns).toHaveBeenCalledWith('group_1',expect.objectContaining({inputs:[{input:{name:'Acme'},processor:'base'},{input:{name:'Beta'},processor:'base'}]}),expect.anything());
  });
  it('limits FindAll, filters unmatched candidates, and cancels remote runs when aborted',async()=>{
    const {root,node,ctx,controller}=await setup(),client=mockClient();node.outputs=['out/matches.json'];
    const service=new ParallelService({root,client}),tools=makeParallelTools(node,ctx,service),input={objective:'Find companies',entity_type:'companies',match_conditions:[{name:'api',description:'Has an API'}],generator:'base',match_limit:5,output_path:'out/matches.json'};
    const result=await execute(tools,'parallel_findall',input);expect(result.count).toBe(1);
    expect(JSON.parse(await readFile(path.join(root,'out/matches.json'),'utf8'))[0].api).toBe(true);
    await expect(service.findall({...input,match_limit:100},{signal:ctx.signal})).rejects.toThrow('5–50');
    vi.mocked(client.beta.findall.retrieve).mockResolvedValue({status:{status:'running',is_active:true}});
    const aborting=new ParallelService({root,client,cache:false,sleep:async()=>{controller.abort();}});
    await expect(aborting.findall(input,{signal:ctx.signal})).rejects.toThrow();expect(client.beta.findall.cancel).toHaveBeenCalledWith('find_1',{maxRetries:0});
  });
  it('uses the real pinned SDK with a mock HTTP transport and nested search/extract settings',async()=>{
    const {root,node,ctx}=await setup(),requests:Request[]=[];
    const sdk=new Parallel({apiKey:'mock-key',baseURL:'https://mock.parallel.test',maxRetries:0,fetch:async(input,init)=>{
      const request=new globalThis.Request(input,init);requests.push({url:new URL(request.url).pathname,body:await request.json()});
      return new Response(JSON.stringify({search_id:'s1',results:[],errors:[]}),{status:200,headers:{'content-type':'application/json'}});
    }});
    const service=new ParallelService({root,client:sdk as unknown as ParallelClient}),tools=makeParallelTools(node,ctx,service);
    await execute(tools,'parallel_search',{objective:'Acme',search_queries:['Acme'],mode:'fast',include_domains:['acme.test'],after_date:'2026-01-01',max_results:5});
    await execute(tools,'parallel_extract',{urls:['https://acme.test'],full_content:true});
    expect(requests[0]).toMatchObject({url:'/v1/search',body:{mode:'fast',advanced_settings:{max_results:5,source_policy:{include_domains:['acme.test'],after_date:'2026-01-01'}}}});
    expect(requests[1]).toMatchObject({url:'/v1/extract',body:{advanced_settings:{full_content:true}}});
  });
});

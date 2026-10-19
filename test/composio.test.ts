import { afterEach,describe,expect,it,vi } from 'vitest';
import { mkdtemp,readFile,readdir,rm,stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Composio } from '@composio/core';
import type { Node } from '../src/types.js';
import type { RunContext } from '../src/runner/Runner.js';
import { configSchema } from '../src/config.js';
import { frontmatterSchema,parsePrompt } from '../src/workspace/frontmatter.js';
import { activeBackend,isReadOnlyTool,validateToolArgs,type ComposioBackend,type ToolSchema } from '../src/integrations/composio/backend.js';
import { CLIBackend,normalizeCLIResult,normalizeConnections,normalizeSearch,parseCLIJSON,type CommandExecutor } from '../src/integrations/composio/cli.js';
import { SDKBackend,normalizeSDKResult } from '../src/integrations/composio/sdk.js';
import { makeComposioTools } from '../src/runner/tools/composio.js';

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function rootDir():Promise<string> {const root=await mkdtemp(path.join(os.tmpdir(),'ensemble-composio-'));roots.push(root);return root;}
const inputSchema={type:'object',properties:{subject:{type:'string'},count:{type:'integer'}},required:['subject','count'],additionalProperties:false};
const toolSchema=(slug:string,tags:string[]=[]):ToolSchema=>({slug,description:slug,inputSchema,tags});
function mockBackend():ComposioBackend {return {getToolSchema:vi.fn(async slug=>toolSchema(slug)),searchTools:vi.fn(async()=>[{slug:'GMAIL_LIST_EMAILS',description:'Read'},{slug:'GMAIL_CREATE_EMAIL_DRAFT',description:'Write'},{slug:'SLACK_SEND_MESSAGE',description:'Other toolkit'}]),execute:vi.fn(async()=>({ok:true,data:{items:[]}})),connect:vi.fn(async()=>({connected:false})),connections:vi.fn(async()=>[])};}
async function toolsFor(kind:'prompt'|'action',allowlist:string[],backend:ComposioBackend) {
  const root=await rootDir(),node:Node={id:'test',path:`test.${kind}.md`,kind,fm:frontmatterSchema.parse({outputs:['out.md'],tools:{composio:allowlist}}),body:'Test',inputs:[],inputPatterns:[],outputs:['out.md'],dependencies:[],fingerprint:'a',status:'stale',model:'mock',warnings:[]};
  const ctx:RunContext={root,config:configSchema.parse({}),runId:'run_test',signal:new AbortController().signal,emit:vi.fn()};
  return {node,ctx,tools:await makeComposioTools(node,ctx,backend)};
}
async function call(tool:unknown,input:unknown):Promise<unknown> {return (tool as {execute:(input:unknown,ctx:unknown)=>Promise<unknown>}).execute(input,{});}

describe('Composio backends and native bridge',()=>{
  it('chooses project SDK credentials explicitly and keeps consumer keys on the CLI backend',()=>{
    const config=configSchema.parse({});expect(activeBackend(config,{COMPOSIO_API_KEY:'ak_mock'})).toBe('sdk');
    for(const key of ['ck_mock','uak_mock',''])expect(activeBackend(config,{COMPOSIO_API_KEY:key})).toBe('cli');
    config.composio.backend='sdk';expect(()=>activeBackend(config,{COMPOSIO_API_KEY:'ck_mock'})).toThrow('project');
  });
  it('parses ANSI JSON output and treats successful:false at exit zero as failure',()=>{
    expect(parseCLIJSON('\u001b[32mConnected\u001b[0m\n{"successful":true,"data":{"body":"braces { in quoted body }"}}')).toMatchObject({successful:true});
    expect(normalizeCLIResult({successful:false,data:{},error:''})).toMatchObject({ok:false});
    expect(normalizeCLIResult({data:{}})).toMatchObject({ok:false,error:expect.stringContaining('missing successful')});
    expect(()=>parseCLIJSON('no JSON','\u001b[31mInvalid recipient\u001b[0m',1)).toThrow('Invalid recipient');
    expect(()=>parseCLIJSON('pretty error text')).toThrow('did not return JSON');
    expect(normalizeSDKResult({resultType:'failed',data:{},error:null})).toMatchObject({ok:false,error:'Composio execution failed'});
    expect(normalizeSDKResult({resultType:'completed',data:{id:'draft1'},logId:'log1'})).toEqual({ok:true,data:{id:'draft1'},logId:'log1'});
  });
  it('normalizes search schemas and connection response versions',()=>{
    expect(normalizeSearch({data:{toolkit_results:{gmail:{tools:[{tool_slug:'GMAIL_LIST_EMAILS',description:'Read'}]}}}})).toEqual([{slug:'GMAIL_LIST_EMAILS',description:'Read'}]);
    expect(normalizeConnections({gmail:{status:'ACTIVE'},linear:{status:'INITIATED'}})).toEqual([{toolkit:'gmail',status:'ACTIVE'},{toolkit:'linear',status:'INITIATED'}]);
    expect(normalizeConnections({items:[{toolkit:{slug:'gmail'},status:'ACTIVE'}]})).toEqual([{toolkit:'gmail',status:'ACTIVE'}]);
    expect(()=>normalizeConnections({successful:false,error:'Not authenticated'})).toThrow('Not authenticated');
    expect(()=>normalizeSearch({successful:false,error:'Search failed'})).toThrow('Search failed');
  });
  it('uses argument files with private permissions and cleans them even after CLI validation failure',async()=>{
    const root=await rootDir(),seen:string[]=[],argument={subject:'Literal $(touch /tmp/never) `whoami`',count:1};
    const execute:CommandExecutor=vi.fn(async(_binary,args)=>{
      expect(args.slice(0,3)).toEqual(['execute','GMAIL_CREATE_EMAIL_DRAFT','-d']);const file=args[3].slice(1);seen.push(file);
      expect((await stat(file)).mode&0o777).toBe(0o600);expect(JSON.parse(await readFile(file,'utf8'))).toEqual(argument);
      return {stdout:'',stderr:'\u001b[31mMissing connected account\u001b[0m',exitCode:1};
    });
    const backend=new CLIBackend(root,{execute});const result=await backend.execute('GMAIL_CREATE_EMAIL_DRAFT',argument);expect(result).toMatchObject({ok:false,error:expect.stringContaining('Missing connected account')});
    await expect(stat(seen[0])).rejects.toThrow();expect(await readdir(path.join(root,'.ensemble/tmp'))).toEqual([]);
  });
  it('caches CLI schemas and never mistakes missing success flags or CLI errors for execution success',async()=>{
    const root=await rootDir(),execute=vi.fn<CommandExecutor>(async(_binary,args)=>({stdout:JSON.stringify(args.includes('--get-schema')?{name:'List',parameters:inputSchema}:{successful:false,data:{},error:'Connection missing'}),stderr:'',exitCode:0}));
    const backend=new CLIBackend(root,{execute});expect((await backend.getToolSchema('GMAIL_LIST_EMAILS')).inputSchema).toEqual(inputSchema);await backend.getToolSchema('GMAIL_LIST_EMAILS');expect(execute).toHaveBeenCalledTimes(1);
    expect((await backend.execute('GMAIL_LIST_EMAILS',{subject:'a',count:1})).ok).toBe(false);
    await expect(backend.execute('COMPOSIO_MULTI_EXECUTE_TOOL',{})).rejects.toThrow('meta-tool');
  });
  it('defers step-result placeholders during planning while validating all independent fields',()=>{
    expect(()=>validateToolArgs(inputSchema,{subject:'{{steps.lookup.data.name}}',count:'{{steps.lookup.data.count}}'},{allowReferences:true})).not.toThrow();
    expect(()=>validateToolArgs(inputSchema,{subject:'{{steps.lookup.data.name}}',count:'bad'},{allowReferences:true})).toThrow('integer');
    expect(()=>validateToolArgs(inputSchema,{subject:'{{steps.lookup.data.name}}'},{allowReferences:true})).toThrow('required');
    expect(()=>validateToolArgs(inputSchema,{subject:'Title',count:'{{steps.lookup.data.count}}'})).toThrow('integer');
  });
  it('limits prompt tools to read-only calls and plans expose discovery without write execution',async()=>{
    const backend=mockBackend();
    expect(isReadOnlyTool('GMAIL_LIST_EMAILS')).toBe(true);expect(isReadOnlyTool('GMAIL_CREATE_EMAIL_DRAFT')).toBe(false);
    expect(isReadOnlyTool('GOOGLECALENDAR_EVENTS_LIST')).toBe(true);expect(isReadOnlyTool('MAIL_CREATE_LIST')).toBe(false);
    expect(()=>parsePrompt('---\noutputs: [calendar.md]\ntools:\n  composio: [GOOGLECALENDAR_EVENTS_LIST]\n---\nRead calendar','calendar.prompt.md')).not.toThrow();
    expect(isReadOnlyTool(toolSchema('GMAIL_GET_EMAIL',['createHint']))).toBe(false);
    await expect(toolsFor('prompt',['GMAIL_CREATE_EMAIL_DRAFT'],backend)).rejects.toThrow('.action.md');
    const {tools}=await toolsFor('action',['gmail'],backend);expect(tools.map(tool=>tool.name)).toEqual(['gmail_list_emails','composio_search_tools']);
    await call(tools[0],{subject:'Read',count:1});expect(backend.execute).toHaveBeenCalledWith('GMAIL_LIST_EMAILS',{subject:'Read',count:1});
    const discovered=await call(tools[1],{query:'Find tools'}) as {tools:ToolSchema[]};expect(discovered.tools.map(tool=>tool.slug)).toEqual(['GMAIL_LIST_EMAILS','GMAIL_CREATE_EMAIL_DRAFT']);
    expect(backend.execute).toHaveBeenCalledTimes(1);
    await expect(call(tools[0],{subject:'Read',count:'bad'})).rejects.toThrow('integer');expect(backend.execute).toHaveBeenCalledTimes(1);
  });
  it('creates SDK sessions without sandbox/connection tools and reuses only matching project/user state',async()=>{
    const root=await rootDir(),config=configSchema.parse({}),session={sessionId:'session1',execute:vi.fn(async()=>({resultType:'completed',data:{id:'draft1'},logId:'log1'})),toolkits:vi.fn(async()=>({items:[{slug:'gmail',isNoAuth:false,connection:{isActive:true,connectedAccount:{status:'ACTIVE'}}}],cursor:undefined})),authorize:vi.fn(async()=>({redirectUrl:'https://connect.test/start',waitForConnection:vi.fn()}))};
    const sdk={create:vi.fn(async()=>session),use:vi.fn(async()=>session),tools:{getRawComposioToolBySlug:vi.fn(async slug=>({slug,inputParameters:inputSchema,tags:['readOnlyHint']})),getRawComposioTools:vi.fn(async()=>[{slug:'GMAIL_LIST_EMAILS',description:'Read'}])}};
    const options={apiKey:'ak_mock',sdkFactory:async()=>sdk as unknown as Composio},first=new SDKBackend(root,config,options);
    expect(await first.connections()).toEqual([{toolkit:'gmail',status:'ACTIVE'}]);expect(sdk.create).toHaveBeenCalledWith('local-user',{manageConnections:false,sandbox:{enable:false}});
    expect((await first.getToolSchema('GMAIL_LIST_EMAILS')).tags).toEqual(['readOnlyHint']);await first.getToolSchema('GMAIL_LIST_EMAILS');expect(sdk.tools.getRawComposioToolBySlug).toHaveBeenCalledTimes(1);
    const stored=await readFile(path.join(root,'.ensemble/composio.json'),'utf8');expect(stored).not.toContain('ak_mock');expect((await stat(path.join(root,'.ensemble/composio.json'))).mode&0o777).toBe(0o600);
    const second=new SDKBackend(root,config,options);expect((await second.execute('GMAIL_CREATE_EMAIL_DRAFT',{subject:'Draft'})).ok).toBe(true);expect(sdk.use).toHaveBeenCalledWith('session1');expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(await second.connect('linear')).toEqual({redirectUrl:'https://connect.test/start',connected:false});expect(session.authorize).toHaveBeenCalledWith('linear');
  });
});

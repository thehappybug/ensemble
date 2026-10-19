import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access,mkdir,rm,writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { ComposioBackend,ToolResult,ToolSchema,ToolSummary } from './backend.js';
import { validateSlug } from './backend.js';
import { assertSafePath } from '../../workspace/paths.js';

export interface CommandOutput {stdout:string;stderr:string;exitCode:number}
export type CommandExecutor=(binary:string,args:string[],options:{cwd:string;timeout:number})=>Promise<CommandOutput>;
const exec=promisify(execFile);
export function stripANSI(value:string):string {return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');}
function object(value:unknown):Record<string,unknown> {if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected a Composio JSON object');return value as Record<string,unknown>;}
function errorMessage(value:unknown):string {return typeof value==='string'?value:value&&typeof value==='object'&&'message' in value?String(value.message):JSON.stringify(value??'Unknown Composio error');}
function assertMetadataSuccess(value:unknown):void {if(value&&typeof value==='object'&&!Array.isArray(value)){const result=value as Record<string,unknown>;if(result.successful===false||(result.error&&result.successful!==true))throw new Error(errorMessage(result.error||'Composio CLI reported successful:false'));}}
export function parseCLIJSON(stdout:string,stderr='',exitCode=0):unknown {
  const text=stripANSI(stdout).trim(),errorText=stripANSI(stderr).trim();
  if(exitCode!==0)throw new Error(`Composio CLI exited ${exitCode}: ${(errorText||text||'No error output').slice(0,3000)}`);
  try{return JSON.parse(text);}catch{}
  // CLI versions add banners around JSON. Extract complete top-level containers,
  // respecting escaped quotes so braces in email bodies cannot confuse the parser.
  const values:unknown[]=[];let start=-1,depth=0,inString=false,escaped=false;
  for(let i=0;i<text.length;i++){const char=text[i];if(start<0){if(char==='{'||char==='['){start=i;depth=1;}continue;}if(inString){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')inString=false;continue;}if(char==='"')inString=true;else if(char==='{'||char==='[')depth++;else if(char==='}'||char===']'){depth--;if(depth===0){try{values.push(JSON.parse(text.slice(start,i+1)));}catch{}start=-1;}}}
  if(values.length)return values.at(-1);
  throw new Error(`Composio CLI did not return JSON: ${(errorText||text||'Empty output').slice(0,3000)}`);
}
export function normalizeCLIResult(value:unknown):ToolResult {
  const parsed=object(value),ok=parsed.successful===true;
  return {ok,data:parsed.data??null,...(!ok?{error:parsed.successful===false?errorMessage(parsed.error??'Composio tool reported successful:false'):'Composio CLI response is missing successful:true'}:{}),...(typeof parsed.log_id==='string'?{logId:parsed.log_id}:typeof parsed.logId==='string'?{logId:parsed.logId}:{})};
}
export function normalizeSchema(slug:string,value:unknown):ToolSchema {
  assertMetadataSuccess(value);
  let parsed=object(value);if(parsed.data&&typeof parsed.data==='object'&&!Array.isArray(parsed.data))parsed=object(parsed.data);
  if(parsed.tool&&typeof parsed.tool==='object')parsed=object(parsed.tool);
  const schema=parsed.inputSchema??parsed.inputParameters??parsed.input_parameters??parsed.parameters??(parsed.type==='object'?parsed:undefined);
  if(!schema||typeof schema!=='object'||Array.isArray(schema))throw new Error(`Composio schema missing input parameters for ${slug}`);
  return {slug,description:typeof parsed.description==='string'?parsed.description:slug,inputSchema:schema as Record<string,unknown>,tags:Array.isArray(parsed.tags)?parsed.tags.filter((tag):tag is string=>typeof tag==='string'):[]};
}
export function normalizeSearch(value:unknown):ToolSummary[] {
  assertMetadataSuccess(value);
  const results:ToolSummary[]=[];
  function visit(candidate:unknown):void {
    if(Array.isArray(candidate)){for(const item of candidate)visit(item);return;}
    if(!candidate||typeof candidate!=='object')return;const record=candidate as Record<string,unknown>;
    const slug=record.slug??record.tool_slug??record.toolSlug??(typeof record.name==='string'&&/^[A-Z0-9]+_/.test(record.name)?record.name:undefined);
    if(typeof slug==='string')results.push({slug,description:String(record.description??record.name??slug)});
    else for(const [key,item] of Object.entries(record)){if(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(key)&&item&&typeof item==='object')visit({...(item as Record<string,unknown>),slug:key});else if(!['inputSchema','inputParameters','input_parameters','parameters','properties'].includes(key))visit(item);}
  }
  visit(value);return [...new Map(results.map(result=>[result.slug,result])).values()];
}
export function normalizeConnections(value:unknown):{toolkit:string;status:string}[] {
  assertMetadataSuccess(value);
  const result:{toolkit:string;status:string}[]=[];
  function visit(candidate:unknown,key?:string):void {
    if(Array.isArray(candidate)){for(const item of candidate)visit(item,key);return;}
    if(!candidate||typeof candidate!=='object')return;const record=candidate as Record<string,unknown>;
    const toolkit=typeof record.toolkit==='string'?record.toolkit:record.toolkit&&typeof record.toolkit==='object'?String((record.toolkit as Record<string,unknown>).slug??''):record.appName??record.app_name??record.slug??key;
    const status=record.status??record.connection_status??(record.isConnected===true?'ACTIVE':undefined);
    if(typeof toolkit==='string'&&typeof status==='string')result.push({toolkit:toolkit.toLowerCase(),status});
    else for(const [child,item] of Object.entries(record))if(item&&typeof item==='object')visit(item,['data','connections','items','connected_accounts'].includes(child)?undefined:child);
  }
  visit(value);return result;
}

export class CLIBackend implements ComposioBackend {
  private schemas=new Map<string,Promise<ToolSchema>>();
  constructor(readonly root:string,private readonly options:{binary?:string;execute?:CommandExecutor}={}){}
  private async command(args:string[],timeout=30000):Promise<CommandOutput> {
    const run=this.options.execute??(async(binary,argv,opts)=>{try{const result=await exec(binary,argv,{cwd:opts.cwd,timeout:opts.timeout,maxBuffer:10*1024*1024});return {stdout:result.stdout,stderr:result.stderr,exitCode:0};}catch(error){const failure=error as NodeJS.ErrnoException&{stdout?:string;stderr?:string};if(failure.code==='ENOENT')throw error;return {stdout:failure.stdout??'',stderr:failure.stderr??failure.message,exitCode:typeof failure.code==='number'?failure.code:1};}});
    const options={cwd:this.root,timeout};
    try{return await run(this.options.binary??'composio',args,options);}catch(error){if(this.options.binary||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const fallback=path.join(os.homedir(),'.composio/composio');await access(fallback);return run(fallback,args,options);}
  }
  async getToolSchema(slug:string):Promise<ToolSchema> {
    validateSlug(slug);let promise=this.schemas.get(slug);if(!promise){promise=(async()=>{const result=await this.command(['execute',slug,'--get-schema']);return normalizeSchema(slug,parseCLIJSON(result.stdout,result.stderr,result.exitCode));})();this.schemas.set(slug,promise);promise.catch(()=>this.schemas.delete(slug));}return promise;
  }
  async searchTools(query:string):Promise<ToolSummary[]> {const result=await this.command(['search',query]);return normalizeSearch(parseCLIJSON(result.stdout,result.stderr,result.exitCode));}
  async execute(slug:string,args:Record<string,unknown>):Promise<ToolResult> {
    validateSlug(slug);const relative=`.ensemble/tmp/composio_${randomUUID()}`,directory=path.join(this.root,relative),input=path.join(directory,'args.json');assertSafePath(this.root,relative);await mkdir(directory,{recursive:true,mode:0o700});
    try{await writeFile(input,JSON.stringify(args),{mode:0o600});const result=await this.command(['execute',slug,'-d','@'+input],120000);try{return normalizeCLIResult(parseCLIJSON(result.stdout,result.stderr,result.exitCode));}catch(error){return {ok:false,data:null,error:errorMessage(error instanceof Error?error.message:error)};}}finally{await rm(directory,{recursive:true,force:true});}
  }
  async connect(toolkit:string):Promise<{redirectUrl?:string;connected:boolean}> {
    if(!/^[a-z][a-z0-9_]*$/.test(toolkit))throw new Error('Invalid toolkit name');
    const result=await this.command(['link',toolkit,'--no-browser','--no-wait'],120000);if(result.exitCode!==0)parseCLIJSON(result.stdout,result.stderr,result.exitCode);
    let parsed:Record<string,unknown>={};try{parsed=object(parseCLIJSON(result.stdout));}catch{}
    const redirectUrl=parsed.redirectUrl??parsed.redirect_url??stripANSI(result.stdout).match(/https:\/\/[^\s"<>]+/)?.[0];
    const connections=await this.connections();return {...(typeof redirectUrl==='string'?{redirectUrl}:{}),connected:connections.some(connection=>connection.toolkit===toolkit&&['ACTIVE','CONNECTED'].includes(connection.status.toUpperCase()))};
  }
  async connections():Promise<{toolkit:string;status:string}[]> {const result=await this.command(['connections','list']);return normalizeConnections(parseCLIJSON(result.stdout,result.stderr,result.exitCode));}
}

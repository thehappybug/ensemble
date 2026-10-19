import path from 'node:path';
import Ajv,{type ErrorObject} from 'ajv';
import type { WorkspaceConfig } from '../../types.js';
import { hash } from '../../workspace/hashing.js';
import { CLIBackend } from './cli.js';
import { SDKBackend } from './sdk.js';
import { isReadOnlySlug } from './readonly.js';
export { isReadOnlySlug } from './readonly.js';

export interface ToolSchema {slug:string;description:string;inputSchema:Record<string,unknown>;tags:string[]}
export interface ToolSummary {slug:string;description:string}
export interface ToolResult {ok:boolean;data:unknown;error?:string;logId?:string}
export interface ComposioBackend {
  getToolSchema(slug:string):Promise<ToolSchema>;
  searchTools(query:string):Promise<ToolSummary[]>;
  execute(slug:string,args:Record<string,unknown>):Promise<ToolResult>;
  connect(toolkit:string):Promise<{redirectUrl?:string;connected:boolean}>;
  connections():Promise<{toolkit:string;status:string}[]>;
}
export function activeBackend(config:WorkspaceConfig,env:NodeJS.ProcessEnv=process.env):'sdk'|'cli' {
  const selected=config.composio.backend==='auto'?(env.COMPOSIO_API_KEY?.startsWith('ak_')?'sdk':'cli'):config.composio.backend;
  if(selected==='sdk'&&!env.COMPOSIO_API_KEY?.startsWith('ak_'))throw new Error('Composio SDK requires a project COMPOSIO_API_KEY beginning ak_; consumer ck_/uak_ credentials use the CLI backend');
  return selected;
}
const backends=new Map<string,ComposioBackend>();
export function getBackend(root:string,config:WorkspaceConfig):ComposioBackend {
  const selected=activeBackend(config),key=[path.resolve(root),selected,config.composio.user_id,hash(process.env.COMPOSIO_API_KEY??'')].join(':');
  let backend=backends.get(key);if(!backend){backend=selected==='sdk'?new SDKBackend(root,config):new CLIBackend(root);backends.set(key,backend);}return backend;
}
export function validateSlug(slug:string):void {if(!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(slug)||slug.startsWith('COMPOSIO_'))throw new Error(`Invalid or unrestricted meta-tool slug: ${slug}`);}
export function isReadOnlyTool(tool:ToolSchema|string,tags:string[]=[]):boolean {
  const slug=typeof tool==='string'?tool:tool.slug,actualTags=typeof tool==='string'?tags:tool.tags;
  if(slug.startsWith('COMPOSIO_'))return false;
  if(actualTags.length)return actualTags.includes('readOnlyHint');
  return isReadOnlySlug(slug);
}
export function isToolAllowed(slug:string,allowlist:string[]):boolean {return allowlist.some(entry=>entry===slug||(/^[a-z][a-z0-9_]*$/.test(entry)&&slug.startsWith(entry.toUpperCase()+'_')));}

const ajv=new Ajv({allErrors:true,strict:false,validateFormats:false,addUsedSchema:false});
const validators=new Map<string,ReturnType<typeof ajv.compile>>();
function pointerValue(value:unknown,pointer:string):unknown {let current=value;for(const segment of pointer.split('/').slice(1)){if(!current||typeof current!=='object')return undefined;current=(current as Record<string,unknown>)[segment.replace(/~1/g,'/').replace(/~0/g,'~')];}return current;}
export function validateToolArgs(schema:Record<string,unknown>,args:Record<string,unknown>,options:{allowReferences?:boolean}={}):Record<string,unknown> {
  const key=JSON.stringify(schema);let validate=validators.get(key);if(!validate){validate=ajv.compile(schema);validators.set(key,validate);}
  if(validate(args))return args;
  const reference=/{{\s*steps\.[A-Za-z0-9_-]+\.data(?:\.[A-Za-z0-9_-]+)*\s*}}/;
  let errors=validate.errors??[];
  if(options.allowReferences) {
    const hasReference=(value:unknown):boolean=>typeof value==='string'?reference.test(value):!!value&&typeof value==='object'&&Object.values(value).some(hasReference);
    errors=errors.filter((error:ErrorObject)=>{
      const value=pointerValue(args,error.instancePath);
      if(typeof value==='string'&&reference.test(value))return false;
      return !(error.keyword==='anyOf'||error.keyword==='oneOf')||!hasReference(value);
    });
  }
  if(errors.length)throw new Error('Invalid tool arguments: '+ajv.errorsText(errors,{separator:'; '}));
  return args;
}

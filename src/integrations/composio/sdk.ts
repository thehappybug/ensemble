import { mkdir,readFile,rename,writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Composio } from '@composio/core';
import type { WorkspaceConfig } from '../../types.js';
import type { ComposioBackend,ToolResult,ToolSchema,ToolSummary } from './backend.js';
import { validateSlug } from './backend.js';
import { normalizeSchema,normalizeSearch } from './cli.js';
import { assertSafePath } from '../../workspace/paths.js';
import { hash } from '../../workspace/hashing.js';

type Session=Awaited<ReturnType<Composio['create']>>;
export interface SDKBackendOptions {apiKey?:string;sdkFactory?:(apiKey:string)=>Promise<Composio>}
export function normalizeSDKResult(value:{resultType:string;data:unknown;error?:string|null;logId?:string}):ToolResult {
  const ok=value.resultType==='completed';return {ok,data:value.data,...(!ok?{error:value.error||`Composio execution ${value.resultType}`}:{}) ,...(value.logId?{logId:value.logId}:{})};
}
export class SDKBackend implements ComposioBackend {
  private sdkPromise?:Promise<Composio>;private sessionPromise?:Promise<Session>;private schemas=new Map<string,Promise<ToolSchema>>();
  private readonly apiKey:string;
  constructor(readonly root:string,private readonly config:WorkspaceConfig,private readonly options:SDKBackendOptions={}) {
    const apiKey=options.apiKey??process.env.COMPOSIO_API_KEY;if(!apiKey?.startsWith('ak_'))throw new Error('Composio SDK requires an ak_ project API key');this.apiKey=apiKey;
  }
  private sdk():Promise<Composio> {return this.sdkPromise??=(this.options.sdkFactory?this.options.sdkFactory(this.apiKey):import('@composio/core').then(({Composio})=>new Composio({apiKey:this.apiKey,allowTracking:false,dangerouslyAllowAutoUploadDownloadFiles:false})));}
  private session():Promise<Session> {
    if(!this.sessionPromise)this.sessionPromise=(async()=>{
      const sdk=await this.sdk(),relative='.ensemble/composio.json',file=path.join(this.root,relative);assertSafePath(this.root,relative);
      let stored:{session_id?:string;user_id?:string;project?:string}|undefined;
      try{stored=JSON.parse(await readFile(file,'utf8')) as typeof stored;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const project=hash(this.apiKey);
      if(stored?.session_id&&stored.user_id===this.config.composio.user_id&&stored.project===project)return sdk.use(stored.session_id);
      // Read-only exposure is enforced by Ensemble's native bridge. Approved
      // deterministic action execution uses this same session for write tools.
      const session=await sdk.create(this.config.composio.user_id,{manageConnections:false,sandbox:{enable:false}});
      await mkdir(path.dirname(file),{recursive:true});const temporary=file+`.${process.pid}.tmp`;assertSafePath(this.root,path.relative(this.root,temporary));await writeFile(temporary,JSON.stringify({session_id:session.sessionId,user_id:this.config.composio.user_id,project}),{mode:0o600});await rename(temporary,file);
      return session;
    })();
    return this.sessionPromise;
  }
  async getToolSchema(slug:string):Promise<ToolSchema> {validateSlug(slug);let promise=this.schemas.get(slug);if(!promise){promise=(async()=>normalizeSchema(slug,await (await this.sdk()).tools.getRawComposioToolBySlug(slug)))();this.schemas.set(slug,promise);promise.catch(()=>this.schemas.delete(slug));}return promise;}
  async searchTools(query:string):Promise<ToolSummary[]> {return normalizeSearch(await (await this.sdk()).tools.getRawComposioTools({search:query}));}
  async execute(slug:string,args:Record<string,unknown>):Promise<ToolResult> {validateSlug(slug);return normalizeSDKResult(await (await this.session()).execute(slug,args));}
  async connect(toolkit:string):Promise<{redirectUrl?:string;connected:boolean}> {
    if(!/^[a-z][a-z0-9_]*$/.test(toolkit))throw new Error('Invalid toolkit name');
    if((await this.connections()).some(connection=>connection.toolkit===toolkit&&['ACTIVE','CONNECTED'].includes(connection.status.toUpperCase())))return {connected:true};
    const request=await (await this.session()).authorize(toolkit);return {...(request.redirectUrl?{redirectUrl:request.redirectUrl}:{}),connected:false};
  }
  async connections():Promise<{toolkit:string;status:string}[]> {
    const session=await this.session(),connections:{toolkit:string;status:string}[]=[];let cursor:string|undefined;
    do{const page=await session.toolkits({isConnected:true,limit:100,...(cursor?{cursor}:{})});for(const toolkit of page.items)connections.push({toolkit:toolkit.slug,status:toolkit.connection?.connectedAccount?.status??(toolkit.connection?.isActive||toolkit.isNoAuth?'ACTIVE':'INACTIVE')});if(page.cursor===cursor)break;cursor=page.cursor;}while(cursor);
    return connections;
  }
}

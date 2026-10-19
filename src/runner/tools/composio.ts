import { createTool,type AgentTool } from '@cline/sdk';
import { z } from 'zod';
import type { Node } from '../../types.js';
import type { RunContext } from '../Runner.js';
import { getBackend,isReadOnlyTool,isToolAllowed,validateSlug,validateToolArgs,type ComposioBackend,type ToolSchema } from '../../integrations/composio/backend.js';

export async function allowedToolSchemas(node:Node,backend:ComposioBackend):Promise<ToolSchema[]> {
  const slugs=new Set<string>();
  for(const entry of node.fm.tools.composio) {
    if(/^[a-z][a-z0-9_]*$/.test(entry)){for(const tool of await backend.searchTools(entry))if(isToolAllowed(tool.slug,[entry])){try{validateSlug(tool.slug);slugs.add(tool.slug);}catch{}}}
    else {validateSlug(entry);slugs.add(entry);}
  }
  return Promise.all([...slugs].sort().map(slug=>backend.getToolSchema(slug)));
}
export async function makeComposioTools(node:Node,ctx:RunContext,backend?:ComposioBackend):Promise<AgentTool[]> {
  if(!node.fm.tools.composio.length&&node.kind!=='action')return [];
  const client=backend??getBackend(ctx.root,ctx.config),schemas=await allowedToolSchemas(node,client),tools:AgentTool[]=[];
  for(const schema of schemas) {
    if(!isReadOnlyTool(schema)) {
      if(node.kind!=='action'&&node.fm.tools.composio.includes(schema.slug))throw new Error(`${schema.slug} is not read-only; use an .action.md`);
      continue;
    }
    tools.push(createTool({name:schema.slug.toLowerCase(),description:schema.description,inputSchema:schema.inputSchema,execute:async(args,toolContext)=>{
      ctx.signal.throwIfAborted();toolContext.signal?.throwIfAborted();
      if(!isToolAllowed(schema.slug,node.fm.tools.composio)||!isReadOnlyTool(schema))throw new Error('Composio tool is outside the read-only allowlist');
      const arguments_=z.record(z.string(),z.unknown()).parse(args);validateToolArgs(schema.inputSchema,arguments_);
      const result=await client.execute(schema.slug,arguments_);ctx.emit({type:'composio.call',tool:schema.slug,readonly:true,ok:result.ok,logId:result.logId});
      if(!result.ok)throw new Error(result.error??`Composio ${schema.slug} failed`);return result.data;
    }}) as AgentTool);
  }
  if(node.kind==='action')tools.push(createTool({name:'composio_search_tools',description:'Discover schemas for tools in this action allowlist. Write tools must be proposed as plan steps and cannot be called during planning.',inputSchema:z.object({query:z.string()}),execute:async({query})=>{
    ctx.signal.throwIfAborted();const results=await client.searchTools(query);return {tools:await Promise.all(results.filter(tool=>isToolAllowed(tool.slug,node.fm.tools.composio)&&!tool.slug.startsWith('COMPOSIO_')).map(async tool=>{const schema=await client.getToolSchema(tool.slug);return {...schema,readonly:isReadOnlyTool(schema)};}))};
  }}) as AgentTool);
  return tools;
}

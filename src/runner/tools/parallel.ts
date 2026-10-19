import { mkdir,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTool,type AgentTool } from '@cline/sdk';
import { z } from 'zod';
import type { Node } from '../../types.js';
import type { RunContext } from '../Runner.js';
import { ParallelService,checkProcessor,type Basis,type Request,type CallOptions } from '../../integrations/parallel/client.js';
import { assertSafePath,toPosix } from '../../workspace/paths.js';
import { parseCSV,stringifyCSV } from '../../workspace/csv.js';

const column=z.object({name:z.string().min(1),type:z.enum(['string','number','integer','boolean']),description:z.string(),nullable:z.boolean().optional()});
export type Column=z.infer<typeof column>;
export function columnsSchema(columns:Column[]):Request {
  if(new Set(columns.map(c=>c.name)).size!==columns.length)throw new Error('Column names must be distinct');
  return {type:'object',properties:Object.fromEntries(columns.map(c=>[c.name,{type:c.nullable?[c.type,'null']:c.type,description:c.description}])),required:columns.map(c=>c.name),additionalProperties:false};
}
export function datasetSchema(columns:Column[],rowCount?:number):Request {return {type:'object',properties:{rows:{type:'array',description:rowCount?`Exactly ${rowCount} rows.`:'All matching rows.',items:columnsSchema(columns)}},required:['rows'],additionalProperties:false};}
function object(value:unknown):Request {if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected JSON object from Parallel');return value as Request;}
function basis(value:unknown):Basis[] {return Array.isArray(value)?value as Basis[]:[];}
function validateRows(value:unknown,columns:Column[]):Request[] {
  if(!Array.isArray(value))throw new Error('Parallel dataset did not contain a rows array');
  return value.map((row,index)=>{
    const record=object(row);
    for(const column of columns) {const value=record[column.name];if(value===null&&column.nullable)continue;const valid=column.type==='integer'?typeof value==='number'&&Number.isInteger(value):typeof value===column.type;if(!valid)throw new Error(`Invalid ${column.type} for rows.${index}.${column.name}`);}
    return Object.fromEntries(columns.map(column=>[column.name,record[column.name]]));
  });
}

export function makeParallelTools(node:Node,ctx:RunContext,service?:ParallelService):AgentTool[] {
  const configured=node.fm.tools.parallel;
  if(configured===false)return [];
  const enabled=new Set(configured===true?['search','extract','research','dataset','enrich','findall']:configured);
  if(!enabled.size)return [];
  const client=service??new ParallelService({root:ctx.root,cache:ctx.config.parallel.cache});
  const processor=(requested:string)=>checkProcessor(requested,ctx.config.parallel.max_processor,node.fm.parallel?.max_processor);
  function options(toolContext?:{signal?:AbortSignal;emitUpdate?:(event:unknown)=>void}):CallOptions {
    return {signal:toolContext?.signal?AbortSignal.any([ctx.signal,toolContext.signal]):ctx.signal,noCache:ctx.noCache,emit:event=>{ctx.emit(event);toolContext?.emitUpdate?.(event);}};
  }
  function safeOutput(output:string,sidecar=false):string {
    const resolved=path.resolve(ctx.root,output),relative=toPosix(path.relative(ctx.root,resolved));assertSafePath(ctx.root,relative);
    const temporary=`.ensemble/tmp/${ctx.runId}/`;
    const allowed=node.outputs.includes(relative)||relative.startsWith(temporary)||(sidecar&&node.outputs.some(output=>['.csv','.json'].includes(path.extname(output))&&relative===output+'.sources.json'));
    if(!allowed)throw new Error(`Write denied: ${relative}; choose a declared output or ${temporary}`);
    return resolved;
  }
  async function write(output:string,content:string,sidecar=false):Promise<void> {ctx.signal.throwIfAborted();const file=safeOutput(output,sidecar);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,content);}
  async function writeRows(output:string,rows:Request[],columns:string[]):Promise<void> {
    if(!['.csv','.json'].includes(path.extname(output)))throw new Error('Output must end in .csv or .json');
    await write(output,output.endsWith('.csv')?stringifyCSV(rows,columns):JSON.stringify(rows,null,2)+'\n');
  }
  const definitions=[
    createTool({name:'parallel_search',description:'Search the public web with cited excerpts. Fast mode defaults to about $0.001 per call; cached calls are free.',inputSchema:z.object({objective:z.string(),search_queries:z.array(z.string()).min(1).max(5),mode:z.enum(['turbo','fast','basic','advanced']).default('fast'),max_results:z.number().int().min(1).max(50).optional(),include_domains:z.array(z.string()).optional(),after_date:z.string().optional()}),execute:async(input,toolContext)=>{
      const result=await client.search({objective:input.objective,search_queries:input.search_queries,mode:input.mode,max_chars_total:12000,advanced_settings:{...(input.max_results?{max_results:input.max_results}:{}),source_policy:{...(input.include_domains?{include_domains:input.include_domains}:{}),...(input.after_date?{after_date:input.after_date}:{})}}},options(toolContext));
      return {content:JSON.stringify(result.data).slice(0,12000),cached:result.cached,cost_estimate:result.cost_estimate};
    }}),
    createTool({name:'parallel_extract',description:'Extract public web pages and cited excerpts. Errors for individual URLs are returned.',inputSchema:z.object({urls:z.array(z.string().url()).min(1).max(10),objective:z.string().optional(),full_content:z.boolean().default(false)}),execute:async(input,toolContext)=>{
      const result=await client.extract({urls:input.urls,...(input.objective?{objective:input.objective}:{}),max_chars_total:12000,advanced_settings:{full_content:input.full_content}},options(toolContext));return {content:JSON.stringify(result.data).slice(0,12000),cached:result.cached,cost_estimate:result.cost_estimate};
    }}),
    createTool({name:'parallel_research',description:'Run asynchronous cited research. Processor cost is enforced by workspace caps. Writes only declared output paths.',inputSchema:z.object({query:z.string(),processor:z.string().default('core'),output_path:z.string().optional(),report_guidance:z.string().optional()}),execute:async(input,toolContext)=>{
      if(input.output_path)safeOutput(input.output_path);
      const result=await client.task({input:input.query,processor:processor(input.processor),task_spec:{output_schema:{type:'text',...(input.report_guidance?{description:input.report_guidance}:{})}}},options(toolContext));
      if(typeof result.data.output.content!=='string')throw new Error('Expected a text report from Parallel');
      const citations=[...new Map(basis(result.data.output.basis).flatMap(field=>field.citations??[]).map(citation=>[citation.url,citation])).values()];
      const report=result.data.output.content+'\n\n## Sources\n\n'+citations.map(citation=>`- [${citation.title??citation.url}](${citation.url})`).join('\n')+'\n';
      if(input.output_path)await write(input.output_path,report);
      return {run_id:result.data.run?.run_id,path:input.output_path,citations_count:citations.length,cached:result.cached,...(!input.output_path?{report:report.slice(0,12000)}:{})};
    }}),
    createTool({name:'parallel_dataset',description:'Research a structured dataset to a declared CSV/JSON output and a per-row citations sidecar.',inputSchema:z.object({query:z.string(),columns:z.array(column).min(1).max(90),row_count_hint:z.number().int().positive().optional(),processor:z.string().default('core'),output_path:z.string()}),execute:async(input,toolContext)=>{
      safeOutput(input.output_path);safeOutput(input.output_path+'.sources.json',true);
      if(!['.csv','.json'].includes(path.extname(input.output_path)))throw new Error('Dataset output must end in .csv or .json');
      const result=await client.task({input:input.query,processor:processor(input.processor),task_spec:{output_schema:{type:'json',json_schema:datasetSchema(input.columns,input.row_count_hint)}}},options(toolContext));
      const rows=validateRows(object(result.data.output.content).rows,input.columns),sources=basis(result.data.output.basis);
      await writeRows(input.output_path,rows,input.columns.map(column=>column.name));
      await write(input.output_path+'.sources.json',JSON.stringify({run_id:result.data.run?.run_id,rows:rows.map((_,index)=>({index,basis:sources.filter(source=>source.field===`rows.${index}`||source.field.startsWith(`rows.${index}.`))})),basis:sources},null,2)+'\n',true);
      return {rows:rows.length,path:input.output_path,cached:result.cached};
    }}),
    createTool({name:'parallel_enrich',description:'Enrich up to 200 CSV/JSON rows with Task Groups. Failed rows are preserved with empty cells and reported.',inputSchema:z.object({input_path:z.string(),key_columns:z.array(z.string()).min(1),new_columns:z.array(column).min(1).max(90),processor:z.string().default('base'),output_path:z.string()}),execute:async(input,toolContext)=>{
      safeOutput(input.output_path);if(!['.csv','.json'].includes(path.extname(input.output_path)))throw new Error('Enrichment output must end in .csv or .json');
      const inputFile=path.resolve(ctx.root,input.input_path),relative=toPosix(path.relative(ctx.root,inputFile));assertSafePath(ctx.root,relative);
      if(!node.inputs.includes(relative)&&!node.outputs.includes(relative)&&!relative.startsWith(`.ensemble/tmp/${ctx.runId}/`))throw new Error('Enrichment input must be a declared input, output or run temporary file');
      if(relative.split('/').some(part=>part==='.env'||part.startsWith('.env.')||['.git','.ensemble-git','.aws','.cline','.composio'].includes(part)))throw new Error('Enrichment cannot read credential or repository metadata files');
      const text=await readFile(inputFile,'utf8');
      const parsed:unknown=input.input_path.endsWith('.csv')?parseCSV(text):JSON.parse(text);const candidateRows=Array.isArray(parsed)?parsed:object(parsed).rows;
      if(!Array.isArray(candidateRows))throw new Error('Enrich input must contain an array of rows');
      const rows=candidateRows.map(object);if(rows.length>200)throw new Error('Enrich is limited to 200 rows');
      for(const row of rows)for(const key of input.key_columns)if(!(key in row))throw new Error(`Missing enrichment key ${key}`);
      const result=await client.enrich(rows,processor(input.processor),columnsSchema(input.new_columns),options(toolContext));
      const failures:Request[]=[];
      const joined=rows.map((row,index)=>{const resultRow=result.data[index],output=resultRow?.output as Request|undefined;if(resultRow?.status==='completed'&&output){try{return {...row,...validateRows([output.content],input.new_columns)[0]};}catch(error){failures.push({index,error:String(error)});}}else failures.push({index,error:resultRow?.error??'Task failed'});return {...row,...Object.fromEntries(input.new_columns.map(column=>[column.name,'']))};});
      await writeRows(input.output_path,joined,[...new Set([...rows.flatMap(row=>Object.keys(row)),...input.new_columns.map(column=>column.name)])]);
      return {rows:joined.length,path:input.output_path,failures,cached:result.cached};
    }}),
    createTool({name:'parallel_findall',description:'Find verified matching entities. Maximum generator core, 50 matches. This can cost several dollars; choose preview for small tests.',inputSchema:z.object({objective:z.string(),entity_type:z.string(),match_conditions:z.array(z.object({name:z.string(),description:z.string()})).min(1),generator:z.enum(['preview','base','core']).default('base'),match_limit:z.number().int().min(5).max(50),output_path:z.string()}),execute:async(input,toolContext)=>{
      safeOutput(input.output_path);if(!['.csv','.json'].includes(path.extname(input.output_path)))throw new Error('FindAll output must end in .csv or .json');
      if(input.generator!=='preview')processor(input.generator);
      const {output_path,...request}=input;const result=await client.findall(request,options(toolContext));
      const candidates=(result.data.candidates as Request[]??[]).filter(candidate=>candidate.match_status==='matched');
      const rows=candidates.map(candidate=>({name:candidate.name,url:candidate.url,description:candidate.description,...Object.fromEntries(input.match_conditions.map(condition=>[condition.name,(candidate.output as Record<string,Request>|undefined)?.[condition.name]?.value??'']))}));
      await writeRows(output_path,rows,['name','url','description',...input.match_conditions.map(condition=>condition.name)]);return {count:rows.length,path:output_path,cached:result.cached};
    }}),
  ];
  return definitions.filter(tool=>enabled.has(tool.name.replace('parallel_',''))) as AgentTool[];
}

import matter from 'gray-matter';
import Handlebars from 'handlebars';
import { z } from 'zod';
import type { Node,PromptFM } from '../types.js';

export const slugify=(value:unknown):string=>String(value??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const handlebars=Handlebars.create();
handlebars.registerHelper('slugify',slugify);
handlebars.registerHelper('today',()=>new Date().toISOString().slice(0,10));
handlebars.registerHelper('json',(value:unknown)=>JSON.stringify(value));
handlebars.registerHelper('lower',(value:unknown)=>String(value).toLowerCase());
handlebars.registerHelper('upper',(value:unknown)=>String(value).toUpperCase());
export function renderTemplate(template:string,variables:Record<string,unknown>):string {
  return handlebars.compile(template,{strict:true,noEscape:true})(variables);
}
const foreach=z.union([z.string().transform(from=>({from,as:'item'})),z.object({from:z.string(),as:z.string().default('item'),key:z.string().optional()})]);
export const frontmatterSchema=z.object({
  id:z.string().optional(),description:z.string().optional(),inputs:z.array(z.string()).default([]),outputs:z.array(z.string()).default([]),foreach:foreach.optional(),vars:z.record(z.string(),z.unknown()).default({}),
  tools:z.object({parallel:z.union([z.boolean(),z.array(z.string())]).default(['search','extract']),composio:z.array(z.string()).default([]),shell:z.boolean().default(false)}).default({parallel:['search','extract'],composio:[],shell:false}),
  model:z.string().optional(),mode:z.enum(['auto','manual']).default('auto'),plan:z.enum(['auto','manual']).default('auto'),timeout:z.string().optional(),budget_usd:z.number().positive().optional(),parallel:z.object({max_processor:z.string().optional()}).optional(),incremental:z.boolean().default(true),export:z.array(z.enum(['pdf'])).default([]),derived_from:z.string().optional(),schedule:z.string().optional(),
});
export function parsePrompt(source:string,promptPath:string):{fm:PromptFM;body:string;warnings:string[]} {
  const parsed=matter(source); const warnings=Object.keys(parsed.data).filter(key=>!(key in frontmatterSchema.shape)).map(key=>`${promptPath}: unknown frontmatter key "${key}"`);
  const fm=frontmatterSchema.parse(parsed.data);
  if(!promptPath.endsWith('.action.md'))for(const tool of fm.tools.composio) {
    if(tool.toUpperCase()===tool && !/^[A-Z0-9]+_(LIST|GET|FETCH|FIND|SEARCH|READ)_/.test(tool))throw new Error(`${promptPath}: Composio tool ${tool} is not read-only; use an action`);
  }
  if(promptPath.endsWith('.action.md')) {
    const stem=promptPath.slice(promptPath.lastIndexOf('/')+1).replace(/\.action\.md$/,'');
    const instanceStem=fm.foreach?`${stem}-{{${fm.foreach.as}._key}}`:stem;
    fm.outputs=[`${instanceStem}.plan.json`,`${instanceStem}.plan.md`,`${instanceStem}.receipt.json`];
    fm.mode=fm.plan;
  } else if(!fm.outputs.length) throw new Error(`${promptPath}: outputs must contain at least one path`);
  return {fm,body:parsed.content,warnings};
}
export function requiredOutputs(node:Node):string[] {return node.kind==='action'?node.outputs.filter(output=>!output.endsWith('.receipt.json')):node.outputs;}

import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {Node} from '../types.js';
import type {Runner,RunContext} from './Runner.js';
import {atomicWrite,requiredOutputs} from '../util.js';
import {stringifyCSV} from '../workspace/csv.js';

export function previewMessages(vars:Record<string,unknown>):{subject:string;body:string}[] {
 const text=(key:string,fallback:string)=>typeof vars[key]==='string'&&(vars[key] as string).trim()?(vars[key] as string).trim():fallback;
 if(!['sender_name','my_company','my_product','product_pitch','target_market'].some(key=>typeof vars[key]==='string'&&(vars[key] as string).trim()))return Array.from({length:3},(_,i)=>({subject:`[SIMULATED] API tooling conversation ${i+1}`,body:`This is a simulated outreach preview, email ${i+1}. No research facts are asserted.`}));
 const sender=text('sender_name','Workspace owner'),company=text('my_company','Our team'),product=text('my_product','API tooling'),market=text('target_market','API providers'),pitch=text('product_pitch',`A conversation about ${product} for ${market}.`);
 const disclosure='SIMULATED outreach preview. No email sent; no research facts or metrics asserted.',signature=`${sender}\n${company}`;
 return [
  {subject:`[SIMULATED] ${product} for ${market}`,body:`${disclosure}\n\nHi,\n\nI'm ${sender} from ${company}. ${pitch}\n\nWould a conversation about ${product} be useful for your API team?\n\n${signature}`},
  {subject:`[SIMULATED] Following up on ${product}`,body:`${disclosure}\n\nHi,\n\nFollowing up on my note from ${company}. ${pitch}\n\nWe could discuss whether ${product} is relevant to ${market}.\n\n${signature}`},
  {subject:`[SIMULATED] Close the loop — ${company}`,body:`${disclosure}\n\nHi,\n\nClosing the loop on ${product}. ${pitch}\n\nIf this is relevant to your API team, I'm happy to share the configured product overview. Otherwise, no follow-up is needed.\n\n${signature}`},
 ];
}
const companyColumns=['company_name','product_name','website','hq_country','funding','one_liner'];
export function previewCompanies(vars:Record<string,unknown>):Record<string,unknown>[] {
 const requested=Number(vars.row_limit??3),limit=Number.isFinite(requested)?Math.max(0,Math.min(10,Math.floor(requested))):3;
 if(vars.preview_companies!==undefined){
  if(!Array.isArray(vars.preview_companies))throw new Error('preview_companies must be an array of configured company rows');
  return vars.preview_companies.slice(0,limit).map((row,index)=>{
   if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.company_name!=='string'||!row.company_name.trim())throw new Error(`preview_companies row ${index+1} requires a company_name`);
   return Object.fromEntries(companyColumns.map(column=>[column,row[column]??'']));
  });
 }
 return Array.from({length:limit},(_,i)=>({company_name:`Sample Agent ${i+1}`,product_name:`Sample ${i+1}`,website:`https://example.com/agent-${i+1}`,hq_country:'Simulated',funding:'Unknown',one_liner:'Synthetic preview company; no real research'}));
}
/** Explicit, cost-free preview. Production runs always use ClineRunner. */
export class SimulationRunner implements Runner {
 async run(node:Node,ctx:RunContext){
  ctx.signal.throwIfAborted();
  ctx.emit({type:'simulation',message:'SIMULATED agent output — no model, research or Composio call'});
  await delay(80,undefined,{signal:ctx.signal});
  ctx.signal.throwIfAborted();
  const summary='SIMULATED: '+(node.fm.description??node.id);
  const vars={...ctx.config.vars,...node.fm.vars},messages=previewMessages(vars);
  if(node.kind==='action'){
   const recipient=String(vars.demo_recipient??'you@example.com');
   const plan={action:node.path,instance:node.item?._key??null,fingerprint:node.fingerprint,planned_at:new Date().toISOString(),run_id:ctx.runId,summary:'SIMULATED — three email drafts and a follow-up ticket',simulated:true,steps:[...messages.map((message,i)=>({id:'draft_'+(i+1),tool:'GMAIL_CREATE_EMAIL_DRAFT',args:{recipient_email:recipient,...message,is_html:false},why:'Preview an email draft; never send'})),{id:'ticket',tool:'LINEAR_CREATE_LINEAR_ISSUE',args:{title:'[SIMULATED] Follow up on outreach',team_id:'simulation-team',description:'Review simulated Gmail drafts: {{steps.draft_1.data.id}}'},why:'Preview a follow-up ticket'}]};
   for(const output of requiredOutputs(node))await atomicWrite(path.join(ctx.root,output),output.endsWith('.json')?JSON.stringify(plan,null,2):'# SIMULATED action plan\n\n'+plan.summary+'\n\n'+plan.steps.map(s=>'## '+s.id+' — '+s.tool+'\n\n```json\n'+JSON.stringify(s.args,null,2)+'\n```').join('\n\n'));
  }else for(const output of node.outputs){
   let content:string;
   if(output.endsWith('.sources.json'))content=JSON.stringify({simulated:true,basis:[]},null,2);
   else if(output.endsWith('.csv'))content=stringifyCSV(previewCompanies(vars),companyColumns);
   else if(output.endsWith('.json'))content=JSON.stringify({simulated:true,node:node.id,fingerprint:node.fingerprint});
   else content=`# ${node.fm.description??node.id}\n\n> SIMULATED preview. No live research or model call.\n\n${node.item?'Company: '+String(node.item.company_name??node.item.name??node.item._key)+'\n\n':''}This output demonstrates the dependency pipeline and changes when its declared inputs change.\n\nRevision: \`${node.fingerprint.slice(-12)}\`\n\n${output.endsWith('sequence.md')?messages.map((message,index)=>`## Email ${index+1}\n\n**Subject:** ${message.subject}\n\n${message.body}\n\n`).join(''):''}## Sources\n\n- https://example.com/simulated — synthetic preview only\n`;
   await atomicWrite(path.join(ctx.root,output),content);
  }
  return {summary,cost:0,parallel_cost:0};
 }
}

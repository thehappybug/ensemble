import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {Node} from '../types.js';
import type {Runner,RunContext} from './Runner.js';
import {atomicWrite,requiredOutputs} from '../util.js';
import {stringifyCSV} from '../workspace/csv.js';
/** Explicit, cost-free preview. Production runs always use ClineRunner. */
export class SimulationRunner implements Runner {
 async run(node:Node,ctx:RunContext){
  ctx.signal.throwIfAborted();
  ctx.emit({type:'simulation',message:'SIMULATED agent output — no model, research or Composio call'});
  await delay(80,undefined,{signal:ctx.signal});
  ctx.signal.throwIfAborted();
  const summary='SIMULATED: '+(node.fm.description??node.id);
  if(node.kind==='action'){
   const recipient=String(ctx.config.vars.demo_recipient??'you@example.com');
   const plan={action:node.path,instance:node.item?._key??null,fingerprint:node.fingerprint,planned_at:new Date().toISOString(),run_id:ctx.runId,summary:'SIMULATED — three email drafts and a follow-up ticket',simulated:true,steps:[...Array.from({length:3},(_,i)=>({id:'draft_'+(i+1),tool:'GMAIL_CREATE_EMAIL_DRAFT',args:{recipient_email:recipient,subject:`[SIMULATED] API tooling conversation ${i+1}`,body:`This is a simulated outreach preview, email ${i+1}. No research facts are asserted.`,is_html:false},why:'Preview an email draft; never send'})),{id:'ticket',tool:'LINEAR_CREATE_LINEAR_ISSUE',args:{title:'[SIMULATED] Follow up on outreach',team_id:'simulation-team',description:'Review simulated Gmail drafts: {{steps.draft_1.data.id}}'},why:'Preview a follow-up ticket'}]};
   for(const output of requiredOutputs(node))await atomicWrite(path.join(ctx.root,output),output.endsWith('.json')?JSON.stringify(plan,null,2):'# SIMULATED action plan\n\n'+plan.summary+'\n\n'+plan.steps.map(s=>'## '+s.id+' — '+s.tool+'\n\n```json\n'+JSON.stringify(s.args,null,2)+'\n```').join('\n\n'));
  }else for(const output of node.outputs){
   let content:string;
   if(output.endsWith('.sources.json'))content=JSON.stringify({simulated:true,basis:[]},null,2);
   else if(output.endsWith('.csv')){const rows=Array.from({length:Math.min(10,Number(ctx.config.vars.row_limit??3))},(_,i)=>({company_name:`Sample Agent ${i+1}`,product_name:`Sample ${i+1}`,website:`https://example.com/agent-${i+1}`,hq_country:'Simulated',funding:'Unknown',one_liner:'Synthetic preview company; no real research'}));content=stringifyCSV(rows);}
   else if(output.endsWith('.json'))content=JSON.stringify({simulated:true,node:node.id,fingerprint:node.fingerprint});
   else content=`# ${node.fm.description??node.id}\n\n> SIMULATED preview. No live research or model call.\n\n${node.item?'Company: '+String(node.item.company_name??node.item.name??node.item._key)+'\n\n':''}This output demonstrates the dependency pipeline and changes when its declared inputs change.\n\nRevision: \`${node.fingerprint.slice(-12)}\`\n\n${output.endsWith('sequence.md')?'## Email 1 — Introduce\nAn API tooling conversation.\n\n## Email 2 — Follow up\nA short follow-up.\n\n## Email 3 — Close the loop\nA final check-in.\n\n':''}## Sources\n\n- https://example.com/simulated — synthetic preview only\n`;
   await atomicWrite(path.join(ctx.root,output),content);
  }
  return {summary,cost:0,parallel_cost:0};
 }
}

import {afterEach,expect,it} from 'vitest';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {configSchema} from '../src/config.js';
import {buildGraph} from '../src/graph/build.js';
import {SimulationRunner,previewCompanies,previewMessages} from '../src/runner/SimulationRunner.js';
import {parseCSV} from '../src/workspace/csv.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
it.each(['before','during'] as const)('preserves an existing output when simulation is aborted %s its delay',async timing=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'ensemble-simulation-abort-'));roots.push(root);
 await writeFile(path.join(root,'work.prompt.md'),'---\noutputs: [output.md]\n---\nWrite output.');
 await writeFile(path.join(root,'output.md'),'Existing user content');
 const config=configSchema.parse({}),node=(await buildGraph(root,config)).nodes[0],controller=new AbortController();
 if(timing==='before')controller.abort(new Error('test interruption'));
 const task=new SimulationRunner().run(node,{root,config,runId:'run_abort_test',signal:controller.signal,emit:()=>{}});
 const timer=timing==='during'?setTimeout(()=>controller.abort(new Error('test interruption')),10):undefined;
 try{await expect(task).rejects.toThrow();expect(await readFile(path.join(root,'output.md'),'utf8')).toBe('Existing user content');}finally{clearTimeout(timer);}
});
it('uses configured preview companies and identical configured outreach in sequences and draft plans',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'ensemble-simulation-context-'));roots.push(root);
 await Promise.all([
  writeFile(path.join(root,'companies.prompt.md'),'---\noutputs: [companies.csv, companies.csv.sources.json]\n---\nBuild preview companies.'),
  writeFile(path.join(root,'sequence.prompt.md'),'---\noutputs: [sequence.md]\n---\nPrepare preview outreach.'),
  writeFile(path.join(root,'drafts.action.md'),'---\ntools:\n  composio: [GMAIL_CREATE_EMAIL_DRAFT, LINEAR_CREATE_LINEAR_ISSUE]\n---\nPrepare draft plan.'),
 ]);
 const companies=[{company_name:'Maple, Inc',product_name:'Maple API',website:'https://example.com/maple',hq_country:'Synthetic',funding:'Not asserted',one_liner:'Configured fictional API provider'},{company_name:'Birch',product_name:'Birch API',website:'https://example.com/birch',hq_country:'Synthetic',funding:'Not asserted',one_liner:'Another configured fictional API provider'},{company_name:'Unused',product_name:'Unused API',website:'https://example.com/unused',hq_country:'Synthetic',funding:'Not asserted',one_liner:'Excluded by row limit'}];
 const config=configSchema.parse({vars:{preview_companies:companies,row_limit:2,sender_name:'Dana',my_company:'Example Tools',my_product:'SDK Forge',product_pitch:'Generate SDKs from OpenAPI specifications.',target_market:'companies with public APIs',demo_recipient:'operator@example.com'}});
 const graph=await buildGraph(root,config),runner=new SimulationRunner();
 for(const node of graph.nodes)await runner.run(node,{root,config,runId:'run_context_test',signal:new AbortController().signal,emit:()=>{}});
 expect(parseCSV(await readFile(path.join(root,'companies.csv'),'utf8'))).toEqual(companies.slice(0,2));
 expect(JSON.parse(await readFile(path.join(root,'companies.csv.sources.json'),'utf8')).simulated).toBe(true);
 const sequence=await readFile(path.join(root,'sequence.md'),'utf8'),plan=JSON.parse(await readFile(path.join(root,'drafts.plan.json'),'utf8'));
 expect(plan.simulated).toBe(true);expect(plan.steps).toHaveLength(4);
 for(const [index,message] of previewMessages(config.vars).entries()){
  expect(plan.steps[index].args).toMatchObject({...message,recipient_email:'operator@example.com',is_html:false});
  expect(sequence).toContain(message.subject);expect(sequence).toContain(message.body);expect(message.body).toContain('Dana');expect(message.body).toContain('Example Tools');expect(message.body).toContain('SDK Forge');expect(message.body).toContain('Generate SDKs from OpenAPI specifications.');expect(message.body).toContain('SIMULATED');
 }
 expect(sequence).toContain('companies with public APIs');expect(sequence).not.toContain('Sample Agent');
});
it('preserves default Sample Agent rows and bounds configured rows without inventing extra company facts',()=>{
 expect(previewCompanies({row_limit:1})).toEqual([{company_name:'Sample Agent 1',product_name:'Sample 1',website:'https://example.com/agent-1',hq_country:'Simulated',funding:'Unknown',one_liner:'Synthetic preview company; no real research'}]);
 expect(previewCompanies({preview_companies:[{company_name:'Configured'}],row_limit:10})).toEqual([{company_name:'Configured',product_name:'',website:'',hq_country:'',funding:'',one_liner:''}]);
 expect(()=>previewCompanies({preview_companies:[{name:'Missing company_name'}]})).toThrow('requires a company_name');
});

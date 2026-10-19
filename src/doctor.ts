import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Agent,Llms} from '@cline/sdk';
import Parallel from 'parallel-web';
import {chromium} from 'playwright';
import type {Node,WorkspaceConfig} from './types.js';
import {loadConfig} from './config.js';
import {buildGraph} from './graph/build.js';
import {frontmatterSchema} from './workspace/frontmatter.js';
import {resolveAuth} from './runner/auth.js';
import {exists,message} from './util.js';
import {getBackend,activeBackend} from './integrations/composio/backend.js';
const exec=promisify(execFile);
export interface DoctorCheck {check:string;status:'ok'|'warn'|'error';detail:string}
export interface DoctorOptions {smokeCline?:boolean;smokeParallel?:boolean;config?:WorkspaceConfig;clineProbe?:()=>Promise<string>;parallelProbe?:()=>Promise<string>;connectionsProbe?:()=>Promise<{toolkit:string;status:string}[]>;}
export async function doctor(root:string,options:DoctorOptions={}):Promise<DoctorCheck[]>{
 const config=options.config??await loadConfig(root),checks:DoctorCheck[]=[];
 const add=(check:string,status:DoctorCheck['status'],detail:string)=>checks.push({check,status,detail});
 const version=process.versions.node.split('.').map(Number);add('Node',version[0]>22||(version[0]===22&&(version[1]>22||(version[1]===22&&version[2]>=3)))?'ok':'error',process.versions.node+'; requires >=22.22.3');
 try{add('git','ok',(await exec('git',['--version'])).stdout.trim());}catch(e){add('git','error',message(e));}
 const graph=await buildGraph(root,config);const invalid=graph.nodes.filter(n=>n.status==='invalid');add('workspace',invalid.length?'error':'ok',invalid.length?invalid.map(n=>n.id+': '+n.reason).join('; '):`${graph.nodes.length} nodes parsed`);
 const node:Node={id:'doctor',path:'doctor.prompt.md',kind:'prompt',fm:frontmatterSchema.parse({outputs:['doctor.md'],tools:{parallel:false}}),body:'Reply OK.',inputs:[],inputPatterns:[],outputs:[],dependencies:[],fingerprint:'doctor',status:'stale',model:config.llm.model,warnings:[]};
 if(options.smokeCline===false)add('Cline auth','warn','Live tiny smoke skipped (--no-llm).');
 else try{
  const result=options.clineProbe?await options.clineProbe() : await (async()=>{const auth=await resolveAuth(node,config,root);const catalogue=await Llms.getModelsForProvider(auth.providerId);if(auth.providerId==='cline'&&!catalogue[auth.modelId])throw new Error('Model is absent from the pinned Cline catalogue: '+auth.modelId);const agent=new Agent({...auth,maxIterations:1,systemPrompt:'Reply OK.',modelOptions:{maxTokens:32}});const timer=setTimeout(()=>agent.abort('doctor timeout'),15000);try{const result=await agent.run('OK');if(result.status!=='completed')throw new Error(result.error?.message??'Cline smoke failed: '+result.status);return 'Tiny provider smoke completed';}finally{clearTimeout(timer);}})();add('Cline auth','ok',result);
 }catch(e){add('Cline auth','error',message(e));}
 if(!process.env.PARALLEL_API_KEY&&!options.parallelProbe)add('Parallel','error','Set PARALLEL_API_KEY in workspace .env or environment');
 else if(!options.smokeParallel)add('Parallel','warn','Key present; fast-search smoke not requested. Use --smoke-parallel (about $0.001).');
 else try{const result=options.parallelProbe?await options.parallelProbe():await (async()=>{const response=await new Parallel({apiKey:process.env.PARALLEL_API_KEY,maxRetries:0,timeout:10000}).search({mode:'fast',objective:'Verify API connectivity',search_queries:['Parallel web search'],max_chars_total:1000});return `Fast search completed: ${response.results.length} results`})();add('Parallel','ok',result);}catch(e){add('Parallel','error',message(e));}
 try{const backend=activeBackend(config);add('Composio backend','ok',backend+'; CLI consumer connections and SDK project connections are separate');const connections=options.connectionsProbe?await options.connectionsProbe():await (await getBackend(root,config)).connections();const connected=connections.filter(c=>/active|connected/i.test(c.status));for(const toolkit of ['gmail','linear'])add(toolkit,connected.some(c=>c.toolkit.toLowerCase()===toolkit)?'ok':'warn',connected.some(c=>c.toolkit.toLowerCase()===toolkit)?'Connected':`Run ensemble connect ${toolkit} using the active backend`);}catch(e){add('Composio connections','error',message(e));}
 add('Chromium',await exists(chromium.executablePath())?'ok':'warn',await exists(chromium.executablePath())?'Installed; PDF launch may still require process permissions':'Run npx playwright install chromium');
 add('Demo recipient',typeof config.vars.demo_recipient==='string'&&!/@example\.(com|org|net)$/i.test(config.vars.demo_recipient)?'ok':'warn','Set vars.demo_recipient to your own connected Gmail address before real approval');
 return checks;
}

import {afterEach,expect,it} from 'vitest';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {configSchema} from '../src/config.js';
import {buildGraph} from '../src/graph/build.js';
import {SimulationRunner} from '../src/runner/SimulationRunner.js';
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

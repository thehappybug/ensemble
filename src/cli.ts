#!/usr/bin/env node
import {Command} from 'commander';
import {findWorkspace,loadConfig} from './config.js';
import {StateStore} from './graph/state.js';
import {Scheduler} from './graph/scheduler.js';
import {FakeRunner} from './runner/FakeRunner.js';
import {initWorkspace,newPrompt,clonePrompt} from './workspace/commands.js';
import path from 'node:path';
import {message} from './util.js';
const cli=new Command().name('ensemble').description('Turn a directory into a reactive agent workspace').version('0.1.0');
export async function openWorkspace(){const root=await findWorkspace(process.cwd());const config=await loadConfig(root);const store=await new StateStore(root).load();return {root,config,store};}
cli.command('init [dir]').option('--example <name>').action(async(dir='.',options)=>{console.log('Initialized '+await initWorkspace(dir,options.example));});
cli.command('new <file>').option('--foreach <file>').option('--from-description <text>').action(async(file,options)=>{const w=await openWorkspace();const target=path.relative(w.root,path.resolve(file));console.log(await newPrompt(w.root,target,{foreach:options.foreach,fromDescription:options.fromDescription}));});
cli.command('clone <source> [destination]').action(async(source,destination)=>{const w=await openWorkspace();console.log(await clonePrompt(w.root,path.relative(w.root,path.resolve(source)),destination?path.relative(w.root,path.resolve(destination)):undefined));});
cli.command('status [path]').option('--json').action(async(filter,options)=>{const w=await openWorkspace(),s=new Scheduler(w.root,w.config,w.store,new FakeRunner());await s.refresh();const nodes=s.graph.nodes.filter(n=>!filter||n.path.startsWith(filter));if(options.json)console.log(JSON.stringify(nodes,null,2));else console.table(nodes.map(n=>({node:n.id,state:n.status,reason:n.reason??''})));});
cli.command('graph').option('--json').option('--mermaid').action(async options=>{const w=await openWorkspace(),s=new Scheduler(w.root,w.config,w.store,new FakeRunner());await s.refresh();if(options.mermaid){console.log('graph LR');const ids=new Map(s.graph.nodes.map((n,i)=>[n.id,'n'+i]));for(const n of s.graph.nodes)console.log(`  ${ids.get(n.id)}[${JSON.stringify(n.id)}]`);for(const e of s.graph.edges)console.log(`  ${ids.get(e.source)} --> ${ids.get(e.target)}`);}else console.log(JSON.stringify(s.graph,null,2));});
cli.command('run [targets...]').option('--dry-run').option('--force').option('--downstream').option('--failed').option('--stale').option('--no-cache').option('--var <k=v...>').action(async(targets,options)=>{const w=await openWorkspace();for(const v of options.var??[]){const i=v.indexOf('=');if(i<1)throw new Error('Expected --var key=value');let value:unknown=v.slice(i+1);try{value=JSON.parse(value as string);}catch{}w.config.vars[v.slice(0,i)]=value;}if(!options.dryRun)throw new Error('Live runner is introduced in M2. Use --dry-run to inspect the graph.');const s=new Scheduler(w.root,w.config,w.store,new FakeRunner());console.log(JSON.stringify(await s.dryRun({...options,targets,noCache:!options.cache}),null,2));});
cli.parseAsync().catch(e=>{console.error(message(e));process.exitCode=/workspace|config|ensemble.yaml/i.test(message(e))?2:1;});

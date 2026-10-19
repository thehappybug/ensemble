import path from 'node:path';
import type {Node} from '../types.js';
import type {Runner,RunContext,RunOutcome} from './Runner.js';
import {atomicWrite,requiredOutputs} from '../util.js';
/** Explicit simulation for deterministic tests and offline UI previews. Never selected by default. */
export class FakeRunner implements Runner {
 runs:string[]=[];active=0;maxActive=0;
 constructor(private handler?:(node:Node,ctx:RunContext)=>Promise<RunOutcome>){}
 async run(node:Node,ctx:RunContext){this.runs.push(node.id);this.active++;this.maxActive=Math.max(this.maxActive,this.active);try{if(this.handler)return await this.handler(node,ctx);for(const output of requiredOutputs(node))await atomicWrite(path.join(ctx.root,output),'SIMULATED\n'+node.id+'\n'+node.fingerprint+'\n');return {summary:'SIMULATED deterministic output'};}finally{this.active--;}}
}

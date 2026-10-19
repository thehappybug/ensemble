import type {Node,RunMeta,WorkspaceConfig} from '../types.js';
export interface RunContext {root:string;config:WorkspaceConfig;runId:string;signal:AbortSignal;noCache?:boolean;previous?:RunMeta;emit:(event:Record<string,unknown>)=>void;}
export interface RunOutcome {summary:string;unchanged?:string[];usage?:unknown;cost?:number;parallel_cost?:number;warnings?:string[];}
export interface Runner {run(node:Node,context:RunContext):Promise<RunOutcome>;abort?(runId:string):Promise<void>;dispose?():Promise<void>;}

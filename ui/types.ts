import type { ApprovalRecord,Node,RunMeta } from '../src/types.js';
export type { NodeStatus,RunMeta,ApprovalRecord,PromptFM } from '../src/types.js';
export interface GraphNode extends Node {state?:Node['status'];lastRun?:RunMeta;approval?:ApprovalRecord;costs?:{llm:number;parallel:number}}
export interface GraphData {name?:string;simulated?:boolean;actionsDryRun?:boolean;nodes:GraphNode[];edges:{source:string;target:string}[];files:string[];warnings?:string[];paused:boolean;costs:{llm:number;parallel:number;librarian?:number}}
export interface NodeDetail extends GraphNode {inputHashes?:Record<string,string>;runs?:RunMeta[]}
export interface WorkspaceEvent {type:string;at:string;data:Record<string,unknown>}

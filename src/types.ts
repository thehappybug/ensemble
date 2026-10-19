export type NodeStatus = 'invalid'|'blocked'|'pending-expansion'|'fresh'|'stale'|'modified'|'queued'|'running'|'failed'|'awaiting-approval'|'executing';
export interface WorkspaceConfig {
 version: number; name: string; llm: {provider:string;model:string;summarizer_model:string;max_iterations:number;base_url?:string;api_key_env?:string};
 scheduler:{concurrency:number;debounce_ms:number;fanout_confirm_over:number}; defaults:{timeout:string;budget_usd:number};
 parallel:{max_processor:string;cache:boolean}; composio:{backend:'auto'|'sdk'|'cli';user_id:string;dry_run:boolean};
 git:{auto_commit:boolean;author:string}; agents_md:{enabled:boolean;claude_md_shim:boolean;summaries:boolean};ui:{port:number};vars:Record<string,unknown>;ignore:string[];
}
export interface PromptFM {
 id?:string; description?:string; inputs:string[];outputs:string[];foreach?:{from:string;as:string;key?:string};vars:Record<string,unknown>;
 tools:{parallel:boolean|string[];composio:string[];shell:boolean};model?:string;mode:'auto'|'manual';plan:'auto'|'manual';timeout?:string;budget_usd?:number;
 parallel?:{max_processor?:string};incremental:boolean;export:string[];derived_from?:string;schedule?:string;
}
export interface Node {
 id:string;path:string;kind:'prompt'|'action'|'fanout';fm:PromptFM;body:string;inputs:string[];inputPatterns:string[];outputs:string[];dependencies:string[];fingerprint:string;
 status:NodeStatus;reason?:string;item?:Record<string,unknown>;instanceOf?:string;foreachSource?:string;expansionHash?:string;expansionCount?:number;model:string;warnings:string[];
}
export interface Graph {nodes:Node[];edges:{source:string;target:string}[];files:string[];warnings:string[]}
export interface Success {runId:string;fingerprint:string;outputs:Record<string,string>;inputs:Record<string,string>;at:string;commit?:string}
export interface RunMeta {runId:string;node:string;fingerprint:string;status:string;started_at:string;ended_at?:string;summary?:string;error?:string;model:string;inputs:Record<string,string>;outputs?:Record<string,string>;usage?:unknown;cost?:number;parallel_cost?:number;commit?:string;inputs_commit?:string;warnings?:string[]}
export interface NodeRecord {lastSuccess?:Success;lastRun?:RunMeta;rejected?:string;scheduledTick?:string}
export interface StateData {version:1;nodes:Record<string,NodeRecord>;fanoutApprovals:Record<string,string>}

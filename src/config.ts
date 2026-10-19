import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import YAML from 'yaml';
import dotenv from 'dotenv';
import type { WorkspaceConfig } from './types.js';

const positive = z.number().positive();
export const configSchema = z.object({
  version: z.literal(1).default(1), name: z.string().default('ensemble'),
  llm: z.object({provider:z.string().default('cline'), model:z.string().default('anthropic/claude-sonnet-5.5'), summarizer_model:z.string().default('anthropic/claude-haiku-4.5'), max_iterations:positive.int().default(60), base_url:z.string().optional(), api_key_env:z.string().optional()}).default({provider:'cline',model:'anthropic/claude-sonnet-5.5',summarizer_model:'anthropic/claude-haiku-4.5',max_iterations:60}),
  scheduler:z.object({concurrency:positive.int().default(3), debounce_ms:z.number().nonnegative().default(1500), fanout_confirm_over:positive.int().default(12)}).default({concurrency:3,debounce_ms:1500,fanout_confirm_over:12}),
  defaults:z.object({timeout:z.string().default('30m'),budget_usd:positive.default(3)}).default({timeout:'30m',budget_usd:3}),
  parallel:z.object({max_processor:z.string().default('pro'),cache:z.boolean().default(true)}).default({max_processor:'pro',cache:true}),
  composio:z.object({backend:z.enum(['auto','sdk','cli']).default('auto'),user_id:z.string().default('local-user'),dry_run:z.boolean().default(false)}).default({backend:'auto',user_id:'local-user',dry_run:false}),
  git:z.object({auto_commit:z.boolean().default(true),author:z.string().default('Ensemble <ensemble@localhost>')}).default({auto_commit:true,author:'Ensemble <ensemble@localhost>'}),
  agents_md:z.object({enabled:z.boolean().default(true),claude_md_shim:z.boolean().default(true),summaries:z.boolean().default(true)}).default({enabled:true,claude_md_shim:true,summaries:true}),
  ui:z.object({port:positive.int().max(65535).default(4567)}).default({port:4567}),vars:z.record(z.string(),z.unknown()).default({}),ignore:z.array(z.string()).default([]),
});

export async function findWorkspace(start = process.cwd()): Promise<string> {
  let dir=path.resolve(start);
  if ((await stat(dir)).isFile()) dir=path.dirname(dir);
  for (;;) {
    try { if ((await stat(path.join(dir,'ensemble.yaml'))).isFile()) return dir; } catch {}
    const parent=path.dirname(dir); if(parent===dir) throw new Error(`No ensemble.yaml found above ${start}`); dir=parent;
  }
}

export async function loadConfig(root:string): Promise<WorkspaceConfig> {
  const raw:unknown=YAML.parse(await readFile(path.join(root,'ensemble.yaml'),'utf8'));
  function checkSecrets(value:unknown):void { if(value && typeof value==='object') for(const [key,v] of Object.entries(value)) { if(/^(api_?key|token|secret|password|credentials)$/i.test(key)) throw new Error(`Secrets must use environment variables, not ensemble.yaml (${key})`); checkSecrets(v); } }
  checkSecrets(raw);
  const config=configSchema.parse(raw ?? {});
  dotenv.config({path:path.join(root,'.env'),quiet:true});
  return config;
}

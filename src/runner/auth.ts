import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProviderSettingsManager } from '@cline/sdk';
import type { Node, WorkspaceConfig } from '../types.js';

const originalDataDir = process.env.CLINE_DATA_DIR ?? path.join(homedir(), '.cline', 'data');
export interface ResolvedAuth {
  providerId: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export async function resolveAuth(node: Node, config: WorkspaceConfig, root: string): Promise<ResolvedAuth> {
  const separator = node.model.indexOf(':');
  const providerId = separator > 0 ? node.model.slice(0, separator) : config.llm.provider;
  const modelId = separator > 0 ? node.model.slice(separator + 1) : node.model;
  const envName = config.llm.api_key_env ?? ({ cline: 'CLINE_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY', 'openai-compatible': 'OPENAI_API_KEY', openai: 'OPENAI_API_KEY' }[providerId] ?? `${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`);
  let apiKey = process.env[envName];
  let baseUrl = config.llm.base_url;
  let headers: Record<string, string> | undefined;
  if (!apiKey && providerId === 'cline') {
    const directory = path.join(root, '.ensemble', 'cline', 'auth-read', randomUUID());
    try {
      const original = await readFile(path.join(originalDataDir, 'settings', 'providers.json'));
      await mkdir(path.join(directory, 'settings'), { recursive: true, mode: 0o700 });
      const filePath = path.join(directory, 'settings', 'providers.json');
      await writeFile(filePath, original, { mode: 0o600 });
      // Constructor migrations and chmod operate only on this temporary copy.
      const stored = new ProviderSettingsManager({ filePath, dataDir: directory }).getProviderConfig('cline');
      apiKey = stored?.apiKey;
      baseUrl ??= stored?.baseUrl;
      headers = stored?.headers;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read stored Cline authentication; run `cline auth` or set CLINE_API_KEY');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (!apiKey) throw new Error(providerId === 'cline' ? 'Run `cline auth` or set CLINE_API_KEY' : `Set ${envName} for provider ${providerId}`);
  if (providerId === 'openai-compatible' && !baseUrl) throw new Error('Set llm.base_url for the openai-compatible provider');
  return { providerId, modelId, apiKey, ...(baseUrl ? { baseUrl } : {}), ...(headers ? { headers } : {}) };
}

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { createSummaryProvider, readLibrarianUsage, summarizeFiles, type SummaryContext, type SummaryInput, type SummaryProvider } from '../src/librarian/summarize.js';
import { createMockLlm } from './mock-llm.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(files: Record<string, string | Buffer> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ensemble-summaries-')); roots.push(root);
  for (const [file, text] of Object.entries({ 'ensemble.yaml': 'version: 1\nname: summary-test\n', ...files })) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text);
  }
  return { root, config: await loadConfig(root) };
}
function recorder() {
  const calls: Array<{ items: SummaryInput[]; kind: SummaryContext['kind'] }> = [];
  const provider: SummaryProvider = async (items, context) => {
    calls.push({ items, kind: context.kind });
    context.recordUsage({ inputTokens: 10, outputTokens: 5, cost: 0.001 });
    return Object.fromEntries(items.map(item => [item.key, `Summary of ${item.key}.\nOne useful line.`]));
  };
  return { calls, provider };
}

describe('cached librarian summaries', () => {
  it('batches at most20 files and reuses summaries by content hash', async () => {
    const files = Object.fromEntries(Array.from({ length: 23 }, (_, index) => [`file-${index}.md`, `Distinct evidence ${index}`]));
    const f = await fixture(files), r = recorder();
    const result = await summarizeFiles(f.root, Object.keys(files), f.config, { provider: r.provider });
    expect(r.calls.filter(call => call.kind === 'files').map(call => call.items.length)).toEqual([20, 3]);
    expect(result.summaries['file-0.md']).toBe('Summary of file-0.md. One useful line.');
    expect(result.purposes['.']).toBeTruthy();
    expect(result.usage).toEqual({ calls: 3, inputTokens: 30, outputTokens: 15, cost: 0.003 });
    expect(await readLibrarianUsage(f.root)).toEqual(result.usage);
    const again = await summarizeFiles(f.root, Object.keys(files), f.config, { provider: r.provider });
    expect(again.usage.calls).toBe(0);
    expect(r.calls).toHaveLength(3);
    await writeFile(path.join(f.root, 'copy.md'), 'Distinct evidence 0');
    await summarizeFiles(f.root, [...Object.keys(files), 'copy.md'], f.config, { provider: r.provider });
    expect(r.calls.filter(call => call.kind === 'files')).toHaveLength(2);
    expect(r.calls.at(-1)?.kind).toBe('directories');
  });

  it('regenerates file summaries on content edits and directory purposes only on filename changes', async () => {
    const f = await fixture({ 'notes.md': '# First notes' }), r = recorder();
    await summarizeFiles(f.root, ['notes.md'], f.config, { provider: r.provider });
    await writeFile(path.join(f.root, 'notes.md'), '# Changed notes');
    const result = await summarizeFiles(f.root, ['notes.md'], f.config, { provider: r.provider });
    expect(result.usage.calls).toBe(1);
    expect(r.calls.map(call => call.kind)).toEqual(['files', 'directories', 'files']);
  });

  it('deduplicates identical content within the first uncached batch', async () => {
    const f = await fixture({ 'a.md': 'Same evidence', 'b.md': 'Same evidence' }), r = recorder();
    const result = await summarizeFiles(f.root, ['a.md', 'b.md'], f.config, { provider: r.provider });
    expect(r.calls.find(call => call.kind === 'files')?.items).toHaveLength(1);
    expect(result.summaries['a.md']).toBe(result.summaries['b.md']);
  });

  it('sends only first/last8KB for large files and never sends assets, binary bytes, or secrets', async () => {
    const large = 'FIRST_MARKER\n' + 'a'.repeat(30_000) + 'MIDDLE_MUST_NOT_BE_SENT' + 'b'.repeat(30_000) + '\nLAST_MARKER';
    const f = await fixture({ 'large.md': large, 'picture.svg': '<svg>ASSET_MUST_NOT_BE_SENT</svg>', 'blob': Buffer.from([1, 0, 2]), '.env': 'SECRET_MUST_NOT_BE_SENT=private', 'AGENTS.md': 'MANAGED_MUST_NOT_BE_SENT' }), r = recorder();
    const result = await summarizeFiles(f.root, ['large.md', 'picture.svg', 'blob', '.env', 'AGENTS.md'], f.config, { provider: r.provider });
    const transmitted = JSON.stringify(r.calls);
    expect(transmitted).toContain('FIRST_MARKER'); expect(transmitted).toContain('LAST_MARKER');
    for (const marker of ['MIDDLE_MUST_NOT_BE_SENT', 'ASSET_MUST_NOT_BE_SENT', 'SECRET_MUST_NOT_BE_SENT', 'MANAGED_MUST_NOT_BE_SENT']) expect(transmitted).not.toContain(marker);
    expect(result.summaries['picture.svg']).toContain('asset'); expect(result.summaries.blob).toContain('asset');
    expect(result.summaries['.env']).toContain('excluded');
  });

  it('keeps no-LLM descriptions eligible for a later model upgrade', async () => {
    const f = await fixture({ 'notes.md': '# Deterministic heading' }), r = recorder();
    const fallback = await summarizeFiles(f.root, ['notes.md'], f.config, { noLlm: true, provider: r.provider });
    expect(fallback.summaries['notes.md']).toBe('Deterministic heading'); expect(r.calls).toEqual([]);
    await summarizeFiles(f.root, ['notes.md'], f.config, { provider: r.provider });
    expect(r.calls.map(call => call.kind)).toEqual(['files', 'directories']);
  });

  it('caches failed summaries without repeated model attempts on unchanged evidence', async () => {
    const f = await fixture({ 'notes.md': '# Fallback heading' }); let calls = 0;
    const provider: SummaryProvider = async () => { calls++; throw new Error('Must not leak token-shaped details'); };
    const first = await summarizeFiles(f.root, ['notes.md'], f.config, { provider });
    expect(first.summaries['notes.md']).toBe('Fallback heading'); expect(calls).toBe(2);
    expect(JSON.stringify(first.warnings)).not.toContain('token-shaped');
    await summarizeFiles(f.root, ['notes.md'], f.config, { provider }); expect(calls).toBe(2);
    const cache = JSON.parse(await readFile(path.join(f.root, '.ensemble/summaries.json'), 'utf8'));
    expect(Object.values(cache.files)).toMatchObject([{ status: 'failed' }]);
  });

  it('bounds an unresponsive provider and caches its fallback', async () => {
    const f = await fixture({ 'notes.md': '# Timeout fallback' });
    const provider: SummaryProvider = () => new Promise(() => {});
    const first = await summarizeFiles(f.root, ['notes.md'], f.config, { provider, timeoutMs: 5 });
    expect(first.warnings).toHaveLength(2);
    expect(first.summaries['notes.md']).toBe('Timeout fallback');
    expect((await summarizeFiles(f.root, ['notes.md'], f.config, { provider, timeoutMs: 5 })).usage.calls).toBe(0);
  });

  it('runs the real bare Cline Agent with no tools, one iteration, a cheap model, and a token cap through mock fetch', async () => {
    const f = await fixture({ 'notes.md': '# Evidence' }); f.config.llm.summarizer_model = 'mock-cheap';
    const mock = createMockLlm(request => {
      const message = request.messages.filter(message => message.role === 'user').at(-1)?.content;
      const raw = typeof message === 'string' ? message : Array.isArray(message) ? message.map(part => part.text ?? '').join('') : '';
      const items = JSON.parse(raw) as SummaryInput[];
      return { text: JSON.stringify(Object.fromEntries(items.map(item => [item.key, 'Mock factual summary.']))) };
    });
    const provider = createSummaryProvider({ fetch: mock.fetch, authResolver: async config => ({ providerId: 'openai-compatible', modelId: config.llm.summarizer_model, apiKey: 'mock-only', baseUrl: 'http://mock.invalid/v1' }) });
    const result = await summarizeFiles(f.root, ['notes.md'], f.config, { provider });
    expect(result.summaries['notes.md']).toBe('Mock factual summary.');
    expect(mock.requests).toHaveLength(2);
    for (const request of mock.requests) {
      expect(request.model).toBe('mock-cheap'); expect(request.tools ?? []).toEqual([]);
      expect(request.max_tokens ?? request.max_completion_tokens).toBe(2048);
    }
    expect(result.usage.inputTokens).toBe(20); expect(result.usage.outputTokens).toBe(10);
  });
});

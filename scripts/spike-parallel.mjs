// One cheap S4 fast search only. Never use this script for research or FindAll.
import dotenv from 'dotenv';
import Parallel from 'parallel-web';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
const report = { spike: 'S4', mode: 'fast', keyPresent: Boolean(process.env.PARALLEL_API_KEY), timeoutMs: 15_000 };

if (!report.keyPresent) {
  console.log(JSON.stringify({ ...report, ok: false, error: { type: 'MissingApiKey' } }, null, 2));
  process.exitCode = 1;
} else {
  try {
    const client = new Parallel({ apiKey: process.env.PARALLEL_API_KEY, timeout: 15_000, maxRetries: 0 });
    const result = await client.search({
      mode: 'fast',
      search_queries: ['Parallel Web Systems search API'],
      objective: 'Find the official Parallel Search API documentation.',
      max_chars_total: 1000,
      advanced_settings: { max_results: 1 },
    }, { signal: AbortSignal.timeout(15_000), maxRetries: 0 });
    const first = result.results?.[0];
    console.log(JSON.stringify({
      ...report, ok: true,
      shape: {
        keys: Object.keys(result).sort(),
        search_id: typeof result.search_id,
        session_id: typeof result.session_id,
        resultCount: Array.isArray(result.results) ? result.results.length : null,
        resultKeys: first ? Object.keys(first).sort() : [],
        url: typeof first?.url,
        title: typeof first?.title,
        excerpts: Array.isArray(first?.excerpts) ? 'array' : typeof first?.excerpts,
        excerptItem: typeof first?.excerpts?.[0],
        usage: Array.isArray(result.usage) ? 'array' : typeof result.usage,
      },
    }, null, 2));
  } catch (error) {
    // Error messages/bodies can echo request data or credentials: log only bounded metadata.
    console.log(JSON.stringify({ ...report, ok: false, error: {
      type: typeof error?.name === 'string' ? error.name : 'Error',
      ...(typeof error?.status === 'number' ? { status: error.status } : {}),
      ...(typeof error?.cause?.code === 'string' && /^[A-Z_]+$/.test(error.cause.code) ? { code: error.cause.code } : {}),
    } }, null, 2));
    process.exitCode = 1;
  }
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/spike-cline.mjs', import.meta.url));

describe('pinned ClineCore integration', () => {
  it('injects rules through fallback, removes shell tools, and blocks a real built-in editor call without network', async () => {
    const { stdout } = await execFileAsync(process.execPath, [script], {
      timeout: 25_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env },
    });
    const report = JSON.parse(stdout);
    expect(report.s2.finishReason).toBe('completed');
    expect(report.s2.rulesInjected).toBe(false);
    expect(report.s2.hookCalls).toBe(1);
    expect(report.s2.blockedFileAbsent).toBe(true);
    expect(report.s2.skipReasonReturnedToModel).toBe(true);
    expect(report.s2.shellRemoved).toBe(false);
    expect(report.s2.configOnlyShellRemoved).toBe(true);
    expect(report.s2.corrected).toEqual({
      finishReason: 'completed',
      rulesInSystemPrompt: true,
      shellRemoved: true,
      webFetchRemoved: true,
      hookCalls: 1,
      blockedFileAbsent: true,
      skipReasonReturnedToModel: true,
    });
  }, 30_000);
});

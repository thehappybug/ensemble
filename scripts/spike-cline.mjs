import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMockLlm } from '../test/mock-llm.ts';

// Optional path permits checking a pre-existing pinned installation before pnpm install.
const sdkSpecifier = process.env.ENSEMBLE_SDK_PATH ? pathToFileURL(process.env.ENSEMBLE_SDK_PATH).href : '@cline/sdk';
const originalProviders = path.join(process.env.CLINE_DATA_DIR ?? path.join(homedir(), '.cline', 'data'), 'settings', 'providers.json');
const isolated = await mkdtemp(path.join(tmpdir(), 'ensemble-cline-spike-'));
process.env.CLINE_DIR = path.join(isolated, 'cline');
process.env.CLINE_DATA_DIR = path.join(isolated, 'cline', 'data');
await mkdir(process.env.CLINE_DATA_DIR, { recursive: true });
const { ClineCore, ProviderSettingsManager, Llms } = await import(sdkSpecifier);

const report = { isolated, s1: {}, s2: {} };
let stored;
try {
  // The manager constructor may migrate settings and chmod its file: copy first.
  const copy = path.join(isolated, 'auth-copy', 'settings', 'providers.json');
  await mkdir(path.dirname(copy), { recursive: true });
  await writeFile(copy, await readFile(originalProviders), { mode: 0o600 });
  const manager = new ProviderSettingsManager({ filePath: copy, dataDir: path.join(isolated, 'auth-copy') });
  const settings = manager.getProviderSettings('cline');
  stored = manager.getProviderConfig('cline');
  report.s1 = {
    storedConfigPresent: Boolean(stored),
    accessTokenPresent: Boolean(stored?.auth?.accessToken),
    refreshTokenPresent: Boolean(stored?.auth?.refreshToken),
    apiKeyPresent: Boolean(stored?.apiKey ?? stored?.auth?.apiKey),
    storedOAuthAccessTokenPresent: Boolean(settings?.auth?.accessToken),
    storedOAuthRefreshTokenPresent: Boolean(settings?.auth?.refreshToken),
    storedModel: stored?.modelId ?? stored?.model,
    realRun: 'not attempted; use --real for one isolated, bounded iteration',
  };
} catch (error) {
  report.s1 = { storedConfigPresent: false, readError: error.code ?? error.name };
}
try {
  report.s1.modelIds = Object.keys(await Llms.getModelsForProvider('cline'));
} catch (error) {
  report.s1.modelCatalogError = error.code ?? error.name;
}

const marker = 'ENSEMBLE_CONFIG_RULES_SPIKE_MARKER';
const blockedFile = path.join(isolated, 'must-not-exist.txt');
let hookCalls = 0;
const mock = createMockLlm((request, index) => index === 0 ? {
  toolCalls: [{ name: 'editor', args: { path: blockedFile, new_text: 'guard failure' } }],
} : { text: 'Guard checked.' });
const core = await ClineCore.create({ clientName: 'ensemble-spike', backendMode: 'local', fetch: mock.fetch });
const config = {
  providerId: 'openai-compatible', modelId: 'mock-model', apiKey: 'mock-only', baseUrl: 'http://mock.invalid/v1',
  cwd: isolated, workspaceRoot: isolated, systemPrompt: 'You are an isolated test agent.',
  rules: marker, enableTools: true, enableSpawnAgent: false, enableAgentTeams: false,
  disableMcpSettingsTools: true, maxIterations: 3,
  toolPolicies: { run_commands: { enabled: false }, fetch_web_content: { enabled: false } },
  hooks: { beforeTool: ({ tool }) => {
    if (tool.name === 'editor' || tool.name === 'apply_patch') {
      hookCalls++;
      return { skip: true, reason: 'ENSEMBLE_BLOCKED_WRITE' };
    }
  } },
};
try {
  const session = await core.start({ prompt: 'Try the scripted write.', interactive: false, config,
    toolPolicies: { '*': { autoApprove: true } }, localRuntime: { configExtensions: [] } });
  const systemText = JSON.stringify(mock.requests[0]?.messages.filter(message => message.role === 'system'));
  const toolNames = mock.requests[0]?.tools?.map(tool => tool.function.name) ?? [];
  const fileExists = await stat(blockedFile).then(() => true, () => false);
  report.s2 = { finishReason: session.result?.finishReason, rulesInjected: systemText.includes(marker),
    shellRemoved: !toolNames.includes('run_commands'), webFetchRemoved: !toolNames.includes('fetch_web_content'),
    editorExposed: toolNames.includes('editor'), hookCalls, blockedFileAbsent: !fileExists,
    skipReasonReturnedToModel: JSON.stringify(mock.requests.at(-1)?.messages).includes('ENSEMBLE_BLOCKED_WRITE') };
  report.s2.initialToolResult = mock.requests.at(-1)?.messages.filter(message => message.role === 'tool').map(message => message.content);
  assert.equal(report.s2.finishReason, 'completed');
  // Rules injection is the subject of this spike: a false result selects SPEC's
  // systemPrompt fallback rather than preventing the remaining safety checks.
  report.s2.rulesFallback = report.s2.rulesInjected ? 'not needed' : 'prepend AGENTS.md chain to systemPrompt';
  await rm(blockedFile, { force: true });
  hookCalls = 0;
  mock.requests.length = 0;
  const corrected = await core.start({ prompt: 'Try the scripted write with corrected wiring.', interactive: false,
    config: { ...config, systemPrompt: `${config.systemPrompt}\n\n${marker}` },
    toolPolicies: { '*': { autoApprove: true }, run_commands: { enabled: false }, fetch_web_content: { enabled: false } },
    localRuntime: { configExtensions: [], hooks: config.hooks } });
  const correctedTools = mock.requests[0]?.tools?.map(tool => tool.function.name) ?? [];
  report.s2.corrected = {
    finishReason: corrected.result?.finishReason,
    rulesInSystemPrompt: JSON.stringify(mock.requests[0]?.messages).includes(marker),
    shellRemoved: !correctedTools.includes('run_commands'),
    webFetchRemoved: !correctedTools.includes('fetch_web_content'), hookCalls,
    blockedFileAbsent: !await stat(blockedFile).then(() => true, () => false),
    skipReasonReturnedToModel: JSON.stringify(mock.requests.at(-1)?.messages).includes('ENSEMBLE_BLOCKED_WRITE'),
  };
  assert.equal(report.s2.corrected.finishReason, 'completed');
  assert.equal(report.s2.corrected.rulesInSystemPrompt, true);
  assert.equal(report.s2.corrected.shellRemoved, true);
  assert.equal(report.s2.corrected.hookCalls, 1);
  assert.equal(report.s2.corrected.blockedFileAbsent, true);
  assert.equal(report.s2.corrected.skipReasonReturnedToModel, true);
  mock.requests.length = 0;
  await core.start({ prompt: 'Check config policies without top-level override.', interactive: false,
    config, localRuntime: { configExtensions: [], hooks: config.hooks } });
  report.s2.configOnlyShellRemoved = !mock.requests[0]?.tools?.some(tool => tool.function.name === 'run_commands');
  assert.equal(report.s2.configOnlyShellRemoved, true);
} finally {
  await core.dispose('spike complete');
}

if (process.argv.includes('--real') && stored) {
  const realCore = await ClineCore.create({ clientName: 'ensemble-auth-spike', backendMode: 'local' });
  const sessionId = `spike-auth-${Date.now()}`;
  const timer = setTimeout(() => void realCore.abort(sessionId, '25 second smoke deadline'), 25_000);
  try {
    // All runtime state and any refresh persistence remain in the isolated copy.
    const session = await realCore.start({ prompt: 'Reply OK.', interactive: false,
      config: { ...stored, providerId: 'cline', modelId: stored.modelId ?? stored.model ?? report.s1.modelIds[0],
        sessionId, cwd: isolated, workspaceRoot: isolated, systemPrompt: 'Reply with OK.', maxIterations: 1,
        maxTokensPerTurn: 8, enableTools: false, enableSpawnAgent: false, enableAgentTeams: false,
        disableMcpSettingsTools: true }, localRuntime: { configExtensions: [] } });
    report.s1.realRun = session.result?.finishReason ?? 'no result';
  } catch (error) {
    report.s1.realRun = `failed (${error.code ?? error.name})`;
  } finally {
    clearTimeout(timer);
    await realCore.dispose('smoke complete');
  }
}
console.log(JSON.stringify(report, null, 2));

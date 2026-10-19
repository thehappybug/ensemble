# Cline SDK: research findings (for building a TypeScript/Node app)

Researched 2026-10-19. Sources:
- Docs: https://docs.cline.bot/sdk/overview plus every SDK page listed in https://docs.cline.bot/llms.txt. Raw markdown copies are in `scratchpad/clinedocs/`.
- Skill repo: https://github.com/cline/sdk-skill, cloned to `scratchpad/sdk-skill/skill/cline-sdk/` (SKILL.md and references/*).
- Examples: https://github.com/cline/cline/tree/main/apps/examples (quickstart, cline-core-cli-agent, multi-agent). Copies are in `scratchpad/examples/`.
- The installed npm packages (`scratchpad/sdkpkg/node_modules/@cline/*`, v0.0.95). I checked the type definitions and the compiled JS directly.
- The local `cline` CLI 3.0.73.

**Verification legend.** VERIFIED means I ran or typechecked it locally against @cline/sdk 0.0.95 on Node v24.14.0. None of these runs called a real LLM: I used a local mock OpenAI-compatible server, with the SDK and CLI data dirs isolated in the scratchpad. DOCS means it comes from docs or the skill and I did not run it. UNCERTAIN means it is flagged.

---

## 0. TL;DR for the implementing agent

1. Install with `npm i @cline/sdk zod`. You need Node 22 or later (this machine has v24.14.0). The package is ESM-only, so set `"type": "module"`.
2. For coding tasks in a directory, use **`ClineCore`** with **`backendMode: "local"`**. It gives you the built-in file, shell and search tools, `cwd` handling, persistence and approvals. `Agent` is the bare loop: it has no built-ins unless you add `createBuiltinTools()`.
3. `cline.start({...})` **awaits the entire run** in local mode and returns `result` (`text`, `finishReason`, `toolCalls`, `usage`). To cancel, pick your own `config.sessionId` up front and call `cline.abort(sessionId)` from a timer. VERIFIED.
4. Custom tools: `createTool({name, description, inputSchema: zod|JSONSchema, execute})`, then pass them in `config.extraTools`. You must cast with `as AgentTool[]` for TypeScript. VERIFIED.
5. Auto-approve: `toolPolicies: { "*": { autoApprove: true } }` (top-level start input). An unlisted tool also defaults to auto-approved. VERIFIED.
6. Concurrency: one `ClineCore` instance can run many `start()` calls in parallel through `Promise.all`. Filter events per session with `subscribe(fn, { sessionId })`. VERIFIED.
7. AGENTS.md and `.clinerules/` in `cwd` are auto-injected into the system prompt by default. Global rules from `~/.cline/rules`, `~/.agents/AGENTS.md` and `~/Documents/Cline/Rules` are injected too. Turn this off with `localRuntime: { configExtensions: [] }`. VERIFIED.
8. The `systemPrompt` you pass is used **verbatim**: Cline's coding prompt is NOT added for you. Use `getClineDefaultSystemPrompt({...})` if you want Cline's stock behavior. VERIFIED.
9. TypeScript: use `"moduleResolution": "Bundler"`. `NodeNext` breaks, because the SDK's `.d.ts` files use extensionless imports and every type collapses to `any`. VERIFIED.
10. CLI fallback: `cline --json -c <dir> --auto-approve true -t <secs> "<prompt>"`. The last JSON line `{"type":"run_result",...,"text":...}` holds the answer. Exit code is 0 on success and 1 on error. VERIFIED.

---

## 1. Packages and versions (npm, checked 2026-10-19)

| Package | Latest | dist-tags | Purpose |
|---|---|---|---|
| `@cline/sdk` | **0.0.95** | latest 0.0.95, nightly 0.0.95-nightly.1792376935 | User-facing alias; `export * from "@cline/core"` |
| `@cline/core` | 0.0.95 | same | Node runtime: `ClineCore`, sessions, built-in tools, MCP, hub, plugins, automation |
| `@cline/agents` | 0.0.95 | same | Browser-compatible `AgentRuntime` loop |
| `@cline/llms` | 0.0.95 | same | Provider gateway and model catalog (re-exported as the `Llms` namespace) |
| `@cline/shared` | 0.0.95 | same | Types, `createTool`, hooks, storage paths |
| `cline` (CLI) | 3.0.73 | nightly 3.0.73-nightly.1792412563 | Depends on `@cline/sdk` 0.0.95 (same core as the SDK) |

- `engines.node: ">=22"` on all of them. They are `"type": "module"` with ESM `exports` only (no CJS).
- `@cline/core` dependencies include `@modelcontextprotocol/sdk ^1.29`, `zod ^4.3.6`, OpenTelemetry, `simple-git`, `ws` and `jiti`.
- Versioning is 0.0.x and moves fast (nightlies are published daily), so **pin exactly**: `"@cline/sdk": "0.0.95"`.
- Install:
  ```bash
  npm install @cline/sdk@0.0.95 zod
  npm install -D typescript @types/node   # optional
  ```
- `@cline/sdk` **does export**: `ClineCore`, `Agent`, `createAgentRuntime`, `createTool`, `createBuiltinTools`, `createMcpTools`, `InMemoryMcpManager`, `createDefaultMcpServerClientFactory`, `getClineDefaultSystemPrompt`, `resolveRulesConfigSearchPaths`, `Llms`, and roughly 677 other symbols. VERIFIED.
- **Doc discrepancy:** https://docs.cline.bot/sdk/reference/agent says `AgentRuntime` and `createAgent` can be imported from `@cline/sdk`. They cannot (both are `undefined`). Import them from `@cline/agents` if you need them. VERIFIED.

### tsconfig that works (VERIFIED)
```json
{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
  "strict": true, "skipLibCheck": true, "types": ["node"] } }
```
For running, use `tsx`, `bun`, or Node 24 type stripping (`node file.ts`). Plain `.mjs` with `node` also works (VERIFIED).

---

## 2. Two API surfaces

| | `ClineCore` (`@cline/core`) | `Agent` (= `AgentRuntime`, `@cline/agents`) |
|---|---|---|
| Built-in tools (`read_files`, `editor`/`apply_patch`, `run_commands`, `search_codebase`, `fetch_web_content`, `skills`, `ask_question`, `submit_and_exit`) | yes, with `enableTools: true` | no, unless you add `createBuiltinTools({cwd})` yourself |
| `cwd` / workspace | `config.cwd` / `config.workspaceRoot` | only through the tools you create |
| Persistence | SQLite plus JSON under `~/.cline/data` (or `CLINE_DATA_DIR`) | in-memory only (`snapshot()`/`restore()`) |
| Rules/AGENTS.md/skills/hooks/plugins discovery | yes (on by default) | no |
| MCP from settings file | yes | manual (`createMcpTools`) |
| Events | `cline.subscribe()` gives `CoreSessionEvent`; text comes as `agent_event` / `content_start` | `agent.subscribe()` gives `AgentRuntimeEvent`; text comes as `assistant-text-delta` |
| Result text | `result.text`, `result.finishReason` | `result.outputText`, `result.status` |

Source: https://docs.cline.bot/sdk/clinecore and `sdk-skill/.../SKILL.md` ("Critical Rules" 1-9).

---

## 3. Minimal working examples

### 3a. ClineCore: run a prompt in a specific directory (docs snippet)
Source: https://docs.cline.bot/sdk/clinecore (verbatim):
```typescript
import { ClineCore } from "@cline/sdk"

const cline = await ClineCore.create({
  clientName: "my-app",
  backendMode: "auto",
})

const session = await cline.start({
  prompt: "Set up GitHub Actions for this repo",
  config: {
    providerId: "anthropic",
    modelId: "claude-sonnet-4-6",
    apiKey: process.env.ANTHROPIC_API_KEY,
    systemPrompt: "You are a helpful coding assistant.",
    cwd: "/path/to/project",
    workspaceRoot: "/path/to/project",
    enableTools: true,
    enableSpawnAgent: false,
    enableAgentTeams: false,
  },
})

console.log(session.sessionId)
console.log(session.result?.finishReason)
```
- **Use `backendMode: "local"`, not `"auto"`.** A Cline hub daemon IS running on this machine (`cline hub status`, which returns `ws://127.0.0.1:25463/hub`, cliVersion 3.0.73). With `"auto"`, the SDK attaches to that shared hub. In hub mode, `extraTools`/`hooks` are proxied back to your process over WebSocket. I could not confirm that inline `extensions` objects get proxied (UNCERTAIN). Sessions also land in the user's global hub state.
- Required config fields (TypeScript): `providerId`, `modelId`, `systemPrompt`, `enableTools`, `enableSpawnAgent`, `enableAgentTeams`. `cwd` is optional on start: if you omit it, the host assigns a shared "chat workspace". Always pass it.

### 3b. Production-style runner (VERIFIED typecheck; the same pattern ran against a mock LLM)
File: `scratchpad/sdkpkg/src/final.ts`. It shares one ClineCore, supports concurrent tasks, custom tools, streaming, timeout/abort and auto-approve.
```typescript
// agent-runner.ts — run Cline agent tasks in specific working dirs (ESM, Node >= 22)
import {
  ClineCore,
  createTool,
  getClineDefaultSystemPrompt,
  type AgentEvent,
  type AgentTool,
} from "@cline/sdk"
import { z } from "zod"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

const execFileAsync = promisify(execFile)

// One ClineCore per process; many sessions can run on it concurrently.
let corePromise: Promise<ClineCore> | undefined
function getCore(): Promise<ClineCore> {
  corePromise ??= ClineCore.create({ clientName: "my-app", backendMode: "local" })
  return corePromise
}

function makeTools(workDir: string): AgentTool[] {
  const root = path.resolve(workDir)
  const writeProjectFile = createTool({
    name: "write_project_file",
    description: "Create or overwrite a UTF-8 text file inside the project. Path is relative to the project root.",
    inputSchema: z.object({
      relPath: z.string().describe("Path relative to project root, e.g. src/index.ts"),
      content: z.string().describe("Full file content"),
    }),
    async execute(input) {
      const abs = path.resolve(root, input.relPath)
      if (!abs.startsWith(root + path.sep)) return { error: "path escapes project root" }
      await mkdir(path.dirname(abs), { recursive: true })
      await writeFile(abs, input.content, "utf8")
      return { ok: true, path: abs }
    },
  })
  const runMyCli = createTool({
    name: "run_my_cli",
    description: "Run `my-cli` with the given arguments in the project dir. Returns exitCode, stdout, stderr.",
    inputSchema: z.object({ args: z.array(z.string()).describe("argv for my-cli") }),
    timeoutMs: 120_000, // metadata; enforce the deadline yourself (below)
    async execute(input, context) {
      try {
        const { stdout, stderr } = await execFileAsync("my-cli", input.args, {
          cwd: root, timeout: 120_000, signal: context.signal, maxBuffer: 10 * 1024 * 1024,
        })
        return { exitCode: 0, stdout, stderr }
      } catch (err: any) {
        // return errors as data so the model can recover
        return { exitCode: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(err) }
      }
    },
  })
  // extraTools is typed AgentTool[] (= AgentTool<unknown, unknown>) -> cast typed tools
  return [writeProjectFile, runMyCli] as AgentTool[]
}

export interface RunResult {
  sessionId: string
  finishReason?: string // "completed" | "max_iterations" | "aborted" | "mistake_limit" | "error"
  text: string
  toolCalls: string[]
  usage?: unknown
}

export async function runTask(
  prompt: string,
  workDir: string,
  opts: { timeoutMs?: number; onText?: (t: string) => void; onTool?: (name: string, input: unknown) => void } = {},
): Promise<RunResult> {
  const cline = await getCore()
  // start() resolves only after the whole run (local mode), so choose the id up front
  const sessionId = `task-${randomUUID()}`
  let streamed = ""
  const unsubscribe = cline.subscribe((event) => {
    if (event.type !== "agent_event") return
    const e: AgentEvent = event.payload.event
    if (e.type === "content_start" && e.contentType === "text" && e.text) {
      streamed += e.text
      opts.onText?.(e.text)
    } else if (e.type === "content_start" && e.contentType === "tool" && e.toolName) {
      opts.onTool?.(e.toolName, e.input)
    }
  }, { sessionId })

  const timer = setTimeout(() => void cline.abort(sessionId, "timeout"), opts.timeoutMs ?? 15 * 60_000)
  try {
    const session = await cline.start({
      prompt,
      interactive: false,
      config: {
        sessionId,
        providerId: "anthropic",
        modelId: "claude-sonnet-4-6",
        apiKey: process.env.ANTHROPIC_API_KEY,
        cwd: workDir,
        workspaceRoot: workDir,
        // Cline's stock coding-agent prompt (systemPrompt is required)
        systemPrompt: getClineDefaultSystemPrompt({
          rootPath: workDir, cwd: workDir, platform: process.platform, mode: "act", ide: "Terminal Shell",
        }),
        mode: "act",
        maxIterations: 60,
        enableTools: true,        // built-ins: read_files, editor/apply_patch, run_commands, search_codebase, ...
        enableSpawnAgent: false,
        enableAgentTeams: false,
        disableMcpSettingsTools: true, // don't pull in ~/.cline MCP servers unless you want them
        extraTools: makeTools(workDir),
      },
      toolPolicies: { "*": { autoApprove: true } }, // headless: approve everything
      // localRuntime: { configExtensions: [] },     // uncomment to NOT load AGENTS.md/.clinerules/skills/hooks/plugins
    })
    return {
      sessionId: session.sessionId,
      finishReason: session.result?.finishReason,
      text: session.result?.text ?? streamed,
      toolCalls: session.result?.toolCalls.map((c) => c.name) ?? [],
      usage: session.result?.usage,
    }
  } finally {
    clearTimeout(timer)
    unsubscribe()
  }
}

export async function shutdown() {
  if (corePromise) await (await corePromise).dispose("shutdown")
}

// Usage: concurrent tasks in different dirs
// const [a, b] = await Promise.all([runTask("Add tests", "/repo/a"), runTask("Fix lint", "/repo/b")])
// await shutdown()
```

What I verified at runtime with a mock OpenAI-compatible server (`scratchpad/sdkpkg/probe7.mjs` and `probe8`, `probe9`, `probe10`):
- Two concurrent `start()` calls on one `ClineCore` ran in parallel (both finished in about 0.47 s total). Each `extraTools` tool wrote into its own `cwd`. `result.finishReason === "completed"`, `result.text` was the final assistant text, and `result.toolCalls[].name` was populated.
- Custom `config.sessionId` is honored, so `abort(sessionId)` works while `start()` is still pending. `start()` then resolves (it does not throw) with `finishReason: "aborted"` and `text: ""`. `cline.get(id).status === "cancelled"`.
- With `enableTools: true`, the built-in `run_commands` ran `pwd` in `config.cwd`. Its input shape is `{ commands: string[] }`.
- When the provider returns 401, `start()` does **not throw**. It returns `finishReason: "error"` with `result.text` set to the error message ("bad key"). Treat `finishReason !== "completed"` as failure.
- Multi-turn needs `interactive: true` on `start()`. After that, `await cline.send({ sessionId, prompt })` returns the `AgentResult`. If you call `send()` after a **non-interactive** start, it throws `session not found: <id>`, because the session is finalized when the single run ends.

### 3c. Direct `Agent`: lightweight, custom tools only (docs)
Source: https://docs.cline.bot/sdk/overview (verbatim):
```typescript
import { Agent } from "@cline/sdk"

const agent = new Agent({
  providerId: "anthropic",
  modelId: "claude-sonnet-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxIterations: 1,
})

agent.subscribe((event) => {
  if (event.type === "assistant-text-delta") {
    process.stdout.write(event.text ?? "")
  }
})

const result = await agent.run("Explain what an SDK is in two sentences.")
```
`Agent` with built-in tools bound to a directory (from https://docs.cline.bot/sdk/guides/permission-handling):
```typescript
import { Agent, createBuiltinTools } from "@cline/sdk"

const agent = new Agent({
  // ...config
  tools: createBuiltinTools({ cwd: process.cwd() }),
  toolPolicies: {
    read_files: { autoApprove: true },       // Always run without asking
    search_codebase: { autoApprove: true },  // Always run without asking
    editor: { autoApprove: false },          // Always ask before running
    run_commands: { autoApprove: false },    // Always ask before running
  },
})
```
- `createBuiltinTools` options (from types): `cwd`, `enableReadFiles`, `enableSearch`, `enableBash`, `enableWebFetch`, `enableApplyPatch`, `enableEditor`, `enableSkills`, `enableAskQuestion`, `enableSubmitAndExit`, `shell`, `fileReadTimeoutMs`, `bashTimeoutMs`, `webFetchTimeoutMs`, `executorOptions`, `executors`.
- `AgentRuntimeConfig` fields (from types): `providerId`/`modelId`/`apiKey`/`baseUrl`/`headers` OR `model`, plus `systemPrompt`, `modelOptions`, `tools`, `hooks`, `plugins`, `initialMessages`, `maxIterations`, `completionPolicy {requireCompletionTool, completionGuard}`, `toolExecution: "sequential"|"parallel"`, `toolPolicies`, `requestToolApproval`, `logger`, `telemetry`, and the ids.
  - `maxTokensPerTurn` is **not** an Agent field. The going-to-production doc shows it there, which is wrong. It is a `ClineCore` session config field (`CoreModelConfig.maxTokensPerTurn`). For Agent use `modelOptions: { maxTokens }` (sdk-skill production ref; I did not verify that it takes effect).
- Result: `{ status: "completed"|"aborted"|"failed", outputText, iterations, usage{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalCost?}, messages, error? }`.
- `run()` and `continue()` both act on the in-memory history. There is no `hasRun`. Use `restore(messages)` to reset.
- Parallelism: create one `Agent` per task and run `Promise.all(roles.map(r => new Agent(cfg).run(...)))`. This is the official multi-agent example (`apps/examples/multi-agent/src/index.ts`).

---

## 4. Custom tools

Source: https://docs.cline.bot/sdk/guides/creating-custom-tools and https://docs.cline.bot/sdk/reference/tools-api
```typescript
import { createTool } from "@cline/sdk"
import { z } from "zod"

const getCurrentTime = createTool({
  name: "get_current_time",
  description: "Get the current date and time. Optionally specify a timezone.",
  inputSchema: z.object({
    timezone: z.string().optional().describe("IANA timezone (e.g., 'America/New_York'). Defaults to UTC."),
  }),
  async execute(input) {
    const tz = input.timezone ?? "UTC"
    const date = new Date()
    return {
      iso: date.toISOString(),
      timezone: tz,
      formatted: date.toLocaleString("en-US", { timeZone: tz }),
    }
  },
})
```
- `inputSchema` accepts zod (v4 works: zod 4.6.7 was installed and typechecks) or raw JSON Schema.
- `execute(input, context)` receives a context. Per the types it has `agentId`, `conversationId`, `runId`, `iteration`, `toolCallId`, `signal` (AbortSignal), `metadata`, `snapshot`, `emitUpdate(update)`, and for plugin tools `cwd` and `emitEvent`.
  - The tools-api reference page calls the signal `abortSignal`. The skill and the actual runtime use `context.signal`, which typechecked.
- Options: `timeoutMs` (default 30000), `retryable` (default true) and `maxRetries` (default 3). These are **metadata only for custom tools**: "The direct Agent runtime does not currently apply a generic timeout or automatic retry wrapper around custom execute functions" (sdk-skill tools/REFERENCE.md). Enforce timeouts yourself.
- Use `lifecycle: { completesRun: true }` to make a tool end the run (submit pattern). In ClineCore, the structured input appears in `result.toolCalls`.
- Errors: returning `{ error: ... }` (or `{ output: {...}, isError: true }` per the docs) lets the model recover. A thrown error becomes an error tool result and counts toward the consecutive-mistake limit, which ends the session with `finishReason: "mistake_limit"`.
- Naming: snake_case, unique.
- Registration:
  - ClineCore: `config.extraTools: [...] as AgentTool[]`. VERIFIED that the cast is needed: without it you get `TS2322 ... not assignable to AgentTool<unknown, unknown>`.
  - Agent: `tools: [...]` (typed `AgentTool<any,any>[]`, no cast needed).
  - Plugin: `api.registerTool(tool)` with the `"tools"` capability.
- Tool streaming: call `context.emitUpdate?.(x)` inside the tool. Agent subscribers get a `tool-updated` event; ClineCore subscribers get `agent_event` / `content_update`.

---

## 5. MCP servers

Three ways to attach them:

**(a) Settings file, ClineCore with `enableTools: true` (automatic).** File: `~/.cline/data/settings/cline_mcp_settings.json`. Override it with the `CLINE_MCP_SETTINGS_PATH` env var (or move all data with `CLINE_DATA_DIR`). The core bundle loads these servers when `enableTools && !disableMcpSettingsTools` (read from the compiled code).
Format, from https://docs.cline.bot/mcp/mcp-overview:
```json
{
  "mcpServers": {
    "local-server": {
      "command": "node",
      "args": ["/path/to/server.js"],
      "env": { "API_KEY": "your_api_key" },
      "disabled": false,
      "autoApprove": []
    },
    "remote-server": {
      "type": "streamableHttp",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer your-token" },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```
If you omit `type` on a URL server, it defaults to legacy `sse`. Set `"streamableHttp"` explicitly. A per-server `timeout` (in seconds) is also supported.
CLI helper: `cline mcp add files --yes -- npx -y @modelcontextprotocol/server-filesystem .` or `cline mcp add docs https://x/mcp --transport http --header "Authorization: Bearer T" --yes`.

**(b) Inline per session through a plugin (`extensions`).** Source: sdk-skill plugins/REFERENCE.md:
```typescript
const plugin: AgentPlugin = {
  name: "github-mcp",
  manifest: { capabilities: ["mcp"] },
  setup(api) {
    api.registerMcpServer({
      name: "github",
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
      },
      env: {
        // Resolve from the host process env; skip the server if unset.
        GITHUB_TOKEN: { fromEnv: "GITHUB_TOKEN", required: true },
      },
    })
  },
}
// then: cline.start({ config: { ..., extensions: [plugin] } })
```
- Transports: `{type:"stdio", command, args?, cwd?, env?}`, `{type:"sse", url, headers?}`, `{type:"streamableHttp", url, headers?}`.
- This typechecked (`scratchpad/sdkpkg/src/plugin-example.ts`), but I did not run it.
- UNCERTAIN: whether inline plugin MCP servers load when `enableTools: false`. The bundle passes `agentPluginMcpServers` only inside the `enableTools` branch, so keep `enableTools: true`.

**(c) Programmatic, for `Agent` or ClineCore `extraTools`.** Typechecked, not run:
```typescript
import { createMcpTools, InMemoryMcpManager, createDefaultMcpServerClientFactory } from "@cline/sdk"
const mcp = new InMemoryMcpManager({ clientFactory: createDefaultMcpServerClientFactory() })
await mcp.registerServer({
  name: "filesystem",
  transport: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", workDir] },
})
const mcpTools = await createMcpTools({ serverName: "filesystem", provider: mcp }) // AgentTool[]
// new Agent({ ..., tools: [...mcpTools] })  or  config.extraTools: mcpTools
// later: await mcp.dispose()
```
`createMcpTools` options also accept `nameTransform`, `timeoutMs`, `retryable` and `maxRetries`. UNCERTAIN: the default tool-name format, so check `mcpTools.map(t => t.name)`.

---

## 6. Events, streaming and the final result

### ClineCore: `cline.subscribe(listener, { sessionId? })`
This returns an unsubscribe function. The `CoreSessionEvent` union, from the skill's clinecore/api.md:
```typescript
type CoreSessionEvent =
  | { type: "chunk"; payload: SessionChunkEvent }          // raw transport; ignore
  | { type: "agent_event"; payload: { sessionId: string, event: AgentEvent, teamAgentId?: string, teamRole?: "lead" | "teammate" } }
  | { type: "ended"; payload: SessionEndedEvent }           // { sessionId, reason, ts }
  | { type: "team_progress"; payload: SessionTeamProgressEvent }
  | { type: "pending_prompts"; payload: SessionPendingPromptsEvent }
  | { type: "pending_prompt_submitted"; payload: SessionPendingPromptSubmittedEvent }
  | { type: "session_snapshot"; payload: SessionSnapshotEvent }
  | { type: "status"; payload: { sessionId: string, status: string } }
  | { type: "hook"; payload: SessionToolEvent }
```
Observed order for one tool-using run (VERIFIED):
`status, session_snapshot, agent_event:iteration_start, chunk, agent_event:usage, agent_event:content_start/tool, agent_event:content_end/tool, agent_event:iteration_end, agent_event:content_start/text, agent_event:content_end/text, agent_event:done, ended`

`AgentEvent` (inside `agent_event`). Field shapes come from the CLI's `--json` output (VERIFIED):
- `{type:"content_start", contentType:"text", text, accumulated}`: a **text delta**. Append `text`.
- `{type:"content_start", contentType:"tool", toolName, toolCallId, input}`
- `{type:"content_update", contentType:"tool", toolName, toolCallId, update}`: tool progress, for example run_commands stdout chunks.
- `{type:"content_end", contentType:"tool", toolName, toolCallId, output, error?, durationMs}`
- `content_start` / `content_end` also appear with contentType `"reasoning"` (DOCS).
- `{type:"iteration_start", iteration}`, `{type:"iteration_end", iteration, hadToolCalls, toolCallCount}`
- `{type:"usage", inputTokens, outputTokens, totalInputTokens, totalOutputTokens, totalCost, ...}`
- `{type:"notice", message}`, `{type:"error", error:{message,...}}`
- `{type:"done", reason:"completed"|"max_iterations"|"aborted"|"mistake_limit"|"error", text, iterations, usage}`

The final result is the return value of `start()` (or `send()`):
```typescript
interface AgentResult {
  text: string
  usage: LegacyAgentUsage
  messages: MessageWithMetadata[]
  toolCalls: ToolCallRecord[]   // { id, name, input, output, error?, durationMs, startedAt, endedAt }
  iterations: number
  finishReason: "completed" | "max_iterations" | "aborted" | "mistake_limit" | "error"
  model: { id: string; provider: string; info?: ModelInfo }
  startedAt: Date; endedAt: Date; durationMs: number
}
```
Other APIs: `cline.readMessages(id)`, `cline.getAccumulatedUsage(id)` (returns `{usage, aggregateUsage}`), `cline.list(n)`, `cline.get(id)`, `cline.delete(id)`.

### Agent: `agent.subscribe(listener)`
Register the listener before `run()`. Events are `run-started`, `run-finished {result}`, `run-failed {error}`, `turn-started`, `turn-finished {toolCallCount}`, `assistant-text-delta {text, accumulatedText}`, `assistant-reasoning-delta`, `assistant-message {message, finishReason}`, `message-added`, `tool-started {toolCall:{toolName,toolCallId,input}}`, `tool-updated`, `tool-finished`, `usage-updated {usage}` and `status-notice`. There is no `onEvent` config field. Use `hooks.onEvent` (awaited) instead.

---

## 7. Providers, models, auth and env vars

- Pass `providerId`, `modelId`, `apiKey` and optionally `baseUrl`, `headers` and `providerConfig`. This works on both `Agent` and the ClineCore `config`.
- Common ids: `anthropic`, `openai-native`, `openai-compatible`, `openrouter`, `gemini`, `vertex`, `bedrock`, `mistral`, `deepseek`, `xai`, `groq`, `ollama`, `lmstudio`, `litellm`, `cline`, `cline-pass`, and `claude-code` (Claude subscription through the Claude Code SDK). There are more than 200 in total; `Llms.getProviderIds()` lists them (VERIFIED).
- Model ids used in docs and examples:
  - Anthropic: `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5`. The anthropic catalog `defaultModelId` in 0.0.95 is `claude-sonnet-5` (another entry says `claude-haiku-5-5`), so newer ids exist. Check them with `await Llms.getModelsForProvider("anthropic")`.
  - Cline gateway: `providerId: "cline", modelId: "anthropic/claude-sonnet-4.6", apiKey: process.env.CLINE_API_KEY` (official quickstart).
- Env vars per the docs (https://docs.cline.bot/sdk/model-providers):

  | Provider | Env var(s) |
  |---|---|
  | Anthropic | `ANTHROPIC_API_KEY` |
  | OpenAI | `OPENAI_API_KEY` |
  | Google | `GOOGLE_API_KEY` or `GOOGLE_APPLICATION_CREDENTIALS` (catalog also lists `GEMINI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`) |
  | AWS Bedrock | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` (+ `AWS_REGION` or `providerConfig: { awsRegion }`; also `AWS_BEARER_TOKEN_BEDROCK`) |
  | Mistral | `MISTRAL_API_KEY` |
  | Cline | `CLINE_API_KEY` |
  | OpenRouter / DeepSeek / xAI / Groq | `OPENROUTER_API_KEY` / `DEEPSEEK_API_KEY` / `XAI_API_KEY` / `GROQ_API_KEY` |

  UNCERTAIN: whether the SDK reads these env vars automatically when you omit `apiKey`. The llms bundle has `apiKeyEnv` per provider and a resolver that falls back to `process.env`, but only behind an `includeEnvironment` flag I could not trace. **Always pass `apiKey: process.env.X` explicitly.**
- OpenAI-compatible endpoint: `{ providerId: "openai-compatible", modelId, apiKey, baseUrl: "https://host/v1" }`. VERIFIED: it calls `POST {baseUrl}/chat/completions` with `stream: true` and OpenAI `tools`.
- Reasoning: `thinking: true`, `reasoningEffort`, `thinkingBudgetTokens`, `maxTokensPerTurn` and `temperature` on the ClineCore config.
- ClineCore does not auto-pick a model: "ClineCore does not choose a model automatically; each session config must provide one" (apps/examples/cline-core-cli-agent).
- Provider errors are retried before failing. With a refused connection, the CLI took about 59 s before giving up (VERIFIED), so set your own timeout.

---

## 8. Permissions and auto-approve

- `ToolPolicy = { enabled?: boolean; autoApprove?: boolean }`. "Tool names not listed in `toolPolicies` default to enabled and auto-approved" (https://docs.cline.bot/sdk/tools).
- The wildcard `"*"` is supported: `toolPolicies: { "*": { autoApprove: false }, read_files: { autoApprove: true } }` (official cline-core-cli-agent example). `{ "*": { autoApprove: true } }` worked in my runs.
- There are three policy levels in ClineCore (sdk-skill clinecore/gotchas.md):
  - `ClineCore.create({ toolPolicies })`: global execution policy.
  - `cline.start({ toolPolicies })`: per-session approval and blocking.
  - `cline.start({ config: { toolPolicies } })`: here `{enabled:false}` removes the tool before the model sees it.
- Interactive approval:
  - `ClineCore.create({ capabilities: { requestToolApproval: async (req) => ({ approved, reason? }) } })`. `capabilities` is also accepted per `start()`.
  - `req` has `sessionId`, `agentId`, `toolName` and `input`.
  - If the callback never resolves, the session hangs, so put a timeout in it.
  - If no callback is configured and a tool needs approval, it is rejected ("Tool approval callback is not configured.", per the compiled code).
- Docs pattern for full auto-approve (https://docs.cline.bot/sdk/guides/permission-handling):
```typescript
const session = await cline.start({
  config: {
    enableTools: true,
  },
  toolPolicies: {
    run_commands: { autoApprove: true },
    editor: { autoApprove: true },
    read_files: { autoApprove: true },
    apply_patch: { autoApprove: true },
    search_codebase: { autoApprove: true },
    fetch_web_content: { autoApprove: true },
  },
  capabilities: {
    requestToolApproval: async () => ({ approved: true }),
  },
  // ...
})
```
- `mode: "act" | "plan" | "yolo" | "zen"`:
  - In `plan`, file-mutating shell commands are hard-blocked (from the default prompt text).
  - `yolo` drops the web_search model tool and the plan/act instructions.
  - There is also a `yolo?: boolean` config flag. UNCERTAIN what extra it does beyond policies.
- Hooks can block or require approval:
  - `beforeTool` returns `{ skip: true, reason }`, or `{ policy: { autoApprove: false } }`, or a replacement `input` (https://docs.cline.bot/sdk/plugins).
  - The skill's older example uses `{ stop: true, reason }`, which ends the whole run.

---

## 9. Cancel, timeout, limits

- ClineCore:
  - `await cline.abort(sessionId, reason)` aborts the in-flight run. `start()`/`send()` then resolve with `finishReason: "aborted"` (VERIFIED in about 70 ms).
  - `await cline.stop(sessionId)` ends the session.
  - `await cline.dispose(reason)` is required at shutdown, to release SQLite handles, watchers and MCP processes.
  - The session id must be known before `start()` resolves, so pass `config.sessionId` (any string worked, e.g. `task-<uuid>`). Alternatively, read `payload.sessionId` from the first subscribe event.
  - `send()` accepts `timeoutMs` (type field; its semantics are UNCERTAIN, probably queue wait).
- Agent: `agent.abort(reason)`, which makes `run()` resolve with `status: "aborted"` (DOCS):
```typescript
const timeout = setTimeout(() => agent.abort("Timeout"), 30_000)
try {
  const result = await agent.run(data)
  if (result.status === "aborted") { /* ... */ } else { console.log(result.outputText) }
} finally {
  clearTimeout(timeout)
}
```
- Budget guard (DOCS): in an `agent.subscribe`, on `usage-updated`, check `event.usage.totalCost` and call `abort()`.
- `maxIterations` caps the loop and gives `finishReason: "max_iterations"`.
- The consecutive-mistake limit gives `"mistake_limit"`. Override it with `config.onConsecutiveMistakeLimitReached`.
- Custom tools: honor `context.signal` and add your own deadline with `AbortSignal.any([context.signal, AbortSignal.timeout(ms)])`.

---

## 10. Concurrency

- **One `ClineCore` and many concurrent sessions.** VERIFIED with 2 parallel `start()` calls in different `cwd`s. Docs: "A single Node process may host multiple sessions concurrently" (sdk-skill plugins/REFERENCE.md).
  - Filter events with `subscribe(fn, { sessionId })` or by `event.payload.sessionId`.
  - Plugin module state is per-session by default, because plugins run in a worker thread per session (https://docs.cline.bot/sdk/plugins).
  - Your own module-level state in tools is shared, so key it by session or closure. My example builds tools per task through `makeTools(workDir)`.
- **Many `Agent` instances work in parallel.** The official multi-agent example uses `Promise.all`.
- Each session runs its own tool calls. Built-in tool descriptions encourage the model to batch parallel tool calls; for Agent, `toolExecution: "sequential"|"parallel"` controls this.
- Concurrent sessions in the **same** directory can still clobber each other's files. Use separate dirs or git worktrees (the CLI has `--worktree`).
- With `CLINE_DATA_DIR`, I verified that ClineCore writes its `db/sessions.db` there instead of `~/.cline/data`. This is useful for isolating your app from the user's Cline state.

---

## 11. AGENTS.md, .clinerules, skills, hooks and plugins discovery

VERIFIED from compiled code and a live mock run (`probe10.mjs`):
- ClineCore loads "config extensions" by default: `DEFAULT_RUNTIME_CONFIG_EXTENSIONS = ['rules','skills','workflows','plugins','hooks']`.
- Rules search paths, from `resolveRulesConfigSearchPaths("/work/proj")` in that order:
  ```
  /work/proj/AGENTS.md
  /work/proj/.clinerules            (dir of .md files)
  /work/proj/.cline/rules
  ~/.agents/AGENTS.md
  ~/.cline/rules
  ~/Cline/Rules
  ~/Documents/Cline/Rules
  ```
  Rules are resolved from `config.cwd`.
- Skills search paths: `<ws>/.clinerules/skills`, `<ws>/.cline/skills`, `<ws>/.claude/skills`, `<ws>/.agents/skills`, `~/.cline/skills`, `~/.agents/skills`. When skills exist, a `skills` tool is added (VERIFIED: it appeared in the tool list).
- How rules are injected: your `systemPrompt` + `"\n\n# Rules\n## <name>\n<content>..."`. With `cwd` containing `AGENTS.md` and `.clinerules/style.md`, both markers appeared in the system prompt. The prompt began `"CUSTOM_SYSTEM_PROMPT\n\n# Rules\n## style\n..."`.
- To turn off all discovery (rules, skills, workflows, plugins, hooks):
  ```typescript
  await cline.start({ ..., localRuntime: { configExtensions: [] } })
  ```
  Then the system prompt was exactly my `systemPrompt`. Use something like `["rules"]` to keep only some kinds. Also pass `disableMcpSettingsTools: true` to skip `cline_mcp_settings.json`.
- You can add text rules programmatically: `config.rules?: string` (SessionPromptConfig), or a plugin's `api.registerRule({id, content, source})` with the `"rules"` capability.
- Conditional rules use YAML frontmatter `paths:` globs (https://docs.cline.bot/customization/cline-rules). UNCERTAIN how these behave in a headless SDK session, where there are no "open tabs".
- Agent profiles: `.cline/agents/*.yml` become `subagent_<name>` tools when `enableSpawnAgent: true`.
- File hooks: `.cline/hooks/` and `~/.cline/hooks` (CLI `--hooks-dir`). The CLI emits `hook_event` lines (`agent_start`, `tool_call`, `tool_result`, `agent_end`).
- Plain `Agent` does none of this discovery.

---

## 12. Plugins and hooks (brief)

Source: https://docs.cline.bot/sdk/plugins and sdk-skill plugins/REFERENCE.md.
- `AgentPlugin = { name, manifest: { capabilities: [...] }, setup?(api, ctx), hooks? }`.
  - Capabilities: `tools`, `commands`, `rules`, `mcp`, `messageBuilders`, `providers`, `automationEvents`, `hooks`, `skills`.
  - Declare a matching capability for every `api.register*`, and add `"hooks"` if you define `hooks`.
- Hooks: `beforeRun`, `afterRun`, `beforeModel`, `afterModel`, `beforeTool`, `afterTool`, `onEvent`.
  - Each has a 3 s timeout.
  - `hookErrorMode: "ignore"` (the default) or `"throw"`.
- Pass plugins through `config.extensions: [plugin]` or `config.pluginPaths: ["/abs/plugin.ts" | dir]`. Select per session with `start({ plugins: { "*": {enabled:false}, "x": {enabled:true} } })`.
- Discovered plugin files run in worker threads:
  - Their `console.log` output is discarded; use `ctx.logger`.
  - Values crossing the thread boundary must be plain data.
  - Import timeout is 4 s, `setup()` timeout 4 s, tool timeout 60 s.
  - UNCERTAIN whether inline `extensions` objects also go to a worker. They contain functions, so they probably run in-process.
- `ClineCore` session config also accepts `hooks?: AgentHooks` directly.

---

## 13. CLI headless fallback (`cline` 3.0.73 at /home/mehdi/.nvm/versions/node/v24.14.0/bin/cline)

`cline --help` (verbatim, key flags):
```
Usage: cline [options] [command] [prompt]
  prompt                        Your prompt. Default to start in act mode with auto-approve enabled.
  -p, --plan                    Run in plan mode
  -y, --yolo                    Auto-approve a limited tool set for unsupervised runs (benchmarks, CI). DANGEROUS: use only in sandboxed environments.
  --json                        Output messages as JSON instead of styled text
  --auto-approve <boolean>      Set tool auto-approval for all tools (default: true)
  -c, --cwd <path>              Working directory
  --thinking <level>            none|low|medium|high|xhigh
  --compaction <mode>           agentic|basic|off (default: agentic)
  --id <session-id>             Resume an existing session by ID
  -P, --provider <id>           Provider id (default: cline)
  -k, --key <api-key>           API key for this run, also saved as the provider's key
  -m, --model <model-id>        Model to use for the session with the selected provider
  -s, --system <system-prompt>  Override the default system prompt
  --retries <count>             Number of maximum consecutive mistakes (retries) before exiting (default: 3)
  -t, --timeout <seconds>       Optional timeout in seconds (default: 0 for no timeout)
  --config <path>               Configuration directory (default: ~/.cline)
  --data-dir <path>             Use isolated local state at this directory path (default: ~/.cline/data)
  --hooks-dir <path>            Additional hooks dir
  --worktree                    Auto-create a detached git worktree under ~/.cline/worktrees/ and run the task there
  -v, --verbose
Commands: auth, config, plugin, skill, connect, mcp, doctor, history|h, hook, schedule, hub, update, version, kanban
```
- Headless mode activates with `--json`, piped stdin, or redirected stdout (https://docs.cline.bot/usage/cli-overview). Auto-approve defaults to **true** for prompt runs.
- Recommended invocation:
  ```bash
  cline --json -c /abs/project --auto-approve true -t 900 \
        -P anthropic -m claude-sonnet-4-6 "your task" > run.jsonl
  jq -r 'select(.type=="run_result") | .text' run.jsonl
  ```
- Auth for the CLI:
  - `cline auth -p anthropic -k "$ANTHROPIC_API_KEY" -m claude-sonnet-4-6` writes `~/.cline/data/settings/providers.json`.
  - Alternatively, `-P/-k/-m` per run. Note that `-k` also persists the key.
  - For OpenAI-compatible endpoints: `cline auth -p openai-compatible -k KEY -m MODEL -b https://host/v1`.
- Isolation (VERIFIED this left `~/.cline` untouched):
  ```bash
  CLINE_DIR=/tmp/x/cfg CLINE_DATA_DIR=/tmp/x/data CLINE_SESSION_BACKEND_MODE=local CLINE_HUB_PORT=25999 \
  cline --json --config /tmp/x/cfg --data-dir /tmp/x/data -c /abs/project -t 60 "run pwd"
  ```
  Without `CLINE_SESSION_BACKEND_MODE=local`, the CLI may route the run through the shared hub daemon (one is running on this machine).
- JSON output is NDJSON, one object per line with `type` and `ts` (VERIFIED against the mock):
  ```
  {"type":"hook_event","hookEventName":"agent_start",...}
  {"type":"agent_event","event":{"type":"iteration_start","iteration":1}}
  {"type":"agent_event","event":{"type":"content_start","contentType":"tool","toolName":"run_commands","toolCallId":"c1","input":{"commands":["pwd"]}}}
  {"type":"agent_event","event":{"type":"content_update","contentType":"tool",...,"update":{"stream":"stdout","chunk":"/abs/project\n",...}}}
  {"type":"agent_event","event":{"type":"content_end","contentType":"tool",...,"output":[{"query":"pwd","result":"/abs/project\n","success":true}],"durationMs":10}}
  {"type":"agent_event","event":{"type":"content_start","contentType":"text","text":"final answer ok","accumulated":"final answer ok"}}
  {"type":"agent_event","event":{"type":"done","reason":"completed","text":"final answer ok","iterations":2,"usage":{...}}}
  {"type":"run_result","finishReason":"completed","iterations":2,"usage":{...},"aggregateUsage":{...},"durationMs":150,"text":"final answer ok","model":{"id":"mock-model","provider":"openai-compatible"}}
  ```
  - On error: an `agent_event` with `event.type:"error"`, then `run_result` with `finishReason:"error"` and the message in `text`. stderr gets `{"type":"error","message":...}` and the **exit code is 1** (VERIFIED). On success the exit code is 0.
  - `run_aborted` follows `run_result` when the run was stopped (DOCS).
- CLI defaults differ from the SDK. A CLI run exposes `spawn_agent` and all `team_*` tools, plus `ask_question` (VERIFIED in the mock's tool list). In the SDK you choose these yourself with `enableSpawnAgent` and `enableAgentTeams`.
- Other commands:
  - `cline history --json --limit 10`
  - `cline config mcp --json`
  - `cline mcp add ... --yes`
  - `cline hub status|ensure|stop`
  - `cline --id <session-id> "follow-up"` to resume a session
  - `cline doctor log`
- CLI env vars: `CLINE_DIR`, `CLINE_DATA_DIR`, `CLINE_HUB_PORT` (default 25463), `CLINE_SESSION_BACKEND_MODE`, `CLINE_MCP_SETTINGS_PATH`, `CLINE_HOOKS_DIR`, `CLINE_LOG_PATH`, `CLINE_SANDBOX`, `CLINE_SANDBOX_DATA_DIR`.

---

## 14. Gotchas and limitations (consolidated)

1. **Pre-1.0 and fast-moving** (0.0.95, daily nightlies). Docs and the skill disagree in places, so pin the version.
2. **TypeScript `moduleResolution: NodeNext` breaks the SDK typings.** Use `Bundler`.
3. **`extraTools` needs `as AgentTool[]`** when the tools are typed with zod.
4. **`start()` blocks until the run finishes** (local mode). Choose `config.sessionId` yourself so you can abort or correlate.
5. **Provider/auth errors do not throw.** You get `finishReason: "error"` with the message in `result.text`. Always check `finishReason`. A `"completed"` text may be empty when the run ended through `submit_and_exit` or a `completesRun` tool. Inspect `result.toolCalls` in that case.
6. **`systemPrompt` is required and used verbatim.** Use `getClineDefaultSystemPrompt({rootPath,cwd,platform,mode,ide})` for Cline's prompt, which is about 4.2 KB.
7. **Rules leak in by default**: global `~/.cline/rules` and `~/.agents/AGENTS.md`, plus skills from `~/.cline/skills`, `~/.agents/skills` and `<ws>/.claude/skills`. Use `localRuntime: { configExtensions: [] }` or a controlled `CLINE_DIR`/`HOME` for reproducibility.
8. **MCP servers from the user's global settings auto-load** whenever `enableTools: true`. Set `disableMcpSettingsTools: true` unless you want them.
9. **`backendMode: "auto"` attaches to a running Cline hub** if one exists (one does on this machine). Use `"local"`.
10. **`enableTools` must be explicit.** Without it there are no built-ins, though `extraTools` and plugin tools still work. The built-in tool set depends on mode and model: in the mock run I saw `read_files, search_codebase, run_commands, fetch_web_content, editor` (sometimes `apply_patch` instead of `editor`).
11. **Built-in output caps:**
    - `read_files`: about 2000 lines or 48 KB unranged.
    - `run_commands`: about 48 KB of head+tail.
    - `search_codebase`: about 48 KB.
    - `apply_patch` is all-or-nothing (sdk-skill tools ref).
12. **Custom-tool `timeoutMs`/`retryable` are metadata only.** Enforce them yourself.
13. **`send()` only works on interactive sessions** (`start({ interactive: true })`). On a non-interactive one it throws "session not found".
14. **Always `dispose()`** the ClineCore at shutdown. Wire it to SIGTERM/SIGINT.
15. **Provider connection errors retry for about a minute** before failing, so wrap the run in your own timeout.
16. **Checkpoints (git snapshots) are opt-in**: `checkpoint: { enabled: true }`. Compaction defaults to agentic.
17. **Sessions persist to disk** (`~/.cline/data/sessions/<id>/...` and `db/sessions.db`). Set `CLINE_DATA_DIR` to relocate or isolate them; ClineCore respects it (VERIFIED).
18. **Bundling `@cline/core` with esbuild/webpack**: plugin worker mode needs `dist/extensions/plugin-sandbox-bootstrap.js` copied next to the bundle, or `CLINE_PLUGIN_BOOTSTRAP_PATH`. Avoid bundling for a hackathon.
19. **The CLI has no shell command allow/deny list.** Use a `PreToolUse`/`beforeTool` hook.

## 15. Open questions / unverified
- Automatic env-var key fallback when `apiKey` is omitted (see §7).
- Whether `getClineDefaultSystemPrompt` plus Cline's own defaults equal exactly what the CLI sends. The CLI likely adds metadata.
- Behavior and quality with real Anthropic models. Everything here was exercised only with a mock provider.
- Inline plugin MCP server loading and tool naming for `createMcpTools` (typechecked only).

## Local artifacts
- `scratchpad/sdkpkg/` has the installed SDK, `src/final.ts` (§3b, typechecks), `src/agent-example.ts`, `src/plugin-example.ts` and the `probe*.mjs` mock-LLM runtime tests (`mock-llm.mjs`, `mock-server.mjs`).
- `scratchpad/clinedocs/` has the raw markdown of every SDK doc page plus the CLI, rules, MCP, config and auto-approve pages.
- `scratchpad/sdk-skill/` is the clone of github.com/cline/sdk-skill.
- `scratchpad/examples/` has the official example sources (quickstart, cline-core-cli-agent, multi-agent).

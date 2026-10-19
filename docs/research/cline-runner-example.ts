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

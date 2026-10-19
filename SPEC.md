# Ensemble: Requirements & Technical Specification

> A file-and-directory-based agentic workspace. Prompts are files, outputs sit next to them, and a watcher reruns
> stale prompts in dependency order. Powered by the Cline SDK, with Parallel for web research and Composio for actions.

| | |
|---|---|
| Status | Ready for implementation |
| Author of requirements | Mehdi Jaffery (interviewed 2026-10-19) |
| Target | Hackathon submission (https://luma.com/m8euvq9n): public OSS repo, 3–5 slide deck, ≤2 min demo video |
| Implementation language | TypeScript on Node ≥ 22 (dev machine: Node 24.14, pnpm) |
| Research notes (read before coding) | `docs/research/research-cline.md`, `docs/research/research-parallel.md`, `docs/research/research-composio.md`, `docs/research/cline-runner-example.ts` |

Keywords **MUST**, **SHOULD** and **MAY** follow RFC 2119. Items tagged **[VERIFY]** depend on SDK behaviour that was not confirmed at runtime; check them in the Milestone 0 spikes before building on them.

---

## 1. Problem

The user does research-to-action work with coding agents in a single directory, which acts as a "monorepo of context". It contains:

- context about their company, teams and team members,
- research documents in nested topic folders,
- synthesis documents built from that research,
- shareable exports (PDF),
- actions taken through MCP servers and CLIs (emails, Linear tickets, Slack messages).

A typical chain looks like this:

```
"find the top 10 coding agent apps"                        → research (dataset)
  "find the PMs and VPs of Engineering at these companies" → research per company
  "profile, job history, LinkedIn posts of John Doe at ABC"→ deep-dive research
  "ABC's direction from blogs/changelogs, last 6 months"   → research per company
"is ABC an ICP for us? who should we target?"              → synthesis (reads research + company context)
"craft the email sequence for the ideal profile"           → synthesis
send/schedule the sequence, create Linear tickets          → action (Composio)
turn learnings into a PDF for the team                     → export
```

The current way of working breaks down in five ways:

1. **Stale context files.** AGENTS.md files go out of date, so agents can't find the right files. Nested directories need their own AGENTS.md so an agent can be started in any subdirectory.
2. **Lost prompts.** Prompts get copied around, lost, or slightly mutated, and nobody can tell which prompt produced which file.
3. **Manual reruns.** When an input or a prompt changes, the user has to remember everything downstream that needs regenerating. Dependencies chain (file → file → file), and they usually forget.
4. **Copy-paste reuse.** Repeating the same research sequence for another company means copying every prompt.
5. **Unclear actions.** Actions have side effects, so they must never fire by accident. They still need to be reproducible and traceable.

## 2. Solution summary

**Ensemble** is a CLI and daemon that turns a directory into a reactive, agent-maintained knowledge workspace.

- **Prompts are files.** A `*.prompt.md` file has YAML frontmatter that declares its `inputs` and `outputs`. The body is the prompt.
- **Actions are files too.** A `*.action.md` file follows a two-phase **plan → approve → execute** flow. The plan is a reviewable file, and execution is deterministic: no LLM runs at execute time.
- **Dependency graph.** The graph is built from declared inputs and outputs. A watcher detects changes, computes staleness from content fingerprints, and reruns stale prompts in topological order, with parallelism and debouncing. Each prompt has a `mode` (`auto` or `manual`).
- **Fan-out.** A prompt runs once per item of a list (CSV, JSON, or a directory glob), and each item is its own incremental graph node. **Fan-in** prompts that read all instances run after every instance is up to date.
- **Clone.** `ensemble clone` creates a new version of a prompt and records `derived_from` lineage.
- **Cline SDK.** Every prompt runs as a Cline SDK agent session with a strict run contract, custom **Parallel** research tools and a guarded **Composio** tool bridge.
- **Self-maintaining AGENTS.md.** Every directory gets an AGENTS.md with a managed block. A deterministic index lists the files, the prompts, what each prompt produced and its status. An LLM "librarian" adds one-line file summaries and directory purpose statements. A `CLAUDE.md` shim makes Claude Code pick the same context up.
- **Git history.** The workspace is a git repo, and every run auto-commits its outputs with a descriptive message.
- **Exports.** Markdown → PDF.
- **Interface.** A CLI, a daemon (`ensemble dev`) and a local **web UI** showing the live graph, run logs, the approval queue and history.

## 3. Interview decisions (authoritative)

| Topic | Decision |
|---|---|
| Prompt spec | Markdown + YAML frontmatter with explicit `inputs:` / `outputs:` |
| Rerun policy | Per-prompt `mode`. Prompts default to `auto`: they rerun automatically, debounced and topologically ordered. Actions are never executed automatically. They are re-planned and wait for approval. |
| Reuse | **Fan-out** over CSV / JSON / glob, plus **clone** with `derived_from` lineage. No separate template system. |
| Interface | CLI + daemon + local web UI |
| Actions | Plan file → approve (UI or CLI) → deterministic execute → receipt file |
| Hygiene | Auto-updated AGENTS.md managed blocks: a deterministic index plus LLM summaries |
| Cleanup / tidy | **Out of scope for v1.** Never delete or move user files. |
| LLM provider | **Cline provider** (`providerId: "cline"`), configurable per prompt |
| Layout | Light convention: reserved `context/`, `exports/`, `.ensemble/`. Everything else is free-form nested topic folders, with prompts next to their outputs. |
| History | Workspace is a git repo, auto-commit per run |
| Exports | Markdown → PDF |
| Name | `ensemble`: CLI `ensemble`, config `ensemble.yaml`, state dir `.ensemble/` |
| Demo | The coding-agent ICP flow (§16) |
| Demo side effects | **Drafts only.** Gmail drafts (not sent), a real Linear ticket and/or Slack message in the user's own workspace. |
| Deck | The implementing agent produces it: a Marp `deck/deck.md` rendered to PDF |

## 4. Goals and non-goals

### Goals (v1)

- **G1** Declare prompts as files with explicit dependencies. The tool can always answer "what produced this file, from what inputs, with which prompt version?" (lineage).
- **G2** Rerun stale `auto` prompts after any change to inputs, prompt bodies or fan-out lists. Runs go in correct dependency order, in parallel where possible, and never run twice for the same fingerprint.
- **G3** Repeat pipelines by fan-out instead of copy-paste, with per-item incrementality.
- **G4** Run actions safely. Nothing with external side effects happens without explicit approval of an exact, reviewable plan.
- **G5** Keep AGENTS.md (and CLAUDE.md shims) current in every directory, so an agent started in any subdirectory can orient itself.
- **G6** Provide first-class research tools: Parallel Search, Extract, Task (deep research and structured datasets), Task Groups (enrichment) and FindAll, with citations kept.
- **G7** Make it observable: a live web UI with the graph, run streams, the approval queue and history.
- **G8** Ship as an open-source repo with run instructions, an example workspace, a deck and a demo script.

### Non-goals (v1)

- Moving, renaming, archiving or deleting user files. Orphaned outputs are left as they are. The status view *may* list them as informational only.
- Multi-user or collaboration features, auth for the web UI (it binds to 127.0.0.1 only), or cloud hosting.
- A template library. Fan-out and clone cover reuse.
- Running two agents that write to the same file. Each output path has exactly one owner.
- Logged-in or paywalled scraping. LinkedIn content is limited to what public web sources expose. Document this limitation.
- Windows support. Linux and macOS are the targets; WSL works.

---

## 5. Concepts and glossary

| Term | Meaning |
|---|---|
| **Workspace** | A directory containing `ensemble.yaml`. It is a git repo. |
| **Prompt** | A `*.prompt.md` file. It produces declared `outputs` from declared `inputs` using an agent. |
| **Action** | A `*.action.md` file. Its agent produces a **plan** (exact tool calls), and approved plans are **executed** deterministically through Composio. |
| **Node** | A schedulable unit in the graph: one prompt, one action, or one fan-out **instance** of either. |
| **Source file** | A file that no node declares as an output, such as `context/company.md` or a hand-written note. Source files are leaves of the graph. |
| **Fan-out** | A prompt with `foreach:`. It expands into one instance per item. |
| **Fan-in** | A node whose `inputs` glob matches outputs of many fan-out instances. |
| **Fingerprint** | A hash over everything that semantically determines a node's outputs (§8.3). |
| **Fresh / Stale** | A node is fresh when its last successful run's fingerprint equals its current fingerprint and its outputs exist. Otherwise it is stale. |
| **Run** | One execution of a node. It has a `runId`, a log, a usage/cost record and a git commit. |
| **Librarian** | The background job that maintains AGENTS.md managed blocks and file summaries. |

---

## 6. Workspace directory convention

```
my-workspace/
├── ensemble.yaml                 # workspace config (§7.3). Its presence marks the root.
├── AGENTS.md                     # root context: managed block + user-authored text
├── CLAUDE.md                     # shim: "@AGENTS.md" (generated if missing)
├── .gitignore                    # includes .ensemble/ (runtime state), exports/*.tmp
├── .agents/skills/ensemble/SKILL.md   # authoring skill for interactive agents (§12.5)
├── .claude/skills/ensemble/SKILL.md   # same skill, for Claude Code
├── context/                      # RESERVED: company, product, ICP definition, team, members
│   ├── AGENTS.md
│   ├── company.md
│   ├── icp.md
│   └── team.md                   # names, roles, emails, Linear/Slack handles
├── coding-agents/                # free-form topic folder
│   ├── AGENTS.md
│   ├── top-10.prompt.md          # → top-10.csv (Parallel structured dataset)
│   ├── top-10.csv
│   ├── companies/
│   │   ├── _each/                # convention: fan-out prompts live in _each/
│   │   │   ├── people.prompt.md      # foreach row of ../../top-10.csv → ../{{slug}}/people.md
│   │   │   ├── direction.prompt.md   # → ../{{slug}}/direction.md
│   │   │   └── icp-fit.prompt.md     # → ../{{slug}}/icp-fit.md
│   │   ├── abc-agent/
│   │   │   ├── AGENTS.md
│   │   │   ├── people.md  direction.md  icp-fit.md
│   │   │   └── deep-dives/
│   │   │       ├── john-doe.prompt.md    # ad-hoc deep dive (plain prompt)
│   │   │       └── john-doe.md
│   │   └── …
│   ├── icp-ranking.prompt.md     # fan-in: companies/*/icp-fit.md → icp-ranking.md
│   ├── icp-ranking.md
│   └── outreach/
│       ├── sequence.prompt.md    # → sequence.md
│       ├── sequence.md
│       ├── send-drafts.action.md # → send-drafts.plan.json/.plan.md, send-drafts.receipt.json
│       └── followups.action.md   # → Linear tickets
├── exports/                      # RESERVED: rendered PDFs (mirrors source paths)
└── .ensemble/                    # RESERVED, git-ignored runtime state (§13)
```

Rules:

- **R-L1** The workspace root is the nearest ancestor directory containing `ensemble.yaml`. Commands work from any subdirectory.
- **R-L2** Prompt and action paths in frontmatter resolve **relative to the prompt file's directory**. A leading `/` means relative to the workspace root, for example `/context/company.md`. Paths **MUST NOT** escape the workspace root.
- **R-L3** Only `context/`, `exports/` and `.ensemble/` are reserved. All other structure is user-defined. The `_each/` folder for fan-out prompts is a recommended convention, not a requirement.
- **R-L4** Files ignored everywhere: `.git/`, `.ensemble/`, `node_modules/`, anything matched by `.gitignore`, plus `ensemble.yaml: ignore` globs.

---

## 7. File formats

### 7.1 Prompt file (`*.prompt.md`)

```markdown
---
description: Find PMs and VPs of Engineering at each top coding-agent company
foreach:
  from: ../../top-10.csv        # CSV | JSON array | JSON object with one array field | glob ending in "/" (dirs) or file glob
  as: company                   # variable name for the item
  key: "{{slugify company.company_name}}"   # instance key; default: slugify(first column / "name" / basename)
inputs:
  - /context/icp.md
  - ../{{company._key}}/overview.md          # templated per instance; missing optional inputs allowed with "?" suffix
outputs:
  - ../{{company._key}}/people.md
tools:
  parallel: [search, extract, research]      # or `true` for all; default: [search, extract]
  composio: []                               # tool slugs or toolkit slugs (read-only in prompts, §11.3)
  shell: false                               # expose Cline run_commands (default false)
model: anthropic/claude-sonnet-5.5           # optional override; default from ensemble.yaml
mode: auto                                   # auto | manual   (default auto)
timeout: 20m
budget_usd: 2.00                             # abort agent run if accumulated LLM cost exceeds this
parallel:
  max_processor: pro                         # cap for research/dataset tools
export: [pdf]                                # also render each .md output to exports/
---
Find the product managers and VP/Head of Engineering at {{company.company_name}}
({{company.website}}). For each person give name, title, LinkedIn URL if public,
tenure, and 1–2 notable public signals (talks, posts, quotes). Cite every claim.
```

Frontmatter schema. Validate with zod. Unknown keys produce a warning, not an error.

| Key | Type | Default | Fingerprinted | Notes |
|---|---|---|---|---|
| `id` | string | path without the `.prompt.md` suffix | no | Stable identifier used in UI and logs |
| `description` | string | none | no | Shown in AGENTS.md and UI |
| `inputs` | string[] | `[]` | yes (by content) | Paths or globs, templated. A `?` suffix marks an input as optional. Directories expand to `dir/**/*`. |
| `outputs` | string[] | **required, ≥1** | yes (the list) | Concrete paths after templating. Globs are not allowed. |
| `foreach` | string or object | none | yes | String shorthand is `from`, with `as: item` |
| `vars` | map | `{}` | yes | Merged over `ensemble.yaml: vars` |
| `tools` | object | `{parallel:[search,extract]}` | yes | See §10 and §11 |
| `model` | string | config default | yes | Cline-provider model id. `provider:model` switches provider. |
| `mode` | `auto` or `manual` | `auto` | no | |
| `schedule` | cron string | none | no | Marks the node stale on a schedule, for example to pull calendar events daily |
| `timeout` | duration | `30m` | no | |
| `budget_usd` | number | config default | no | |
| `parallel.max_processor` | processor | config default (`pro`) | no | Hard cap enforced in the tools |
| `incremental` | bool | `true` | no | Give the agent its previous output and an input diff summary (§9.2) |
| `export` | `["pdf"]` | `[]` | no | |
| `derived_from` | string | none | no | Set by `ensemble clone` |

Templating uses **Handlebars** with `noEscape: true` and `strict: true`, so an unknown variable is an error. It applies to the body, `inputs` and `outputs`. The helpers are `slugify`, `today` (YYYY-MM-DD), `json`, `lower` and `upper`. These variables are available:

- `vars.*`, also spread at the top level
- the `foreach` item under its `as` name, including `<as>._key` and `<as>._index`
- `prompt.dir` and `prompt.path`
- `workspace.root`

### 7.2 Action file (`*.action.md`)

```markdown
---
description: Create Gmail drafts for the 3-step sequence to the top-ranked prospect, and a Linear follow-up ticket
inputs:
  - sequence.md
  - ../icp-ranking.md
  - /context/team.md
tools:
  composio: [GMAIL_CREATE_EMAIL_DRAFT, LINEAR_CREATE_LINEAR_ISSUE, LINEAR_LIST_LINEAR_TEAMS, LINEAR_LIST_LINEAR_USERS, SLACK_SEND_MESSAGE]
plan: auto            # auto (re-plan when stale) | manual (plan only on demand)
---
Create one Gmail draft per email in the sequence (do not send), addressed to the
top-ranked prospect. Then create a Linear issue in the GTM team assigned to the
owner of outbound per context/team.md, linking the drafts, due in 3 days.
```

- Outputs are implicit and fixed: `<name>.plan.json`, `<name>.plan.md` (human-readable rendering) and `<name>.receipt.json`, all in the same directory.
- Actions **MAY** use `foreach`. Each instance plans and executes independently.
- `mode` doesn't apply to actions. Execution **always** requires approval. `plan: auto|manual` controls only re-planning.

### 7.3 Workspace config (`ensemble.yaml`)

```yaml
version: 1
name: gtm-research
llm:
  provider: cline                       # cline | anthropic | openrouter | openai-compatible (tests)
  model: anthropic/claude-sonnet-5.5    # [VERIFY] exact Cline model ids via Llms.getModelsForProvider("cline")
  summarizer_model: anthropic/claude-haiku-5.5   # [VERIFY]; used by the librarian
  max_iterations: 60
scheduler:
  concurrency: 3
  debounce_ms: 1500
  fanout_confirm_over: 12               # fan-out expansions larger than this need `ensemble approve-fanout` / UI click
defaults:
  timeout: 30m
  budget_usd: 3.00
parallel:
  max_processor: pro                    # global cap
  cache: true                           # cache identical Parallel requests in .ensemble/cache (see §10.4)
composio:
  backend: auto                         # auto | sdk | cli   (§11.1)
  user_id: local-user
  dry_run: false                        # true → action executions are simulated (§11.3)
git:
  auto_commit: true
  author: "Ensemble <ensemble@localhost>"
agents_md:
  enabled: true
  claude_md_shim: true
  summaries: true                       # LLM one-line summaries (cached by content hash)
ui:
  port: 4567
vars:
  my_company: Acme API Tools
  demo_recipient: you@example.com       # all demo drafts go to this address
  row_limit: 10                         # example top-N; use 3 for cheap smoke runs
ignore:
  - "scratch/**"
```

Validate with zod. Secrets **MUST NOT** go in `ensemble.yaml`. They come from the environment or `.env`, loaded with `dotenv` from the workspace root; `.env` is git-ignored by `init`.

### 7.4 Plan file (`<name>.plan.json`)

```jsonc
{
  "action": "coding-agents/outreach/send-drafts.action.md",
  "instance": null,
  "fingerprint": "sha256:…",           // action fingerprint at planning time
  "planned_at": "2026-10-20T10:12:00Z",
  "run_id": "run_…",
  "summary": "3 Gmail drafts to Jane Roe (VP Eng, ABC Agent) + 1 Linear issue for Sam (GTM)",
  "steps": [
    { "id": "lookup_team", "tool": "LINEAR_LIST_LINEAR_TEAMS", "args": {}, "readonly": true,
      "why": "Resolve GTM team id" },
    { "id": "draft_1", "tool": "GMAIL_CREATE_EMAIL_DRAFT",
      "args": { "recipient_email": "jane@abc.dev", "subject": "…", "body": "…", "is_html": false },
      "why": "Email 1 of 3" },
    { "id": "ticket", "tool": "LINEAR_CREATE_LINEAR_ISSUE",
      "args": { "title": "Follow up: ABC Agent outreach", "team_id": "{{steps.lookup_team.data.teams.0.id}}",
                "description": "Drafts: {{steps.draft_1.data.id}} …" },
      "why": "Track follow-up" }
  ]
}
```

- `args` **MAY** reference earlier step results with `{{steps.<id>.data…}}`. These are resolved at execute time. Any reference to a missing path fails that step.
- The plan `.md` is generated from the JSON. It is a readable table plus the full email bodies. The JSON is the source of truth, and the user **MAY** edit it before approving.

### 7.5 Receipt file (`<name>.receipt.json`)

This file is append-only. It holds one entry per execution:

```jsonc
{ "executions": [ {
    "approved_by": "cli|ui", "approved_at": "…", "plan_sha256": "…", "dry_run": false,
    "steps": [ { "id": "draft_1", "tool": "GMAIL_CREATE_EMAIL_DRAFT", "status": "ok|failed|skipped",
                 "resolved_args": { … }, "data": { … }, "error": null, "log_id": "…", "at": "…" } ] } ] }
```

---

## 8. Dependency graph and scheduling

### 8.1 Discovery

1. Glob the workspace for `**/*.prompt.md` and `**/*.action.md`, respecting the ignore rules.
2. Parse each file. A parse or validation error makes the node `invalid`, with the error shown in the UI and status. Such a node never runs.
3. **Expand fan-out.**
   - If the `foreach.from` file exists, read the items:
     - CSV via `papaparse`, header row required.
     - JSON: either an array, or an object with exactly one array field.
     - Glob: each matched dir or file becomes the item `{path, name, dir}`.
   - Compute `_key` for each item. Duplicate keys are an error on that prompt.
   - Create one instance node per item, with id `<promptId>[<key>]`.
   - If the `from` file is itself an output of another node and doesn't exist yet, the prompt is `pending-expansion`. It expands once the upstream finishes.
   - If the expansion exceeds `fanout_confirm_over`, the prompt waits in the approval queue, so a single CSV edit can't trigger hundreds of runs.
4. Template `inputs` and `outputs` per node, then resolve input globs against the workspace file set **plus** all declared outputs, which may not exist yet.

### 8.2 Edges and validation

- An edge A → B exists when any of A's outputs matches any of B's input patterns, or when B's `foreach.from` is an output of A.
- **Ownership:** each output path belongs to exactly one node. A conflict marks both nodes `invalid`.
- **Cycles:** detect them with Tarjan's or Kahn's algorithm. Nodes in a cycle are `invalid` and the error lists the cycle path.
- Inputs that match nothing and aren't marked optional (`?`) make the node `blocked: missing input <path>`.
- `AGENTS.md`, `CLAUDE.md`, `*.plan.md` and anything under `.ensemble/` are **never** matched by input globs unless named exactly, so librarian writes never cause reruns.

### 8.3 Fingerprint

```
fingerprint(node) = sha256(canonicalJSON({
  body: renderedPromptBody,
  fm: frontmatter fields marked "Fingerprinted" in §7.1 (after templating),
  item: foreach item (for instances),
  inputs: sorted [[path, sha256(content)] for each resolved input file],
  model: effective model id,
  engine: ENSEMBLE_FINGERPRINT_VERSION   // bump to invalidate everything on runtime changes
}))
```

- **Fresh** means `lastSuccess.fingerprint === current && every output exists && every output's hash === hash recorded at lastSuccess`.
- If an output's hash differs from the recorded one, the user edited it by hand. Such a node is **`modified`**, not stale:
  - It is not auto-rerun, so it never clobbers the user's edits.
  - Its downstream nodes *are* stale and do rerun, because their input content changed.
  - The UI offers "rerun anyway (overwrites)" and "accept edit". Accepting records the new hash as the baseline.
- A `schedule` node is marked stale when its cron fires. Implement this by adding a `scheduledTick` to the fingerprint inputs.
- Input file hashes are cached by `(path, mtimeMs, size)` to avoid re-hashing.

### 8.4 Scheduler

- **States:** `invalid | blocked | pending-expansion | fresh | stale | modified | queued | running | failed | awaiting-approval (actions/fan-out) | executing (actions)`.
- **Loop**, triggered by a debounced file event, an explicit run command or a cron tick:
  1. Rebuild the graph incrementally and recompute fingerprints for affected nodes.
  2. A node is **runnable** if it is stale, `mode: auto` (or explicitly requested), and none of its upstream nodes are stale, queued, running, failed or blocked.
  3. Enqueue runnable nodes in topological order and run up to `concurrency` at once.
- **Upstream gating:** a downstream node waits until every upstream node is fresh. If an upstream run fails, the downstream node shows `blocked: upstream failed` and does not run.
- **Change during a run:** if a running node's inputs change, let the run finish, record its fingerprint as the one *at start*, and the node becomes stale again and requeues. Do not abort mid-run.
- **No duplicate work:** never run the same node twice concurrently, and never start a run whose fingerprint equals the in-flight or last-successful fingerprint.
- **Watcher:** use `chokidar@4`, watching the root and filtering with `picomatch`. Note that v4 has no glob support. Use `awaitWriteFinish: {stabilityThreshold: 300}`, plus the debounce window. Self-writes need no special handling, because staleness is fingerprint-based and a run's own outputs leave it fresh.
- **Manual nodes:** `mode: manual` nodes are shown as stale but only run on `ensemble run <node>` or a UI click.
- **Failure:** the node becomes `failed`, with the error and log link. There is no automatic retry, but `ensemble run --failed` retries all failed nodes. Previous outputs are left in place.
- **Graceful shutdown:** on SIGINT, abort in-flight sessions (`cline.abort`), mark them `failed: interrupted` and dispose ClineCore.

---

## 9. Agent runtime (Cline SDK)

Use `@cline/sdk@0.0.95`, pinned exactly; it is pre-1.0 and changes daily. The full findings, including verified code, are in `docs/research/research-cline.md`. `docs/research/cline-runner-example.ts` is a typechecked runner skeleton to start from.

### 9.1 Session setup

- Create one `ClineCore.create({ clientName: "ensemble", backendMode: "local" })` per daemon process.
  - **Never use `"auto"`.** A Cline hub daemon runs on the dev machine and `auto` would attach to it.
  - Set `CLINE_DATA_DIR=<ws>/.ensemble/cline` before creating the core, so session databases stay inside the workspace.
- Per run, call `cline.start({ prompt, interactive: false, config, toolPolicies: { "*": { autoApprove: true } }, localRuntime: { configExtensions: [] } })` with:

  | Config field | Value |
  |---|---|
  | `sessionId` | `run_<ulid>`, chosen up front so it can be aborted |
  | `cwd`, `workspaceRoot` | workspace root, so the agent can read inputs anywhere |
  | `providerId`, `modelId` | from §9.4 |
  | `systemPrompt` | `getClineDefaultSystemPrompt({rootPath, cwd, platform, mode:"act", ide:"Terminal Shell"})` + `\n\n` + `ENSEMBLE_SYSTEM_ADDENDUM` (§9.3) |
  | `rules` | the **AGENTS.md chain**: root AGENTS.md, then each AGENTS.md on the path down to the prompt's directory, concatenated with headers. This replaces Cline's cwd-only AGENTS.md discovery, which is disabled by `configExtensions: []` for reproducibility. **[VERIFY]** that `config.rules` is injected. If not, prepend the chain to the system prompt. |
  | `enableTools` | `true` |
  | `enableSpawnAgent`, `enableAgentTeams` | `false` |
  | `disableMcpSettingsTools` | `true`, so the user's global MCP servers don't leak in |
  | `maxIterations` | from config |
  | `extraTools` | `[...ensembleTools, ...parallelTools, ...composioTools] as AgentTool[]` |
  | `hooks.beforeTool` | the write guard (§9.5) |

- Remove `run_commands` unless `tools.shell: true` (`config.toolPolicies: { run_commands: { enabled: false } }`). Keep `read_files`, `search_codebase` and `editor`/`apply_patch`. Remove `fetch_web_content` in favour of Parallel extract.
- Subscribe with `cline.subscribe(fn, { sessionId })`:
  - Forward text deltas (`agent_event` / `content_start` with contentType `text`) and tool start/end events to the run's `events.jsonl` and the UI's SSE stream.
  - Track `usage.totalCost`. Abort when it exceeds `budget_usd`.
  - Abort with `cline.abort(sessionId, "timeout")` after `timeout`.
- **Result handling:**
  - `start()` does **not throw** on provider errors. Treat `finishReason !== "completed"` as failure.
  - Success requires all of the following:
    1. `finishReason === "completed"`, and
    2. the `ensemble_complete` tool was called, and
    3. every declared output exists and was written during this run (its mtime is after the run start, or its hash changed, or the agent called `ensemble_complete` with `unchanged: true` for that path).

### 9.2 Run contract (user message sent to the agent)

```
# Ensemble run
Prompt file: coding-agents/companies/_each/people.prompt.md   (instance: abc-agent)
Run id: run_01J…    Today: 2026-10-20

## Inputs (read these first; paths relative to workspace root)
- context/icp.md
- coding-agents/companies/abc-agent/overview.md   [changed since last successful run]

## Required outputs (write every file; do not write anywhere else)
- coding-agents/companies/abc-agent/people.md
  previous version exists — update it rather than starting over; preserve still-valid content.

## Tools
- parallel_search / parallel_extract / parallel_research … (see tool descriptions)
- ensemble_complete — call exactly once when all outputs are written.

## Task
<rendered prompt body>
```

Inline the content of small inputs (each < 8 KB, total < 40 KB). List the larger ones and let the agent read them with `read_files`.

### 9.3 System addendum (`ENSEMBLE_SYSTEM_ADDENDUM`)

The addendum states the following rules, worded concisely:

- You are running unattended inside an Ensemble workspace.
- Write only the required outputs.
- Markdown outputs MUST cite sources inline as `[n]` with a `## Sources` list of URLs.
- Never invent facts. Mark unknowns explicitly.
- Prefer Parallel tools for anything on the web.
- Do not call side-effecting tools. Actions are planned, not executed.
- Finish by calling `ensemble_complete`.

### 9.4 Provider, model and auth resolution

Resolve in this order:

1. If `ensemble.yaml: llm.provider` is `cline`:
   1. Use `apiKey = process.env.CLINE_API_KEY` if set.
   2. Otherwise reuse the user's existing `cline auth` login: `new ProviderSettingsManager().getProviderConfig("cline")`, exported from `@cline/sdk`, which reads `~/.cline/data/settings/providers.json`. The dev machine is logged in to the Cline provider via OAuth, and its stored model is `anthropic/claude-sonnet-5.5`. **[VERIFY in Spike S1]** that the returned config (OAuth `accessToken`) works when passed to `cline.start` and refreshes on expiry.
   3. If both fail, fall back to a clear error: "run `cline auth` or set CLINE_API_KEY".
2. For `anthropic`, `openrouter` and others: use `apiKey` from the standard env var (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`). Always pass it explicitly; the SDK may not read it from the environment.
3. For `openai-compatible`: use `baseUrl` + `apiKey`. This is used for the mock-LLM end-to-end tests (§17).

A per-prompt `model: "anthropic:claude-…"` (with a colon) overrides the provider for that prompt. Without a colon it is a model id for the workspace provider.

### 9.5 Write guard

A `beforeTool` hook inspects `editor`/`apply_patch` (and `run_commands` when it is enabled) and returns `{ skip: true, reason }` for any write target outside:

- the node's declared outputs, and
- `.ensemble/tmp/<runId>/`.

**[VERIFY]** the hook signature from `research-cline.md` §8/§12; hooks have a 3 s timeout. As a backstop, diff the workspace file hashes before and after each run. Report undeclared writes as warnings on the run, and leave them in place (no cleanup in v1).

### 9.6 Ensemble built-in tools (for all runs)

| Tool | Input | Behaviour |
|---|---|---|
| `ensemble_complete` | `{ summary: string, unchanged?: string[] }` | Defined with `lifecycle: { completesRun: true }`. Records the summary in run metadata and in the git commit body. |
| `ensemble_note` | `{ message }` | Appends to the run log, shown in the UI. Useful for "couldn't find X". |
| `propose_action_step` | `{ id, tool, args, why, readonly? }` | **Action planning runs only.** Validates `tool` against the action's allowlist and `args` against the Composio JSON schema (§11.2), then appends the step to the in-memory plan. |

---

## 10. Parallel integration (research tools)

Package: `parallel-web@1.3.5`. Auth: `PARALLEL_API_KEY`, which the SDK reads automatically. Full API details and gotchas are in `docs/research/research-parallel.md`.

### 10.1 Tools exposed to agents

Tools are enabled per prompt via `tools.parallel`. All tools that write files only accept paths inside the node's declared outputs or `.ensemble/tmp/<runId>/`.

| Tool name | Parallel API | Input (zod) | Output to agent |
|---|---|---|---|
| `parallel_search` | `client.search` with `mode: "fast"` by default | `{ objective, search_queries: string[1..5], mode?, max_results?, include_domains?, after_date? }` | Top results: url, title, publish_date, excerpts, truncated to about 12k chars |
| `parallel_extract` | `client.extract` | `{ urls: string[1..10], objective?, full_content?: boolean }` | Excerpts or full markdown, truncated. Errors are listed. |
| `parallel_research` | `client.taskRun.create` with `task_spec.output_schema = {type:"text", description?}` | `{ query, processor?: lite..ultra (≤ max_processor; default "core"), output_path?, report_guidance? }` | Waits by polling (§10.3). Writes the markdown report plus a Sources section built from `basis` to `output_path`, or returns it (truncated) when no path is given. Returns `{ run_id, path?, citations_count }`. |
| `parallel_dataset` | `client.taskRun.create` with a JSON `output_schema` | `{ query, columns: [{name, type: "string"|"number"|"integer"|"boolean", description, nullable?}], row_count_hint?, processor?, output_path (".csv" or ".json") }` | Builds a schema that follows Parallel's rules: a root object with a `rows` array, every field required, `additionalProperties:false`, nullables as `["type","null"]`, row count stated in the description and never as `maxItems`. Writes CSV or JSON. Also writes `<output_path>.sources.json` with per-row `basis` (`rows.N`). Returns `{ rows, path }`. |
| `parallel_enrich` | Task Groups (`taskGroup.create`, `addRuns`, then poll `retrieve`, then `getRuns` SSE) | `{ input_path (csv/json), key_columns: string[], new_columns: [...same as dataset], processor? (default "base"), output_path }` | One run per row. Joins the outputs back onto the rows and writes the file. Failed rows get empty cells, and failures are reported. |
| `parallel_findall` | `client.beta.findall.create`, then poll, then `result` | `{ objective, entity_type, match_conditions: [{name, description}], generator?: preview|base|core (default base), match_limit (≤50), output_path }` | Filters to `match_status === "matched"` and writes CSV or JSON (name, url, description, plus the condition values). Returns the count. |

### 10.2 Guardrails

- Enforce `processor ≤ min(prompt max_processor, workspace max_processor)` using the order `lite < base < core < core2x < pro < ultra < ultra2x < ultra4x < ultra8x`. Reject anything higher, and tell the agent which processor is allowed.
- `parallel_findall` is limited to `generator ≤ core` and `match_limit ≤ 50` unless the config raises it.
- `parallel_enrich` refuses inputs of more than 200 rows unless the config raises it.
- Record cost estimates per call in run metadata, using the price table in the research notes, so the UI can show "est. Parallel cost".

### 10.3 Async handling

- Create the client with `new Parallel({ maxRetries: 2 })`. When polling, call `taskRun.retrieve(runId)` every 5 s for runs under `core` and every 15 s otherwise, until the status is `completed`, `failed` or `cancelled`. Then fetch with `taskRun.result(runId, {timeout: 30}, {maxRetries: 0})`.
  - **Do not** loop on `result()` with the default retries. A 408 retry can block for about 75 s per call.
- Honour the agent's `context.signal`. On abort, stop polling, and cancel FindAll runs. Task runs can't be cancelled; note this in the logs.
- Emit progress through `context.emitUpdate` (`{status, elapsed}`) so the UI shows "research running 2m10s".

### 10.4 Cache

- When `parallel.cache: true`, responses are cached in `.ensemble/cache/parallel/<sha256(endpoint+canonical request)>.json`.
- `parallel_search` and `parallel_extract` entries expire after 24 h. Task, FindAll and dataset entries never expire, but are bypassed by `ensemble run --no-cache`.
- Purpose: reruns triggered by unrelated input changes, and crash recovery, don't pay twice for identical research.
- The UI marks cached tool calls with a "cached" badge. This is important for honest demo disclosure.

### 10.5 MCP alternative

Not used by default. Parallel's hosted Search MCP (`https://search.parallel.ai/mcp`, free) and Task MCP could be attached through a Cline plugin. The native tools are preferred because they write files directly and enforce the guardrails.

---

## 11. Composio integration (tools and actions)

Package: `@composio/core@0.25.0`, ESM-only, Node ≥ 22.22.3. Full findings are in `docs/research/research-composio.md`, and **its "two projects" gotcha is critical**.

### 11.1 Backends

Implement a `ComposioBackend` interface with two implementations:

```ts
interface ComposioBackend {
  getToolSchema(slug: string): Promise<{ slug; description; inputSchema: JSONSchema; tags: string[] }>;
  searchTools(query: string): Promise<Array<{ slug; description }>>;
  execute(slug: string, args: object): Promise<{ ok: boolean; data: unknown; error?: string; logId?: string }>;
  connect(toolkit: string): Promise<{ redirectUrl?: string; connected: boolean }>;
  connections(): Promise<Array<{ toolkit: string; status: string }>>;
}
```

1. **`sdk` backend** (preferred when `COMPOSIO_API_KEY=ak_…` is set):
   - `new Composio({ apiKey, allowTracking: false })`, then `composio.create(user_id, { toolkits, manageConnections: false, sandbox: { enable: false } })`. Persist `sessionId` in `.ensemble/composio.json` and reuse it with `composio.use(id)`.
   - Execute with `session.execute(slug, args)`. Success means `resultType === "completed"`; do not rely on `error`.
   - Schemas come from `composio.tools.getRawComposioToolBySlug(slug)`.
   - Connect with `session.authorize(toolkit)`, which yields a `redirectUrl`, then `waitForConnection(120_000)`.
   - Accounts must be connected **through the SDK project**. Connections made with plain `composio link` live in the consumer project and are invisible here.
2. **`cli` backend** (fallback; uses the user's existing `composio login`, with no `ak_` key needed):
   - Shell out to `composio execute <SLUG> -d @<tmpfile.json>` and `composio execute <SLUG> --get-schema`, `composio search "<q>"`, `composio link <toolkit> --no-browser` and `composio connections list`.
   - Parse stdout JSON and check `.successful`. **Exit code 0 can still mean failure.** Validation errors exit 1 with ANSI text: strip the codes and surface them.
   - Binary path is `composio` on PATH, else `~/.composio/composio`.
   - `backend: auto` uses `sdk` if `COMPOSIO_API_KEY` starts with `ak_`, otherwise `cli`. `ensemble doctor` reports which backend is active and which toolkits are connected.

Toolkit slugs: `gmail`, `googlecalendar` (not `google_calendar`), `googlesheets`, `googledocs`, `slack`, `linear`. The demo needs these tool slugs (confirmed 2026-10-19; re-verify with `composio search`):

| Purpose | Slug | Notes |
|---|---|---|
| Gmail draft | `GMAIL_CREATE_EMAIL_DRAFT` | `recipient_email`, `subject`, `body`, `is_html`. The draft id is `data.id`. |
| Gmail send (not in demo) | `GMAIL_SEND_EMAIL` | |
| Calendar read | `GOOGLECALENDAR_EVENTS_LIST` | `calendarId`, `timeMin`, `timeMax` (RFC3339), `singleEvents:true`, `orderBy:"startTime"` |
| Linear issue | `LINEAR_CREATE_LINEAR_ISSUE` | `title`*, `team_id`*, `description`, `assignee_id`, `due_date` |
| Linear lookups | `LINEAR_LIST_LINEAR_TEAMS` (may be under `data.teams`), `LINEAR_LIST_LINEAR_USERS` | read-only |
| Slack post | `SLACK_SEND_MESSAGE` | `channel`, `markdown_text`. **Not idempotent.** |
| Docs / Sheets | `GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN`, `GOOGLESHEETS_CREATE_GOOGLE_SHEET1` | optional |

### 11.2 Tools exposed to agents

Composio tools are exposed only for slugs or toolkits listed in `tools.composio`.

- **In prompts** (`*.prompt.md`), each allowed **read-only** slug becomes a native Cline tool named after the lowercased slug, for example `googlecalendar_events_list`. Its `inputSchema` is the Composio JSON schema and it executes through the backend.
  - A tool counts as read-only if its tags include `readOnlyHint`. Without tags (CLI backend), it is read-only when its slug verb is one of `LIST|GET|FETCH|FIND|SEARCH|READ`.
  - Non-read-only slugs listed in a prompt are rejected at parse time with the message "use an .action.md".
  - This covers "pull calendar events into a file", for example a scheduled prompt that writes `context/calendar/this-week.md`.
- **In action planning runs**, read-only slugs are callable live, so the planner can resolve team ids and the like. Write slugs are **not** callable; the agent must use `propose_action_step`, which validates args against the schema. Required fields missing produce a tool error so the agent can fix the step.
- `composio_search_tools({query})` is always available in planning runs, to help the agent pick a slug from its allowlist.

### 11.3 Action lifecycle

```
            upstream change / first discovery / manual "plan"
                           │
          ┌────────────────▼───────────────┐
          │ PLANNING (Cline run)           │ → <name>.plan.json + <name>.plan.md   (git commit)
          └────────────────┬───────────────┘
                           ▼
          AWAITING_APPROVAL ──reject──► REJECTED (recorded; replan on next change or manual)
                           │ approve (UI button / `ensemble approve <action>`)
                           ▼     approval records plan_sha256; if plan file changes after approval → approval void
          EXECUTING (deterministic, no LLM)
             steps sequential; resolve {{steps.*}} refs; stop at first failure
                           ▼
          EXECUTED (receipt appended, git commit) ──upstream change──► STALE → re-plan (if plan: auto) → AWAITING_APPROVAL
```

- **Idempotency:** before executing a step, look for a successful receipt entry with the same `(step.id, sha256(resolved_args))` from an earlier execution of this plan. If one exists, skip the step as `skipped: already executed`. Re-executing after a partial failure therefore never duplicates drafts or messages, unless `--force` is given.
- **Dry run:** `ensemble approve --dry-run` or `composio.dry_run: true` writes the receipt with `dry_run: true` and simulated data. The UI shows a "SIMULATED" badge. (Required for honest demo disclosure.)
- **Display:** the approval view shows the plan in readable form (recipients, subjects, full bodies, ticket fields), a diff against the previously executed plan when there is one, and **Approve / Edit JSON / Reject** buttons.

### 11.4 Triggers (stretch, §19)

Use `composio.triggers.subscribe` to write events, for example new Gmail messages, to `inbox/<trigger>/<id>.json` files. These files become inputs that drive prompts. This is not required for v1; `schedule:` with a read-only prompt covers the calendar use case.

---

## 12. AGENTS.md maintenance (the librarian)

### 12.1 Scope

- Every directory that contains at least one non-ignored file or subdirectory gets an `AGENTS.md`, excluding `.ensemble/` and `exports/`.
- When `agents_md.claude_md_shim` is on, every directory with an AGENTS.md also gets a `CLAUDE.md` containing exactly `@AGENTS.md`, but **only if no CLAUDE.md exists**.

### 12.2 Managed block

```markdown
# coding-agents/companies/abc-agent            ← user may freely edit anything outside the markers

<!-- ensemble:begin — generated, do not edit inside this block -->
**Purpose:** Research on ABC Agent (coding agent, Series B): people, product direction, ICP fit.   ← LLM, cached
**Parent:** [../AGENTS.md](../AGENTS.md) · **Workspace root:** [/AGENTS.md](../../../AGENTS.md)

| File | What it is | Produced by | Status |
|---|---|---|---|
| people.md | PMs and VP Eng at ABC Agent with sources (7 people)   ← LLM summary | `_each/people.prompt.md[abc-agent]` | fresh · 2026-10-20 |
| direction.md | … | `_each/direction.prompt.md[abc-agent]` | stale (overview.md changed) |
| notes.md | … | source (hand-written) | — |

**Prompts here:** _none_  ·  **Subdirectories:** [deep-dives/](deep-dives/AGENTS.md) — 1 deep dive (John Doe)
**Downstream consumers:** `../../icp-ranking.prompt.md`
<!-- ensemble:end -->
```

### 12.3 Deterministic vs LLM parts

- **Deterministic (no LLM):** the file table (name, producer, status, last run date), prompts with `inputs → outputs`, subdirectory links, downstream consumers, and parent/root links.
- **LLM, cheap model, cached:**
  - A one-line summary per file, cached in `.ensemble/summaries.json`, keyed by `sha256(content)`. A summary is only regenerated when the content changes. Files over 50 KB are summarized from their first and last 8 KB.
  - A `Purpose:` line per directory, regenerated only when the directory's set of file names changes.
  - Use the Cline `Agent` class with no tools and `maxIterations: 1`. Batch up to 20 files per call, returning a JSON map.
- **Root AGENTS.md** additionally gets a static "How this workspace works" section, generated by `init` and kept in the managed block. It explains:
  - the file conventions (`.prompt.md` / `.action.md` / frontmatter),
  - the reserved directories,
  - how to run things (`ensemble run`, `ensemble status`),
  - and **"to create a new research step, write a `*.prompt.md` file; don't do the research ad hoc if it should be repeatable"**.

### 12.4 Triggering

- The librarian runs debounced (5 s) after the scheduler has been idle.
- It only touches directories whose file set or file hashes changed, plus their ancestors (for subdirectory summaries).
- Writes are atomic (write to a temp file, then rename).
- Librarian commits are batched: `chore(agents-md): update 4 directories`.
- AGENTS.md changes never trigger reruns (§8.2).
- `ensemble index` forces a full rebuild, and `ensemble index --no-llm` rebuilds the deterministic part only.

### 12.5 Authoring skill

`ensemble init` writes `.agents/skills/ensemble/SKILL.md` and an identical `.claude/skills/ensemble/SKILL.md`. The skill teaches interactive agents (Claude Code, Cline) how to work in the workspace:

- the frontmatter schema with examples (plain, fan-out, fan-in, action, scheduled),
- path rules,
- "prefer adding a prompt file over doing one-off research",
- how to clone a prompt for iteration,
- how to check status with `ensemble status --json`.

This lets the user say "set up research on X" in an interactive Claude Code session and get valid prompt files back.

---

## 13. State, history and lineage

### 13.1 `.ensemble/` layout (git-ignored)

```
.ensemble/
├── state.json            # per node: lastSuccess {runId, fingerprint, outputs:{path:sha256}, commit, at}, lastRun, status, approvals
├── summaries.json        # librarian cache
├── composio.json         # sdk session id
├── cache/parallel/…      # §10.4
├── cline/                # CLINE_DATA_DIR
├── runs/<runId>/
│   ├── meta.json         # node, instance, fingerprint, inputs+hashes, model, usage, cost, parallel calls, status, timings, commit
│   ├── prompt.md         # exact rendered run contract sent to the agent
│   └── events.jsonl      # streamed agent events / tool calls / notes
└── tmp/<runId>/
```

Write `state.json` atomically and serialize writes through one in-process queue. A daemon lock (`.ensemble/daemon.lock` with pid and port) prevents two daemons. When a daemon is running, CLI commands talk to it over HTTP (§14.2). Otherwise they operate in-process.

### 13.2 Git

- `ensemble init` runs `git init` if needed, and adds `.gitignore` (`.ensemble/`, `.env`, `node_modules/`).
- **Before each run:** if any of the node's input files have uncommitted changes, commit them first as `chore(ensemble): snapshot inputs for <node>`. Every run's inputs are then reproducible from a commit, and `meta.json` records `inputs_commit`.
- **After each successful run:** stage exactly the declared outputs (plus plan/receipt files for actions) and commit:
  ```
  run(coding-agents/companies/_each/people[abc-agent]): updated people.md

  trigger: input changed: coding-agents/companies/abc-agent/overview.md
  run: run_01J…  model: anthropic/claude-sonnet-5.5  cost: $0.41 (+ Parallel est. $0.03)
  summary: <ensemble_complete summary>
  ```
- Use `simple-git`. All commits go through one serialized queue. Never commit files the run didn't own, except the input snapshot.
- Never push. If the user hasn't configured a git identity, set the author with `-c user.name/-c user.email` from config.

### 13.3 Lineage commands

- `ensemble explain <file>` prints the producer node, the prompt file and its `derived_from` chain, the last run (date, model, cost, commit), the inputs with their hashes at that run, and the downstream consumers.
- `ensemble history <file|node>` prints the git log for the file, with run ids.

---

## 14. Interfaces

### 14.1 CLI (`commander`)

| Command | Behaviour |
|---|---|
| `ensemble init [dir] [--example coding-agents-icp]` | Creates `ensemble.yaml`, `context/` stubs (company.md, icp.md, team.md with TODO prompts), skills, `.gitignore`, git repo and the root AGENTS.md. `--example` copies `examples/coding-agents-icp/` into `dir`. |
| `ensemble dev` | Starts the daemon: watcher, scheduler, librarian, cron, web UI on `127.0.0.1:<port>`. Prints the URL and logs events compactly. |
| `ensemble status [--json] [path]` | Table of nodes with state, last run, reason stale, and cost. Filters to a subtree when `path` is given. |
| `ensemble graph [--json \| --mermaid]` | Prints the DAG |
| `ensemble run [target…] [--force] [--downstream] [--failed] [--stale] [--no-cache] [--var k=v] [--dry-run]` | Target is a prompt path, a node id or a directory (all nodes inside it). `--dry-run` prints what would run, in order, with fingerprints and reasons. `--var` overrides vars for a one-off run whose outputs are still the declared ones. |
| `ensemble new <path.prompt.md \| path.action.md> [--foreach file] [--from-description "…"]` | Scaffolds a prompt. With `--from-description`, an agent drafts the frontmatter and body from the description, given workspace context. |
| `ensemble clone <prompt> [new-path]` | Copies the file. Sets `derived_from: <original>`. Rewrites outputs to avoid ownership conflicts, by suffixing `-v2` (or the next free version) before the extension. Opens nothing and runs nothing. |
| `ensemble approve <action> [--dry-run] [--force]` / `ensemble reject <action> [--reason]` | Action approval and execution. Also `ensemble approve-fanout <prompt>`. |
| `ensemble plan <action>` | Forces re-planning |
| `ensemble connect <toolkit…>` | Composio connect flow. Prints or opens the redirect URL and waits. |
| `ensemble export <file.md> [--pdf]` | Renders to `exports/<same path>.pdf` |
| `ensemble index [--no-llm]` | Rebuilds AGENTS.md files |
| `ensemble explain <file>` / `ensemble history <file>` / `ensemble logs <node \| runId> [-f]` | Lineage and logs |
| `ensemble doctor` | Checks Node version, Cline auth (actually makes a tiny 1-token call), `PARALLEL_API_KEY` (a free `parallel_search` with `mode:"fast"`, guarded by a prompt), Composio backend and connections, git, Chromium for PDF, and parse errors |

Exit codes: 0 ok, 1 error, 2 invalid workspace or config. Every read command supports `--json`.

### 14.2 Daemon HTTP API (Hono on `@hono/node-server`, bound to 127.0.0.1)

```
GET  /api/graph                    → nodes (id, path, kind, state, reason, lastRun, costs, instanceOf), edges
GET  /api/nodes/:id                → node detail: frontmatter, rendered body, inputs (+hashes, changed flags), outputs, runs
GET  /api/runs/:runId              → meta; GET /api/runs/:runId/events → events.jsonl
GET  /api/events  (SSE)            → node.state, run.started, run.event (text delta / tool start/end / note), run.finished,
                                     approval.requested, librarian.updated, fs.changed
POST /api/run            {targets[], force?, downstream?}
POST /api/abort          {runId}
POST /api/actions/:id/approve {dryRun?}  · /reject {reason} · /plan
POST /api/fanout/:id/approve
POST /api/nodes/:id/accept-edit
GET  /api/files?path=…             → file content (read-only viewer; markdown rendered client-side)
POST /api/pause | /api/resume      → pause auto scheduling (manual runs still allowed)
```

### 14.3 Web UI (Vite + React + `@xyflow/react`, served by the daemon as static files)

The UI is optimized for the demo video, so it must be clear and live.

1. **Graph view (home)**
   - A left-to-right DAG laid out with `dagre` or `elkjs`.
   - Source files are small grey nodes. Prompts are cards. Fan-out prompts render as a stacked group that can expand to show instances. Actions get a distinct shape.
   - Colour by state: fresh green, stale amber, queued blue outline, running blue pulse, failed red, awaiting-approval purple, modified teal, invalid/blocked grey with an icon.
   - When a file changes, animate the "stale wave" propagating downstream.
   - Toolbar: **Run all stale**, Pause/Resume auto, a filter by directory, and a cost-so-far counter (LLM + Parallel est.).
2. **Node drawer** (click a node)
   - Prompt (rendered), with frontmatter chips (inputs, outputs, tools, mode, model).
   - Why it's stale (the changed inputs).
   - **Live run stream**: the assistant text plus collapsible tool calls (Parallel calls show query, processor, elapsed, cached badge).
   - Outputs as rendered markdown with a diff against the previous version from git.
   - Run history, and Run/Abort buttons.
3. **Approvals inbox**
   - Pending actions and pending fan-out expansions.
   - The plan is rendered readably: email cards with To/Subject/Body, ticket cards.
   - An Edit JSON button, Approve / Approve (dry run) / Reject, and the receipt after execution, with links when `data` contains URLs.
4. **Activity feed** showing runs, commits and librarian updates, newest first.
5. **File browser** (stretch): a tree with AGENTS.md rendered, showing the status per file.

---

## 15. Exports

- `export: [pdf]` in a prompt, or `ensemble export`, renders Markdown to HTML with `markdown-it` (GFM tables, footnotes, anchor links) and a bundled print CSS, and then to PDF with **Playwright Chromium** (`page.pdf({format:"A4", printBackground:true})`).
- `ensemble doctor` checks for the browser and prints `npx playwright install chromium` if it is missing.
- Output goes to `exports/<source path with .pdf>`, committed with the run.
- A header shows the title, date and "Generated by Ensemble from <path> @ <commit short sha>". Sources links stay clickable.

---

## 16. Example workspace and demo flow (must ship in repo)

`examples/coding-agents-icp/` is a complete workspace. It holds config and prompts, plus example **context** files for a fictional company. It has **no committed outputs**: the user runs it live, and the README states the expected costs.

```
context/company.md       # "Acme API Tools" — fictional: what we sell (SDK generation/API tooling for dev-tool companies)
context/icp.md           # ICP criteria: dev-tool companies with public APIs/SDKs, 20–500 employees, Series A–C, signals…
context/team.md          # fictional team: names, roles, emails (example.com / user's own address via var), Linear team key
coding-agents/top-10.prompt.md               # parallel_dataset (top {{row_limit}} rows) → top-10.csv (columns: company_name, product_name, website, hq_country, funding, one_liner); processor core
coding-agents/companies/_each/people.prompt.md     # foreach top-10.csv → <slug>/people.md (parallel_search/extract)
coding-agents/companies/_each/direction.prompt.md  # foreach → <slug>/direction.md (blogs/changelogs last 6 months; parallel_research processor base)
coding-agents/companies/_each/icp-fit.prompt.md    # foreach → <slug>/icp-fit.md (reads people.md, direction.md, /context/icp.md, /context/company.md; no web)
coding-agents/icp-ranking.prompt.md          # fan-in: companies/*/icp-fit.md → icp-ranking.md (ranked table + top pick + target person); export: [pdf]
coding-agents/outreach/sequence.prompt.md    # reads icp-ranking.md + top pick's people.md + company.md → sequence.md (3 emails)
coding-agents/outreach/send-drafts.action.md # GMAIL_CREATE_EMAIL_DRAFT ×3 (to the user's own address var for safety) + LINEAR_CREATE_LINEAR_ISSUE
coding-agents/companies/<slug>/deep-dives/   # created during demo via `ensemble new`
```

`vars.demo_recipient` defaults to the user's own email, so drafts are never addressed to real prospects in the demo. The README documents this.

**Demo script** (`docs/demo-script.md`, ≤ 2 min). Pre-run the expensive steps before recording, and disclose any time-lapse.

1. (0:00) Show the workspace tree and a prompt file. Run `ensemble dev`, which opens the graph UI.
2. (0:15) Show the graph already computed: top-10 → 10 fan-out instances → ICP ranking → sequence → action awaiting approval.
3. (0:30) **Live cascade:** edit `context/icp.md`, for example "must have a public changelog". All 10 `icp-fit` nodes turn amber, then `icp-ranking` and `sequence`. `people`/`direction` stay green (no wasted research), and the action is re-planned.
4. (1:00) Watch the runs stream with tool calls. *Speed up the footage and disclose it on screen.*
5. (1:20) Add a row to `top-10.csv`. Only the new company's chain runs.
6. (1:35) Approvals inbox: review the 3 email drafts and the Linear ticket, then approve. The receipt shows the real Gmail draft ids and the Linear issue URL. Show Gmail drafts and Linear briefly.
7. (1:50) Open `coding-agents/AGENTS.md` (auto-updated) and `exports/…/icp-ranking.pdf`. Run `git log --oneline` to show the per-run commits.

On-screen disclosure: "Drafts are created but not sent; recipients are my own address; footage sped up; research cached from the pre-run where marked ‘cached’."

---

## 17. Code architecture (tool repository)

Single package, ESM, `"type": "module"`. tsconfig uses `"module": "ESNext", "moduleResolution": "Bundler", "target": "ES2022", "strict": true`. Do not use `NodeNext`: it silently breaks the `@cline/sdk` typings. Run the code with `tsx` in dev, and build with `tsup` for the bin. Use pnpm.

```
ensemble/
├── package.json            # bin: { ensemble: dist/cli.js }; engines node >=22.22.3
├── src/
│   ├── cli.ts                      # commander wiring
│   ├── config.ts                   # ensemble.yaml + .env loading, zod schemas
│   ├── workspace/
│   │   ├── discover.ts             # find prompt/action files, ignore rules
│   │   ├── frontmatter.ts          # gray-matter + zod schema, templating (handlebars)
│   │   ├── fanout.ts               # foreach source readers (csv/json/glob), keys
│   │   ├── paths.ts                # resolution rules R-L2, globbing (fast-glob, picomatch)
│   │   └── hashing.ts              # file hash cache, canonical JSON, fingerprint
│   ├── graph/
│   │   ├── build.ts                # nodes, edges, ownership, cycles
│   │   ├── state.ts                # state.json store, node status computation
│   │   └── scheduler.ts            # queue, concurrency, gating, debounce, cron (croner)
│   ├── watcher.ts                  # chokidar v4
│   ├── runner/
│   │   ├── Runner.ts               # interface: run(node, ctx) → RunOutcome (enables FakeRunner in tests)
│   │   ├── ClineRunner.ts          # ClineCore session lifecycle (§9)
│   │   ├── contract.ts             # run contract + system addendum rendering
│   │   ├── auth.ts                 # provider/model/auth resolution (§9.4)
│   │   ├── guard.ts                # write guard hook + pre/post diff
│   │   └── tools/
│   │       ├── ensemble.ts         # ensemble_complete, ensemble_note, propose_action_step
│   │       ├── parallel.ts         # §10 tools
│   │       └── composio.ts         # §11.2 dynamic tools
│   ├── integrations/
│   │   ├── parallel/client.ts      # SDK wrapper, polling, cache, price table
│   │   └── composio/{backend.ts, sdk.ts, cli.ts}
│   ├── actions/
│   │   ├── plan.ts                 # plan json/md read/write, schema validation
│   │   └── execute.ts              # deterministic executor, refs, idempotency, receipts, dry-run
│   ├── librarian/
│   │   ├── index.ts                # deterministic block builder
│   │   ├── summarize.ts            # LLM summaries with cache
│   │   └── agentsmd.ts             # managed-block merge (preserve user text), CLAUDE.md shim
│   ├── git.ts                      # simple-git queue, snapshot + run commits
│   ├── export/pdf.ts               # markdown-it + playwright
│   ├── server/
│   │   ├── api.ts                  # Hono routes + SSE
│   │   └── bus.ts                  # typed event bus (daemon-wide)
│   └── daemon.ts                   # composition root for `ensemble dev`
├── ui/                             # Vite + React + @xyflow/react + dagre; built into dist/ui
├── templates/                      # init stubs, SKILL.md, root AGENTS.md section, print CSS
├── examples/coding-agents-icp/
├── deck/deck.md                    # Marp; `pnpm deck` → deck/deck.pdf
├── docs/{demo-script.md, research/*}
├── test/                           # vitest
├── README.md  LICENSE (MIT)  .env.example
```

Dependencies, pinned exact where marked:

- `@cline/sdk@0.0.95` (exact), `zod@^4`
- `parallel-web@1.3.5`, `@composio/core@0.25.0`
- `gray-matter`, `handlebars`, `fast-glob`, `picomatch`, `chokidar@^4`, `papaparse`, `simple-git`, `croner`, `hono`, `@hono/node-server`, `commander`, `dotenv`, `ulid`, `markdown-it`, `playwright`, `yaml`, `picocolors`
- UI: `react`, `react-dom`, `@xyflow/react`, `@dagrejs/dagre`, `react-markdown`, `remark-gfm`, `vite`
- Dev: `typescript`, `tsx`, `tsup`, `vitest`, `@marp-team/marp-cli`

### 17.1 Testing strategy

- **Unit tests (vitest)** for:
  - frontmatter parsing and templating,
  - path resolution and escape prevention,
  - fan-out expansion and keys,
  - graph build (edges, ownership conflicts, cycles),
  - fingerprint stability (changing `mode` or `description` does not change it; changing input content does),
  - scheduler ordering and gating, using a **FakeRunner** that writes deterministic outputs,
  - managed-block merge (user text preserved),
  - plan ref resolution and idempotency,
  - the CLI-backend JSON parsing, including the failure cases.
- **Scheduler scenarios with FakeRunner:**
  1. Diamond dependency: runs once, in order.
  2. A fan-out source gains a row: exactly one instance runs, then the fan-in node.
  3. Input changes mid-run: the node requeues once.
  4. Upstream failure blocks downstream.
  5. A manual edit of an output makes the node `modified` and the downstream stale.
  6. Concurrency cap respected.
  7. Expansion over `fanout_confirm_over` waits for approval.
- **Integration with a mock LLM:** an OpenAI-compatible mock server (see `research-cline.md` §3b, which verified this pattern) with `llm.provider: openai-compatible`. It scripts tool calls (`editor` writes and `ensemble_complete`), so ClineRunner, the guard and the contract are tested end to end without spending money. Parallel and Composio are mocked at the client interface.
- **Live smoke test (manual, documented):** `ensemble doctor`, then run `examples/coding-agents-icp` with `--var row_limit=3` to keep costs low.

---

## 18. Milestones (build order) and acceptance criteria

Work through these in order. Every milestone ends with green tests and a short note added to `docs/progress.md`.

**M0: Spikes (≤ 1 h, before writing the architecture).** Record the results in `docs/spikes.md`.

| Spike | Question |
|---|---|
| S1 | Does `ProviderSettingsManager().getProviderConfig("cline")`, passed to `cline.start`, run a 1-iteration session using the stored Cline OAuth login? Do we need `CLINE_API_KEY`? List valid Cline model ids with `Llms.getModelsForProvider("cline")`. |
| S2 | Do `config.rules` injection and `hooks.beforeTool` skip work in ClineCore 0.0.95 as assumed? Does `config.toolPolicies: {run_commands:{enabled:false}}` remove the tool? |
| S3 | Composio: is `COMPOSIO_API_KEY` (ak_) available? If not, confirm the CLI backend can create a Gmail draft (`composio link gmail`, then `composio execute GMAIL_CREATE_EMAIL_DRAFT --dry-run` and then for real to the user's own address, **only with the user's OK**). Check whether `composio upgrade` (0.2.32 → 0.4.5) changes the output shapes. |
| S4 | Parallel: is `PARALLEL_API_KEY` set? Make one `search` call with `mode: "fast"` (≈$0.001) and confirm the response shape. |

**M1: Core model.** Config, discovery, frontmatter and templating, paths, fan-out, graph, fingerprints, state store, `status`/`graph`/`run --dry-run` commands with FakeRunner.
- Accept: the example workspace parses, `ensemble graph --mermaid` shows the expected DAG, and all scheduler scenarios pass.

**M2: Cline runner and Parallel tools.** ClineRunner, run contract, guard, `ensemble_complete`, the Parallel tools with polling and cache, run logs, and `ensemble run <prompt>`.
- Accept: `top-10.prompt.md` produces a valid CSV with a sources sidecar. Running it again without changes is a no-op. Changing the prompt body reruns it.

**M3: Daemon.** Watcher, scheduler loop, cron, git commits (snapshot and run), `ensemble dev` (API only).
- Accept: editing `context/icp.md` reruns exactly the `icp-fit` instances, then ranking, then sequence, and each run produces one commit.

**M4: Actions and Composio.** Both backends, `connect`, `doctor`, planning runs, the plan file, approve/reject, the executor with refs, idempotency, receipts and dry-run.
- Accept: `send-drafts.action.md` plans, waits, and after `ensemble approve` creates 3 real Gmail drafts plus 1 Linear issue. Re-approving the same plan skips every step.

**M5: Librarian.** Deterministic index, summaries cache, CLAUDE.md shim, root section, skills.
- Accept: every directory has an AGENTS.md, user text outside the markers survives regeneration, and AGENTS.md writes never trigger runs.

**M6: Web UI.** Graph, drawer with live stream, approvals inbox, activity feed, SSE.
- Accept: the demo steps in §16 can be performed entirely from the UI plus an editor.

**M7: Export, README, deck, demo script, polish.**
- Accept: PDF exported. A fresh clone works by following the README (install → `ensemble init --example` → `ensemble doctor` → `ensemble dev`). The deck renders.

## 19. Stretch goals (only after M7)

- Composio triggers to inbox files (§11.4).
- Parallel Monitor API as a node type (`monitor:` frontmatter that writes new events into a file, polled with `client.monitor.events`).
- `ensemble new --from-description` (if not done in M1).
- A file-browser view in the UI.
- Git-worktree isolation for parallel runs that touch overlapping read sets (not needed with single-owner outputs).
- A tidy report: orphaned outputs, unreferenced files, misplaced files, as a read-only list.

---

## 20. Hackathon deliverables

1. **Public GitHub repo** `ensemble` (MIT), containing:
   - a README with: one-paragraph pitch, a GIF or screenshot of the graph UI, an architecture diagram (mermaid), prerequisites (Node ≥ 22.22.3, pnpm, `cline auth` or `CLINE_API_KEY`, `PARALLEL_API_KEY`, Composio login or `COMPOSIO_API_KEY`, `npx playwright install chromium`), quickstart commands, the prompt file reference, an explanation of fan-out, the action safety model, expected costs for the example, and a **"what's real vs simulated"** section;
   - `.env.example`.
2. **Deck:** `deck/deck.md`, Marp, 5 slides, rendered to `deck/deck.pdf` and linked from the README.
   1. The problem: research → synthesis → action in agent workspaces rots (stale AGENTS.md, lost prompts, manual reruns).
   2. Who it helps: GTM, research and ops people who run their work through coding agents in a "context monorepo".
   3. What we built: prompts-as-files, a reactive dependency graph, fan-out, approved actions, a self-maintaining AGENTS.md.
   4. How it works: an architecture diagram of the watcher → graph → Cline SDK sessions with Parallel and Composio tools → git and the UI.
   5. Demo highlights and what's next.
3. **Demo video:** the user records it. Provide `docs/demo-script.md` (§16) with the disclosure text.

## 21. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `@cline/sdk` 0.0.x API drift or docs mismatch | Pin `0.0.95`. Keep everything behind the `Runner` interface. Run the M0 spikes. CLI fallback: `cline --json -c <ws> --auto-approve true -t <secs> "<contract>"`, then parse `run_result` (see research notes §13). |
| Cline OAuth reuse not supported in the SDK | Require `CLINE_API_KEY`, or switch `llm.provider` to `anthropic`, a config-only change |
| Composio SDK vs CLI project split confuses connections | `doctor` prints the active backend and connected toolkits. `ensemble connect` always uses the active backend. The README explains the split. |
| Deep research latency (minutes) hurts the demo | Default the processors to `base`/`core` in the example, use the cache, pre-run, and time-lapse with disclosure |
| Cost blow-ups from fan-out | `fanout_confirm_over`, processor caps, `budget_usd` per run, and a cost counter in the UI |
| Agent writes outside outputs | `beforeTool` guard plus a post-run diff warning |
| Rerun storms from librarian writes or self-writes | AGENTS.md is excluded from inputs, staleness is fingerprint-based, and the debounce window absorbs bursts |
| LinkedIn and other logged-in data unavailable | State the limitation. Prompts ask for public signals only. |

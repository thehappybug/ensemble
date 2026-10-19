# Milestone 0 spikes — 2026-10-19

All live checks are bounded smoke tests; no deep research or external writes are authorized.

- **S1 / Cline auth:** `CLINE_API_KEY` is present in the workspace `.env`; secrets were not printed. Network restriction prevents a live provider call/model catalogue verification. Use the explicit API-key route from §21; An isolated copy of the stored OAuth config resolves to an API-key shape; remote use/refresh remain unverified. The cached catalogue lists 316 IDs including `anthropic/claude-sonnet-5.5`. The provider manager mutates its storage on construction, so auth reuse must read an isolated copy, never the original global state. Reproducible probe: `node scripts/spike-cline.mjs`.
- **S2 / rules, guard, policies:** three actual pinned ClineCore mock sessions passed. `config.rules` is absent with a custom system prompt: prepend the AGENTS chain. Top-level policies replace config policies: place approval and disabled tools together top-level. `localRuntime.hooks` successfully skips a forbidden editor write; use `context.tool.name` or `toolCall.toolName`. Typed extra tools belong in `localRuntime.extraTools`. See `spike-cline.md`.
- **S3 / Composio:** the supplied key is `ck_`, not a project `ak_`; `auto` therefore selects CLI. CLI 0.2.32 is installed. Read-only connection/schema calls cannot reach the service. No links, upgrades, drafts, tickets or posts were created. See `spike-composio.md`. Both backends will be implemented; mock tests cover execution until explicit live approval.
- **S4 / Parallel:** `PARALLEL_API_KEY` is present. Network access is blocked, so no billed search was made. Source-verified 1.3.5 response shape is used; the doctor command offers a separately requested fast-search smoke check.

## Environment constraints

The sandbox mounts `.git` read-only; `git init` fails with `Read-only file system`. Implementation history uses `git --git-dir=.ensemble-git --work-tree=.` locally. This alternate metadata is ignored and is not part of distribution. Normal `git init` remains the default for user workspaces. npm DNS requests fail (`EAI_AGAIN`); broader-access installation was rejected by the automatic permission policy. Offline package caches are used where available. These constraints do not justify substituting simulated success for a live integration result.

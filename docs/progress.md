# Implementation progress

## M0 — spikes

Pinned package scaffold created; existing credentials inspected by presence/prefix only. Cline API-key fallback selected pending live OAuth verification. Composio CLI fallback selected because the key is `ck_`. Network and read-only git mount constraints recorded in `spikes.md`; no external side effects or paid research performed. Mock/source verification continues in the reproducible spike scripts.

## M1 — core model

Implemented config/schema validation, discovery and ignore rules, strict templating, safe paths including symlinks, CSV/JSON/glob fan-out, ownership/cycle validation, per-item fingerprints, atomic state, scheduler and read-only CLI commands. Complete ungenerated example workspace parses, including pending fan-out/fan-in edges. All 20 Vitest tests pass, including all seven scheduler acceptance scenarios; strict TypeScript passes. Cached real packages enabled offline verification. A native RFC4180 CSV parser replaces PapaParse at runtime because that package is absent offline; it rejects malformed headers/rows and has quoting tests. Run IDs use native UUIDs. Action receipt ownership is reserved but planning requires only the two plan files.

M1 follow-up: init/new/clone commands added, with output ownership preserved when cloning across directories. The Cline spike is now part of the test suite. All 23 tests and strict TypeScript pass. Child-process spike reports are read from an explicit report file because SDK logging can suppress console stdout in a test worker.

## M2 — Cline runner and Parallel

Real pinned ClineCore sessions now power `ensemble run`, with isolated state/auth copies, AGENTS-chain fallback injection, strict completion/output checks, write guard, post-run audit (including failures), timeout/budget aborts and streamed run logs. All six Parallel tools implement SDK calls, cached/persisted async requests, processor caps, abortable polling, dataset CSV and citation sidecars, Task Groups and FindAll. All 42 Vitest tests and strict TypeScript pass, including 11 real-Cline/mock-SSE tests and eight Parallel tests using injected clients/real-SDK fetch. Offline esbuild produced a working CLI bundle. Live research/provider acceptance remains unverified because external network is restricted; no paid research was substituted with claimed live success.

## M3 — daemon, watcher, git

Added localhost Hono API/SSE, exclusive daemon lock and CLI forwarding, watcher-driven scheduling, cron ticks, run abort/pause/resume, file privacy checks and lineage/log commands. Every successful run snapshots changed inputs/prompt and commits only owned outputs through a serialized git queue, preserving unrelated staged changes. Explicit `dev --simulate` uses labeled synthetic outputs and forces dry-run actions; production defaults remain Cline/Parallel. All 58 Vitest tests and strict TypeScript pass. The full example cascade is verified with real git history: 10 initial runs, five ICP-only reruns, six new-row downstream runs; prior research stays fresh and hand edits survive. Native recursive watcher and a validated standard five-field cron parser serve as documented offline fallbacks. HTTP routes/SSE were verified in-process; the sandbox denies listening sockets, so a live browser/daemon check remains pending outside it.

## M4 — approved actions and Composio

Implemented SDK and CLI backends with project/consumer separation, strict response parsing, read-only agent tools, schema-validated proposals, human-readable plans, exact-checksum approvals, JSON edits, rejection, deterministic references, append-only receipts and resumable idempotency. Dry-run/simulated receipts never suppress later real execution; uncertain transport outcomes require inspection/force. Demo recipients and all draft steps are preflighted before any write; sends and extra recipients are prohibited in demo mode. CLI/API approval/connect/doctor flows are wired. Full suite reached 85 passing tests; the final receipt-replay regression raises actions tests to nine, all green, with strict TypeScript passing. No real drafts/tickets/posts were created; live API authorization was subsequently granted, but the retry still failed at the network boundary. Real action acceptance waits for reachable services and the user's own demo address/account links.

## M5 — self-maintaining context

Added deterministic AGENTS.md indexes, preserved user sections/malformed-file safeguards, missing-only CLAUDE.md shims, file/producer/status/dependency tables, root guidance and directory links. Tool-less one-iteration librarian summaries batch up to 20, use content-hash caches, sample large files, exclude secrets/assets, track usage and cache failure fallbacks to avoid repeat billing. `init` installs identical discoverable authoring skills and indexes without an LLM; daemon indexes after five idle seconds, and CLI/API indexing serializes per workspace. Skill validation passes. All 104 tests and strict TypeScript pass. Git selection is batched to keep real initialization and per-run commits fast while preserving unrelated staging.

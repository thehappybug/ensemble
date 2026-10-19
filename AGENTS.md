# Ensemble — implementation repo

You are implementing **Ensemble**. Read these before writing any code:

1. `SPEC.md`: the authoritative requirements and technical spec. Interview decisions are in §3, and the build order with acceptance criteria is in §18.
2. `docs/research/research-cline.md`, `research-parallel.md` and `research-composio.md`: verified SDK and CLI details, with snippets and gotchas.
3. `docs/research/cline-runner-example.ts`: a typechecked ClineCore runner skeleton to start from.
4. `prompt.md`: the user's original problem statement.

Rules:
- Start with the Milestone 0 spikes (SPEC §18) and record the results in `docs/spikes.md`.
- Pin `@cline/sdk@0.0.95` exactly. Use `moduleResolution: "Bundler"` and ClineCore `backendMode: "local"`.
- Never send email or post messages without explicit user confirmation. Demo actions create drafts addressed to the user's own address.
- Log progress per milestone in `docs/progress.md`.

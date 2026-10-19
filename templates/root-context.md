## How this workspace works

Ensemble treats `*.prompt.md` files as repeatable research or synthesis steps.
YAML frontmatter declares inputs and outputs; the body holds the task. To create
a new research step, write a prompt file instead of doing ad hoc research when
the work should be repeatable. `*.action.md` files produce reviewable plans;
external writes run only after explicit approval of the exact plan.

Paths resolve relative to each prompt; `/context/company.md` refers to this
workspace's root. Keep company, ICP, and team facts in `context/`; PDF exports go
in `exports/`, and ignored runtime state lives in `.ensemble/`. Keep credentials
in ignored `.env` or the environment. Do not move or delete user files.

Use `ensemble status --json` to inspect freshness, `ensemble graph --mermaid` to
inspect dependencies, and `ensemble run <prompt> --dry-run` to preview work.
Use `ensemble run <prompt>` within the user's execution and cost authorization.
`ensemble clone <prompt> [new-path]` preserves lineage for variants. The local
Ensemble skill has complete examples for authoring prompts, fan-out, fan-in,
scheduled reads, and actions. Managed AGENTS.md blocks describe the current
workspace; preserve user text outside them.

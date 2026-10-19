---
name: ensemble
description: Create and revise repeatable research, synthesis, scheduled reads, and approved action files inside an Ensemble workspace marked by ensemble.yaml.
---

# Work in an Ensemble workspace

Read the nearest AGENTS.md and `ensemble.yaml` before authoring a step. Keep
company, ICP, and team facts in `context/`. For work that should be repeatable,
write a `*.prompt.md` beside its outputs rather than doing research ad hoc.
Existing user instructions and authorization still apply; authoring a file does
not grant permission to spend money or execute external actions.

Inspect `ensemble status --json` and `ensemble graph --mermaid` to find producers
and reuse existing research. Declare every input and output. Each output has one
owner; avoid names already produced by another prompt. Never move or delete user
files to tidy the workspace.

Paths resolve relative to the prompt file. A leading `/` means the workspace
root, not the machine root; `..` may not escape the workspace. Inputs can use
globs, directories, or an optional `?` suffix. Outputs must be concrete paths
after rendering. `context/`, `exports/`, and `.ensemble/` are reserved;
`.ensemble/` holds ignored runtime state. Keep credentials in ignored `.env` or
the environment, never in prompt files or `ensemble.yaml`.

Frontmatter requires a nonempty `outputs` list for prompts. Common optional
fields are `description`, `inputs`, `mode: auto|manual`, `tools`, `vars`, `model`,
`timeout: 20m`, `budget_usd: 1`, `parallel.max_processor`, and `incremental: true`.
`export: [pdf]` is reserved metadata; application PDF rendering is deferred.
`mode` defaults to auto. `schedule` is a cron expression;
it marks a prompt stale but still respects manual mode. Tools default to
Parallel search/extract; use `parallel: []` for synthesis. Shell is opt-in and
guarded. AGENTS.md and CLAUDE.md are maintained context, not prompt inputs.

Templates use strict Handlebars without HTML escaping: unknown variables fail.
Workspace variables appear as `vars.name` and `name`; prompt `vars` override
them. A fan-out item appears under `foreach.as`, with `_key` and `_index`.
Available helpers are `slugify`, `today` (YYYY-MM-DD), `json`, `lower`, and
`upper`; `prompt.path`, `prompt.dir`, and `workspace.root` are also available.

The following examples form a small connected graph. The fan-out source
`research/companies.csv` is a hand-written CSV with a `company_name` column;
`context/icp.md` and `context/team.md` are source context files. Adapt these
inputs to the user's actual workspace.

### `research/overview.prompt.md`

```markdown
---
description: Research the public API landscape
inputs: [/context/icp.md]
outputs: [overview.md]
tools:
  parallel: [search, extract]
  shell: false
mode: manual
---
Research public API products relevant to the current ICP as of {{today}}.
Write research/overview.md with inline citations, a Sources section, and explicit
unknowns. Use public sources only and call ensemble_complete after writing.
```

### `research/companies/_each/people.prompt.md`

```markdown
---
description: Find publicly documented leaders per company
foreach:
  from: ../../companies.csv
  as: company
  key: "{{slugify company.company_name}}"
inputs: []
outputs: ["../{{company._key}}/people.md"]
tools:
  parallel: [search, extract]
  shell: false
---
Find product and engineering leaders at {{company.company_name}}. Write
research/companies/{{company._key}}/people.md using public evidence with citations.
Do not invent identities or private contact details. Call ensemble_complete.
```

### `research/ranking.prompt.md`

```markdown
---
description: Synthesize the researched companies against the ICP
inputs:
  - overview.md
  - companies/*/people.md
  - /context/icp.md
outputs: [ranking.md]
tools:
  parallel: []
  composio: []
  shell: false
---
Rank the researched companies using only the declared evidence and current ICP.
Write research/ranking.md with a ranked table, citations, and confidence. Label
missing evidence. Write only the declared markdown output. Call ensemble_complete.
```

Fan-out expands CSV rows, a JSON array (or object with one array field), or a
glob into independent instances. A directory glob ends in `/`. Keep instance
outputs keyed by `_key`; do not copy the entire list into each instance's inputs
unless every row should invalidate every instance. A fan-in input glob waits for
all declared producers, including outputs not yet written. Parallel dataset
tools also write `<output_path>.sources.json`; explicitly declare that sidecar
as an output when using `parallel_dataset`.

### `research/outreach/drafts.action.md`

```markdown
---
description: Plan a Gmail draft for explicit approval
inputs: [../ranking.md, /context/team.md]
tools:
  parallel: []
  composio: [GMAIL_CREATE_EMAIL_DRAFT]
  shell: false
plan: manual
---
Prepare one Gmail draft to {{demo_recipient}} using the reviewed ranking.
For this demo the recipient must be the operator's own email address. Refuse
the example.com placeholder. Propose the exact subject, body, recipient_email,
and is_html=false with propose_action_step. Never create or send email during
planning. Call ensemble_complete when the plan is ready for review.
```

Actions have implicit `.plan.json`, `.plan.md`, and `.receipt.json` outputs;
do not add `outputs` or use prompt `mode`. `plan: auto|manual` controls replanning
only. Read-only allowlisted Composio tools may run during planning; writes are
proposed with `propose_action_step`. Earlier results may be referenced inside
step args with `{{steps.draft_1.data.id}}`; these references belong in the JSON
plan, not unescaped prompt templates. Never execute writes from a planning tool
or shell. Approval always belongs to the user and the exact reviewed plan.

Run `ensemble plan research/outreach/drafts.action.md` when planning is authorized.
Show the exact JSON and readable plan to the user. Only after explicit approval
use `ensemble approve research/outreach/drafts.action.md`; `--dry-run` records
simulated results and is not real execution. User approval of a simulation does
not authorize a later real execution. A changed plan or changed inputs requires
fresh review. Demo actions create drafts only, addressed to the operator; no
email sending or scheduling.

### `context/calendar/refresh.prompt.md`

```markdown
---
description: Refresh the next seven days of calendar events
inputs: []
outputs: [events.md]
schedule: "0 9 * * 1-5"
tools:
  parallel: []
  composio: [GOOGLECALENDAR_EVENTS_LIST]
  shell: false
---
Use the read-only calendar tool to list the next seven days from {{today}},
using RFC3339 UTC bounds, calendarId primary, singleEvents true, and orderBy
startTime. Write context/calendar/events.md with times and source links. Do not
create or modify events. Call ensemble_complete after writing.
```

Before running, inspect `ensemble run <path> --dry-run`; this previews the graph
work without running agents. Use `ensemble run <path>` only within the user's
authorization for execution and cost. `ensemble clone <prompt> [new-path]`
creates an iteration with `derived_from` lineage and distinct output paths;
edit the clone rather than overwriting the original when preserving a variant.
Check `ensemble status --json` again after changes. Hand-edited generated outputs
are preserved as modified; accept the edit or explicitly force a rerun rather
than silently discarding the user's work. `ensemble explain <file>` traces its
producer, inputs, and run history.

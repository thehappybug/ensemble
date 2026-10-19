# Coding-agent ICP workspace

This complete input workspace researches coding-agent companies for the fictional
Acme API Tools. It ships without research results, action plans, receipts, or PDFs.
The root repository README explains installation and credentials.

Before a live run, set `vars.demo_recipient` in `ensemble.yaml` to **your own
connected Gmail address**, and `vars.linear_team_key` to a team in your own Linear
workspace. `you@example.com` is a deliberate unusable placeholder. Never use a
prospect's address for this demo. Keep secrets in the environment or an ignored
`.env`, never in the YAML or context files.

Run commands from this directory using your installed `ensemble` binary. Inspect
the graph with `ensemble graph --mermaid` or `ensemble dev`. Start with a
separately approved live run using `--var row_limit=3`; ten rows are the full
demo. A core dataset task plus one base direction task per company and the
people searches incur Parallel charges; every research, synthesis, and librarian
session also incurs model charges. Per-run `budget_usd` limits model cost, not
the total workspace or Parallel cost. Check the root README's cost estimates
before pre-running; a cached rerun avoids identical Parallel requests.

The graph is dataset → people/direction per company → ICP fit per company →
ranking → three-email sequence → action plan. Changing `context/icp.md` reruns
the fit reports, ranking, and sequence while preserving the people and direction
research. Adding a CSV row creates only that company's new research chain before
the fan-in synthesis updates. Both the CSV and its citation sidecar are owned by
the dataset prompt.

Review the action in the approvals inbox before approving. Execution creates
three Gmail **drafts** addressed to you and one Linear issue in your workspace;
it never sends email. Use dry-run approval to simulate the external writes.
Read the root README's "what's real vs simulated" section before recording.

Public profiles are limited to accessible web pages. The prompts explicitly
label missing or uncertain identities, headcount, funding, and LinkedIn data.
The example company and team are fictional; actual research and connected
service actions require your credentials and consent.

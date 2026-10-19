# Ensemble — two-minute recording script

Record a real workspace from `examples/coding-agents-icp/`, or clearly disclose
`--simulate` throughout. The repository's graph image uses synthetic data; it is
an actual component rendering, not evidence of a live integration run.

## Before recording

1. Follow the root [README](../README.md) on a machine with network, localhost
   sockets, and browser process permissions. Run `pnpm install` and `pnpm build`. The implementation sandbox could not
   complete live provider/research checks or a browser session.
2. Initialize a separate real demo workspace. Put keys in its ignored `.env`.
   Prefer `CLINE_API_KEY` until a live OAuth smoke verifies stored-login reuse.
   Check the chosen model through `ensemble doctor`; do not guess model IDs.
3. Confirm `ensemble doctor` reports the intended Composio backend and connected
   Gmail/Linear accounts. Existing connections should be reused. CLI consumer
   and SDK project connections are separate. Link missing accounts only through
   `ensemble connect gmail linear` using the active backend.
4. Set `vars.demo_recipient` to your own connected Gmail address and
   `vars.linear_team_key` to your own Linear team. Never put your private address
   into the public example files. Review the fictional company/team context.
5. Review expected costs. Persist `row_limit: 3` for a small smoke run; use 10 for
   the full recording. A one-off `run --var` does not change daemon defaults.
   `doctor --smoke-parallel` requests one fast search; it is not a full pipeline.
6. Pre-run the expensive research **with your approval for the spend**, leaving
   the action awaiting approval. Do not create/send/post anything as part of
   preflight unless separately authorized. Inspect citations, CSV shape,
   `top-10.csv.sources.json`, company reports, and the ranking. Verify that the
   result describes actual research rather than SIMULATED preview content.
7. Start `ensemble dev --paused`, open the UI, and verify graph, node drawer,
   logs, history, approvals, and file links. Keep the editor beside it. PDF
   export and the rendered deck are deferred at the user’s request. For a
   deterministic preflight, disable
   `agents_md.summaries`; pausing prompt scheduling alone does not disable them.
8. Prepare one additional **verified** CSV row with all six columns. Verify its
   company slug is new. Adding it during recording initiates new research; allow
   that spend in advance. Do not use fabricated company facts in a claimed live
   research demo.
9. Review the pending plan's three complete Gmail bodies, own-address recipients,
   and exact Linear team/owner. Check no sends, CC/BCC, or real prospect addresses
   appear. Only an explicit approval of that exact plan may create drafts or a
   ticket. Dry-run receipts never count as proof of real writes.

## Recording timeline — 1:59

| Time | Screen and action | Suggested narration |
| --- | --- | --- |
| 0:00–0:15 | Show the workspace tree and `top-10.prompt.md` in the editor, then the local graph UI. | “My prompts and context are files. Ensemble connects their inputs and outputs into a live workspace.” |
| 0:15–0:30 | Show the already researched graph: dataset → company fan-out → fit/ranking → sequence → approval. Expand a company group and open its prompt/inputs drawer. | “Research runs once per company. Synthesis builds on those results, and actions wait here for my review.” |
| 0:30–1:00 | In `context/icp.md`, add **“Must have a public changelog.”** Resume auto-run in the UI. Show the stale wave across all fit instances, ranking, sequence, and action planning. People/direction stay green. | “Changing our criteria refreshes only the dependent work. We reuse the people and product research.” |
| 1:00–1:20 | Open a running node's Live tab; show text, expandable tool calls, cache indicators when present, then a completed output/diff. Speed up waiting footage with a visible disclosure. | “The run stream shows what the agent is doing, and the output stays beside the prompt that produced it.” |
| 1:20–1:35 | Append the prepared verified CSV row in the editor. Show just the new company chain running, then downstream ranking/sequence updates. Existing companies stay fresh. | “Adding a company expands the workflow. Existing research is preserved.” |
| 1:35–1:50 | Open Approvals. Review To/Subject/Body for all three drafts and the Linear ticket, then explicitly click **Approve**. Show the real receipt and briefly Gmail drafts/Linear in their own tabs. | “I approve this exact plan. Ensemble creates drafts to my own address and a ticket in my workspace. No email is sent.” |
| 1:50–1:59 | Open `coding-agents/AGENTS.md` and the ranking markdown through Files. Show per-run commit hashes in History; briefly show `git log --oneline` in an existing terminal if time permits. | “Context stays current, the report stays with its prompt, and every run has a git record.” |

All workspace changes and approvals can be demonstrated in the web UI plus an
editor. The git terminal shot is optional: commit hashes are visible in History.
The shell command to start the daemon is setup, not a required mid-demo action.

The six-column CSV header is:

```csv
company_name,product_name,website,hq_country,funding,one_liner
```

Appending a row manually marks the dataset `modified`; downstream instances use
the edited data. Do not force the dataset producer during this step, which would
replace the edit. A first-ever large expansion may require a separate fan-out
approval; approve the exact count in the inbox before the recording if needed.

## On-screen disclosure

For the real recording, keep this text visible where appropriate:

> Drafts are created but not sent; recipients are my own address; footage sped
> up; research cached from the pre-run where marked “cached”.

Show “Research pre-run before recording” at the initial graph. Mark every sped-up
segment. Cache badges describe actual cache hits, not all pre-run research.
PDF export is omitted from this recording; rendering was deferred at the user’s
request.

For an entirely offline preview, use **`ensemble dev --simulate`** in a separate
workspace and keep **“SIMULATED: synthetic research and action receipts; no real
Gmail drafts or Linear ticket”** visible throughout. Do not show simulated IDs as
real provider results. Use “Approve simulation”/“Approve dry run” and omit the
claim that Gmail/Linear writes were verified.

## Finish the submission

The owner records/uploads the video and publishes the repository/deck URLs.
Repository creation or pushing requires the owner's approval. The included
[deck source](../deck/deck.md) is a local submission asset. Rendering its PDF is
deferred; this document does not claim that any public URLs have been created.

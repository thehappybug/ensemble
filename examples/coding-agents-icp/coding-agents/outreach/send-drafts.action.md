---
description: Plan three Gmail drafts to the operator and one Linear follow-up ticket
inputs:
  - sequence.md
  - ../icp-ranking.md
  - /context/team.md
tools:
  parallel: []
  composio:
    - GMAIL_CREATE_EMAIL_DRAFT
    - LINEAR_LIST_LINEAR_TEAMS
    - LINEAR_LIST_LINEAR_USERS
    - LINEAR_CREATE_LINEAR_ISSUE
  shell: false
plan: auto
---
Prepare an exact reviewable plan; never execute external writes while planning.
Read sequence.md, icp-ranking.md, and context/team.md. Refuse to produce write
steps if there is no qualified top pick or if {{demo_recipient}} still uses
example.com or is not the operator's own confirmed Gmail address. Explain the
required correction with ensemble_note. The operator must review and approve
this plan before any draft or ticket is created.

Use read-only team/user lookup tools to resolve Linear team key
{{linear_team_key}} in the operator's own connected workspace. Follow team.md
for the owner; omit assignee if it cannot be verified. If the required team
cannot be resolved, report the blocker rather than picking another team.
Use LINEAR_LIST_LINEAR_TEAMS and, when owner resolution is needed,
LINEAR_LIST_LINEAR_USERS. Their first/after inputs support pagination: continue
only when page_info.hasNextPage is true, using page_info.endCursor as after.
Inspect the populated teams/users collection if the response also contains
empty items or nested data wrappers. Match the configured team key against the
returned identifier/key; never substitute the first team in the response.

Propose exactly three GMAIL_CREATE_EMAIL_DRAFT write steps, one for each approved
email in sequence.md. Set recipient_email to {{demo_recipient}} in every step,
copy each reviewed subject and body, and set is_html false. Never use send,
schedule, or Slack tools. Then propose one LINEAR_CREATE_LINEAR_ISSUE with the
resolved team_id, a title such as "Follow up: <top company> outreach", and a
description explaining the demo and linking the three draft IDs using earlier
step references. Use the actual schema returned for each allowlisted tool.
Set a follow-up due date three days after {{today}} if supported by that schema.

Call propose_action_step for each exact step, including why it is needed. Gmail
draft results expose the draft ID at data.id. Use ordered step IDs draft_1,
draft_2, draft_3, and ticket. The executor resolves result references at approval
time; include references using the documented steps path syntax rather than
inventing IDs. Call ensemble_complete when the reviewable plan is complete.

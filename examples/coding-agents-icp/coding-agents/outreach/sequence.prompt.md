---
description: Draft a three-email sequence for the highest-ranked qualified prospect
inputs:
  - ../icp-ranking.md
  - ../companies/*/people.md
  - /context/company.md
outputs:
  - sequence.md
tools:
  parallel: []
  composio: []
  shell: false
mode: auto
---
Read coding-agents/icp-ranking.md and the top pick's people report from the
declared reports. Use context/company.md for the fictional {{my_company}}
positioning. Write coding-agents/outreach/sequence.md containing three short
email drafts: an introduction, a helpful technical follow-up, and a courteous
final follow-up. For each include an explicit Subject and Body, the intended
prospect persona, and the verified research signal behind the personalization.

The demo delivery address is {{demo_recipient}}, which must be the operator's
own Gmail address before real execution. Clearly label this as a demo override;
never discover or use a real prospect's email address. Do not send, schedule, or
create drafts here. Avoid invented ROI, customer references, or claims of a
relationship. Keep the source citations in a separate research notes section
outside the email bodies. If ranking has no qualified top pick, write a hold
recommendation with no actionable emails. Call ensemble_complete after writing.

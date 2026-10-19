---
description: Rank all researched companies and select a buyer for outreach
inputs:
  - companies/*/icp-fit.md
  - /context/icp.md
  - /context/company.md
outputs:
  - icp-ranking.md
tools:
  parallel: []
  composio: []
  shell: false
mode: auto
export: [pdf]
---
Read every declared company fit report and rank the candidates for
{{my_company}} using the current ICP. Write coding-agents/icp-ranking.md with a
title, date {{today}}, a ranked table (company, score, confidence, strongest
signal, key risk, target person), and a justified top pick. Link each row to its
local fit report and retain source citations for the key factual claims.

Include a clear "Top pick" section naming the company, its directory slug,
the selected person's name and title, and the relevant people.md path. Explain
why this person is the best outreach target. If no candidate satisfies the
required ICP, say so and recommend holding outreach; do not force a winner.
Do not browse or create new facts. The PDF export is produced by Ensemble from
the markdown, not by a shell command. Call ensemble_complete after writing.

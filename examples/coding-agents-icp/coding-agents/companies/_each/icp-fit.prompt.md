---
description: Score each company against the current ICP using existing research
foreach:
  from: ../../top-10.csv
  as: company
  key: "{{slugify company.company_name}}"
inputs:
  - ../{{company._key}}/people.md
  - ../{{company._key}}/direction.md
  - /context/icp.md
  - /context/company.md
outputs:
  - ../{{company._key}}/icp-fit.md
tools:
  parallel: []
  composio: []
  shell: false
mode: auto
---
Assess {{company.company_name}} ({{company.website}}) as a potential customer for
{{my_company}}. Read the declared people and direction reports and apply the
current context/icp.md criteria and context/company.md positioning exactly.
Use existing evidence only; make no web or research calls.

Write coding-agents/companies/{{company._key}}/icp-fit.md with a total score and
component scores, fit verdict, confidence, unmet criteria, and a recommended
target person with title and rationale. Link to the local research reports and
preserve their external citations for each factual claim. Missing criteria must
be marked unknown, not inferred into facts. If the ICP now requires a public
changelog, explicitly apply that requirement using the direction report.

End with one credible outreach angle tied to a verified prospect signal and
Acme's fictional capabilities. Do not invent email addresses or send anything.
Call ensemble_complete after writing.

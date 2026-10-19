---
description: Research six months of public product and API direction for each company
foreach:
  from: ../../top-10.csv
  as: company
  key: "{{slugify company.company_name}}"
inputs: []
outputs:
  - ../{{company._key}}/direction.md
tools:
  parallel: [research]
  composio: []
  shell: false
mode: auto
parallel:
  max_processor: base
---
Use parallel_research with processor "base" to examine the public product
direction of {{company.company_name}}, maker of {{company.product_name}}
({{company.website}}), during the six months ending {{today}}.

Write coding-agents/companies/{{company._key}}/direction.md. Ask the research tool
to prioritize dated official blogs, changelogs, API documentation, SDK
repositories, integration announcements, and release notes. Include:

1. A dated timeline of meaningful launches, with primary-source links.
2. Evidence of a public API and SDKs (languages, maintenance signals).
3. Whether a public changelog exists, with its exact URL or "not established".
4. Likely product priorities, clearly distinguished as inferences.
5. Gaps and uncertainties, including any unsupported size or funding claims.

Retain citations and the tool-generated Sources section. Do not treat a roadmap
guess as a company commitment. Write only the declared output and call
ensemble_complete after verifying the report.

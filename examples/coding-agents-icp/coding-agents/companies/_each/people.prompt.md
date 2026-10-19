---
description: Find public product and engineering leaders for each coding-agent company
foreach:
  from: ../../top-10.csv
  as: company
  key: "{{slugify company.company_name}}"
inputs: []
outputs:
  - ../{{company._key}}/people.md
tools:
  parallel: [search, extract]
  composio: []
  shell: false
mode: auto
---
Research product managers and VP/Head of Engineering at
{{company.company_name}}, maker of {{company.product_name}}
({{company.website}}). Use parallel_search and parallel_extract only. Start with
official leadership pages, product posts, changelogs, talks, and attributable
public profiles. Do not scrape logged-in or paywalled LinkedIn content.

Write a concise markdown report to
coding-agents/companies/{{company._key}}/people.md. Include a table of names,
current titles, relevant remit, public profile URLs (LinkedIn only when public),
known tenure, and one or two attributable public signals. Cite every claim with
a clickable URL and state the observation date {{today}}. Label unknown or
ambiguous identities and employment status explicitly. Never invent personal
email addresses, job history, quotes, or posts. End with a Sources section and
state public-web access limitations. Call ensemble_complete after writing.

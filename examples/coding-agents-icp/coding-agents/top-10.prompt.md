---
description: Build a cited dataset of the top coding-agent companies
inputs: []
outputs:
  - top-10.csv
  - top-10.csv.sources.json
tools:
  parallel: [dataset]
  composio: []
  shell: false
mode: auto
parallel:
  max_processor: core
---
Use parallel_dataset with processor "core" and row_count_hint {{row_limit}} to
find the top {{row_limit}} distinct companies making coding-agent applications
as of {{today}}. Prefer active products with official sites and independent
evidence of developer adoption. Explain the selection criteria in the dataset
query; do not claim an objective market ranking.

Write coding-agents/top-10.csv with exactly these columns in this order:
company_name, product_name, website, hq_country, funding, one_liner. Use string
columns; allow null for unverified hq_country and funding. One company per row.
Use canonical company websites. Cite evidence for factual fields and preserve
the tool's per-row basis in coding-agents/top-10.csv.sources.json. Both files are
declared outputs; never write any additional research artifact.

Use only public sources. Do not infer funding or headquarters from a product
name. Report fewer rows with an explicit completion note if reliable evidence
cannot support {{row_limit}} companies. Call ensemble_complete when both outputs
exist and the CSV header and citation sidecar have been checked.

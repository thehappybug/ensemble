---
marp: true
theme: default
paginate: true
size: 16:9
title: Ensemble — reactive agent workspaces
description: Prompts as files, a reactive dependency graph, and actions that wait for approval.
style: |
  section {
    background: #0d121b;
    color: #edf2fa;
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    padding: 68px 78px;
    font-size: 30px;
    line-height: 1.45;
  }
  h1 { color: #edf2fa; font-size: 62px; letter-spacing: -2.5px; line-height: 1.1; margin: 0 0 32px; }
  h2 { color: #a7edca; font-size: 36px; font-weight: 500; margin: 0 0 30px; }
  strong, a { color: #a7edca; }
  p, li { color: #c8d4e5; }
  li { margin: 12px 0; }
  code { background: #1d2b38; color: #c9f1df; border-radius: 5px; padding: 2px 8px; }
  pre { background: #141c28; border: 1px solid #354457; border-radius: 12px; padding: 28px; font-size: 23px; line-height: 1.55; }
  pre code { background: transparent; padding: 0; color: #d9e6f5; }
  blockquote { color: #99aabe; border-left: 4px solid #a7edca; padding-left: 22px; font-size: 24px; }
  section::after { color: #8192aa; font-size: 16px; }
  section.lead h1 { font-size: 96px; color: #a7edca; margin-bottom: 24px; }
  section.lead h2 { color: #edf2fa; font-size: 42px; }
  .eyebrow { color: #91adab; font-size: 18px; font-weight: 650; letter-spacing: 4px; margin-bottom: 26px; }
  .small { font-size: 22px; color: #91a2b9; }
  section.architecture pre { font-size: 21px; line-height: 1.3; padding: 22px 28px; }
  section.architecture .small { font-size: 21px; }
  section.demo { font-size: 28px; }
  section.demo li { margin: 10px 0; }
  section.demo .small { font-size: 20px; line-height: 1.4; }
---

<!-- _class: lead -->

<p class="eyebrow">REACTIVE AGENT WORKSPACES</p>

# Ensemble

## Your workspace changes. The work goes stale.

Research drifts. Prompts get lost. `AGENTS.md` falls behind.
Keeping research, synthesis, and action in sync becomes another job.

**A directory should remember how to update itself.**

---

<p class="eyebrow">WHO IT HELPS</p>

# A context monorepo for work

- **GTM:** companies, ICP fit, outreach, and follow-up.
- **Research:** repeatable questions with evidence and lineage.
- **Operations:** shared context, recurring inputs, reviewed actions.

These teams already work through coding agents.
Ensemble gives their files **dependencies, freshness, and an approval queue**.

---

<p class="eyebrow">WHAT WE BUILT</p>

# Prompts become a workflow

- `*.prompt.md` files declare their **inputs and outputs**.
- A reactive graph reruns **stale work in dependency order**.
- Fan-out creates one independent chain per dataset item.
- `*.action.md` files produce **exact plans that wait for approval**.
- A librarian maintains `AGENTS.md`; git records inputs and results.

> The editor stays familiar. The web UI makes the workspace observable.

---

<!-- _class: architecture -->

<p class="eyebrow">HOW IT WORKS</p>

# Files in. Reviewed actions out.

```text
 Editor / files --> Watcher --> Dependency graph
                                  |
                            Cline SDK sessions
                            /                \
                  Parallel research      Composio planning
                            \                /
                             Files + exact plans
                                  |
                       User approval --> Executor
                                  |
                         Git + receipts + SSE --> Web UI
```

<p class="small">Read-only lookups may run while planning. External writes wait for approval of the exact plan.</p>

---

<!-- _class: demo -->

<p class="eyebrow">DEMO + NEXT</p>

# One edit. The right work reruns.

1. Edit ICP context: only downstream synthesis reruns.
2. Add a company row: one new company chain appears.
3. Review full draft bodies and the ticket, then approve the exact plan.
4. Inspect outputs, logs, cost estimates, receipts, and git history.

**Next:** a connected live recording, shared workspaces, event-driven inboxes.

<p class="small">Offline preview uses synthetic research and simulated actions. Live adapters require credentials and linked accounts; real external writes require explicit approval.</p>

[Demo script](../docs/demo-script.md) · [Example workspace](../examples/coding-agents-icp/ensemble.yaml)

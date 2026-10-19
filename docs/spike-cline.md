# S1/S2 — pinned Cline SDK runtime spike

Observed 2026-10-19 on Node 24.14.0, using the pre-existing `@cline/sdk@0.0.95` installation from the research scratchpad. No real model credits were spent. `scripts/spike-cline.mjs` runs three actual local ClineCore sessions against the SSE mock in `test/mock-llm.ts`, through ClineCore's supported injected `fetch`. This needs no listening socket or external network. Each mock session completed and all assertions passed. The mock helper also exposes `listen()` for environments that permit HTTP listeners.

## S1 — existing authentication is readable; live use remains unverified

- Copied `~/.cline/data/settings/providers.json` into a fresh `/tmp/ensemble-cline-spike-*` directory before constructing `ProviderSettingsManager`. **Its constructor performs migrations and chmod**, so instantiating it against the original file would not have been strictly read-only. No global credential files were changed.
- `getProviderSettings('cline')` sees stored OAuth access and refresh tokens. `getProviderConfig('cline')` returns a usable config shape with `apiKey` present: it maps the stored OAuth access token into that field, rather than returning an `auth` object. No token values, hashes, or authorization headers were logged.
- Stored model is `anthropic/claude-sonnet-5.5`.
- `await Llms.getModelsForProvider('cline')` returned **316** model IDs from the SDK catalog, including `anthropic/claude-sonnet-5.5`, `anthropic/claude-sonnet-4.6`, `google/gemini-3.1-pro-preview`, and `~anthropic/claude-sonnet-latest`. The script prints the full ID list. Catalog availability does not prove account entitlement or remote availability.
- No real iteration was attempted because external network access was already failing in this sandbox. Existing OAuth can be resolved, but successful remote use and expiry refresh are **unverified**. Preserve `CLINE_API_KEY` as the documented fallback rather than requiring it immediately on this machine.

## S2 — two integration changes are required

1. **`config.rules` is absent when a custom `systemPrompt` is supplied.** The mock inspected the actual outbound system messages with `localRuntime.configExtensions: []`; the rules marker was absent. Follow SPEC §9.1's fallback and concatenate the AGENTS.md chain into `systemPrompt`. A corrected session verified that marker reached the model.
2. **Top-level `toolPolicies` overrides `config.toolPolicies` wholesale.** `config.toolPolicies.run_commands.enabled=false` works when no top-level policies are supplied. Combining that config with the spec's top-level wildcard-only `{ '*': { autoApprove: true } }` exposes `run_commands` again (and `fetch_web_content` likewise). Put the wildcard approval and all disabled tools in the same top-level policy object. The corrected session verified both tools were absent while `editor` remained available.

`beforeTool` skipping **works**. A scripted real built-in `editor` call with `{ path, new_text }` was intercepted once, its `{ skip: true, reason: 'ENSEMBLE_BLOCKED_WRITE' }` response reached the next model request as a tool error, and the target file did not exist afterward. Hooks receive `context.tool.name` / `context.toolCall.toolName` — not `toolCall.name`. Compatibility handling accepts `config.hooks` at runtime, but the pinned public start typings place hooks in **`localRuntime.hooks`**, which the corrected session also verified. The same typings place custom tools in `localRuntime.extraTools`; use that typed location in new code.

## Reproduce

After installing project dependencies:

```sh
node scripts/spike-cline.mjs
```

Before project dependencies are installed, `ENSEMBLE_SDK_PATH=/absolute/path/to/@cline/sdk/dist/index.js` selects an existing installation. A local TypeScript check of `test/mock-llm.ts` also passed with strict mode, `moduleResolution: Bundler`, and ES2022.

The optional `--real` flag performs one real iteration with an eight-token output limit, tools disabled, isolated runtime state, and a 25-second abort timer. It is not part of the default or test runs. OAuth expiry/refresh still needs a deliberate live check before claiming it works.

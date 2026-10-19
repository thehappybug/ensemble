# Parallel (parallel.ai) Web APIs: integration research for a TypeScript/Node agentic app

Researched 2026-10-19. Sources: docs.parallel.ai (raw markdown via `<page>.md` + `/llms.txt`), the OpenAPI spec at
https://docs.parallel.ai/public-openapi.json, https://parallel.ai/agents.md, and the published npm tarballs
(`parallel-web@1.3.5` source was inspected directly to confirm method names and paths). No paid API calls were made.

Legend: **[VERIFIED]** = confirmed in OpenAPI and/or SDK source. **[DOCS]** = stated in docs only. **[UNCERTAIN]** = conflicting or inferred.

Agent shortcuts:
- Full docs index: https://docs.parallel.ai/llms.txt. Full text: https://docs.parallel.ai/llms-full.txt. You can get any docs page as Markdown by adding `.md` to its URL.
- A Docs MCP exists at https://docs.parallel.ai/mcp. It only answers questions about the docs and does not call the APIs.
- Parallel publishes a skill for choosing an API: `npx skills add parallel-web/parallel-agent-skills --skill choose-your-parallel-api --agent claude-code --global --yes`. The hosted copy is at https://skills.parallel.ai/choose-your-parallel-api/SKILL.md.

---

## 0. TL;DR recommendations

| Need | Use | Why / settings |
|---|---|---|
| (a) Quick web search (agent tool call) | **Search API** `POST /v1/search` with `mode: "fast"` (~700ms, $1/1k). Use `turbo` (~200ms) for high-volume or voice workloads. Follow up with **Extract** `POST /v1/extract` to read the URLs. | Synchronous, cheap, returns ranked URLs plus markdown excerpts. Your own LLM writes the answer. Alternative: the free hosted Search MCP (`https://search.parallel.ai/mcp`). |
| (a') Quick grounded *answer* while a user waits | **Responses API** `POST /v1/responses` (OpenAI-compatible, `model: "parallel"`, `reasoning.effort: low/medium/high`). | Returns an answer with `url_citation` annotations in 5–60s. Synchronous only. |
| (b) Deep research report as markdown | **Task API** `POST /v1/tasks/runs` with `processor: "pro"` (or `"ultra"`) and `task_spec.output_schema = {type:"text"}`. Use webhook, SSE, or polling. | `output.content` is a markdown report with inline citations. `output.basis` holds all citations. Runs take minutes (up to ~45 min for ultra). |
| (c) Structured dataset, e.g. "top 10 coding agent companies" to CSV/JSON | **Task API** with a JSON `output_schema` whose root object has an array field (for example `companies: [...]`), processor `pro` or `core`. **Alternative:** **FindAll** for verified entity lists, plus `/enrich` for columns. | One Task run gives one JSON object. Flatten the array to CSV yourself. Per-element citations are in `basis` (`companies.0`, ...). |
| (d) Enrich a list of entities (people or companies) | **Task Group API** (`client.taskGroup.create` / `addRuns` / `getRuns`). It shares one `default_task_spec` (JSON input and output schema) and you send one input per row. Processor `base` or `core`. | Built for batches of up to 1,000 runs per POST. Results stream back over SSE. Pricing is per row, not per field. |
| (e) Monitor a topic over time | **Monitor API** `POST /v1/monitors`, `type: "event_stream"`, `frequency: "1d"`, `processor: "lite"`, with a webhook. Use `type: "snapshot"` + `task_run_id` to track changes to a researched answer. | Runs once on creation, then on schedule (1h–30d). Events carry a `basis` with citations. |
| Fast list of people/companies (unverified) | **Entity Search** `POST /v1beta/findall/entity-search`. | Synchronous, 1–3s, $5/1k requests, up to 1,000 results. No verification or citations. |

---

## 1. Auth, base URL, SDKs, versions

- **API key:** create it at https://platform.parallel.ai (Settings → API keys). The conventional env var is `PARALLEL_API_KEY`. **[VERIFIED]** The TS SDK reads `process.env.PARALLEL_API_KEY` automatically.
- **Base URL:** `https://api.parallel.ai`. The SDK can override it with `PARALLEL_BASE_URL` or the `baseURL` option. **[VERIFIED]**
- **Auth header for REST, Parallel-native endpoints:** `x-api-key: <PARALLEL_API_KEY>`. This is the OpenAPI `securitySchemes.ApiKeyAuth` (apiKey in header `x-api-key`). **[VERIFIED]**
- **Auth header for the Responses API** (OpenAI-compatible) **and the MCP servers:** `Authorization: Bearer <PARALLEL_API_KEY>`. **[DOCS]**
- **Beta header:** `parallel-beta: <comma-separated flags>`. The SDK adds `findall-2025-09-15` automatically on every FindAll call. **[VERIFIED]** Known flags in the SDK type `ParallelBeta`: `mcp-server-2025-07-17`, `events-sse-2025-07-24`, `webhook-2025-08-12`, `findall-2025-09-15`, `search-extract-2025-10-10`, `field-basis-2025-11-25`. Most of these features are now GA and need no header. You only need it for FindAll, and the SDK handles that.
- **Webhook secret:** Platform → Settings → Webhooks (format `whsec_...`). Store it as, for example, `PARALLEL_WEBHOOK_SECRET`.

### npm / PyPI packages (exact versions as of 2026-10-19)

| Package | Version | What |
|---|---|---|
| `parallel-web` (npm) | **1.3.5** (published 2026-09-30) | Official TS SDK, generated by Stainless. Zero dependencies. Repo: github.com/parallel-web/parallel-sdk-typescript |
| `parallel-web` (PyPI) | 1.3.5 | Python SDK (`from parallel import Parallel`) |
| `parallel-web-cli` (npm) | **0.9.3** | npm wrapper. A postinstall step downloads the prebuilt `parallel-cli` binary from GitHub Releases. Needs Node >= 18. bin: `parallel-cli` |
| `parallel-web-tools` (PyPI) | 0.9.3 | Python CLI and tooling (`pipx install "parallel-web-tools[cli]"`) |
| `@parallel-web/ai-sdk-tools` (npm) | 1.0.0 | Vercel AI SDK v6 tools: `searchTool`, `extractTool`, `createSearchTool`, `createExtractTool`. Peer dependency `ai@^6`, depends on `parallel-web@^0.5.0` (older pin) and `zod@^4` |
| `openai` (npm) | n/a | Use it for the Responses API (point `baseURL` at Parallel) |

`npm install parallel-web` (plus `openai` if you want the Responses API).

### TS SDK surface (from `parallel-web@1.3.5` source) [VERIFIED]

```ts
import Parallel from "parallel-web";
const client = new Parallel({ apiKey: process.env.PARALLEL_API_KEY }); // options: baseURL, timeout (ms, default 60_000), maxRetries (default 2), logLevel, defaultHeaders, fetchOptions

client.search(params)                       // POST /v1/search
client.extract(params)                      // POST /v1/extract
client.taskRun.create(params)               // POST /v1/tasks/runs
client.taskRun.retrieve(runId)              // GET  /v1/tasks/runs/{id}
client.taskRun.result(runId, { timeout })   // GET  /v1/tasks/runs/{id}/result?timeout=<seconds> (blocks server-side)
client.taskRun.events(runId)                // GET  /v1/tasks/runs/{id}/events (SSE Stream, use `for await`)
client.taskRun.retrieveInput(runId)
client.taskGroup.create({})                 // POST /v1/tasks/groups
client.taskGroup.retrieve(groupId)
client.taskGroup.addRuns(groupId, { default_task_spec, inputs, refresh_status })
client.taskGroup.getRuns(groupId, { include_input, include_output, last_event_id }) // SSE stream
client.taskGroup.events(groupId)
client.taskGroup.retrieveRun(groupId, runId)
client.monitor.create/retrieve/update/list/cancel/events/trigger   // /v1/monitors...
client.beta.findall.ingest/create/retrieve/result/enrich/extend/cancel/events/schema/entitySearch // /v1beta/findall/...
client.beta.memory.retrieve/clear/evict     // /v1beta/memory/...
```

- The TS SDK has **no** Responses or Chat methods. Use the `openai` SDK with `baseURL: "https://api.parallel.ai/v1"` instead.
- Errors: `Parallel.APIError` subclasses (`AuthenticationError` 401, `PermissionDeniedError` 403, `NotFoundError` 404, `UnprocessableEntityError` 422, `RateLimitError` 429, `InternalServerError` 5xx, `APIConnectionTimeoutError`).
- The SDK auto-retries 408, 409, 429, 5xx and connection errors (`maxRetries` default 2). **Gotcha [VERIFIED in source]:** when a run isn't done, `taskRun.result()` returns **408**, and the SDK retries it. A single `result(id, {timeout: 25})` call can therefore block for about 3 × 25s before it throws. Set `maxRetries: 0` per request, or poll with `retrieve()`, if you want predictable loops.
- SDK types are exported on the namespace, for example `Parallel.TaskSpec`, `Parallel.RunInput`, `Parallel.TaskRunJsonOutput`, `Parallel.TaskGroupGetRunsResponse`.

---

## 2. Search API: `POST /v1/search` [VERIFIED]

**Purpose:** natural-language web search that returns ranked URLs plus LLM-ready markdown excerpts. Your agent reads the excerpts and writes the answer.

**Request (`V1SearchRequest`):**
- `search_queries`* `string[]`: 3–6 word keyword queries. At least one is **required** in v1. 2–3 is best.
- `objective` `string?`: a self-contained natural-language goal.
- `mode` `"turbo" | "fast" | "basic" | "advanced"`. **Default is `advanced`.**
- `max_chars_total` `int?`: total excerpt budget across all results.
- `session_id` `string?`: reuse it across related search and extract calls.
- `client_model` `string?`: the model that will consume the results.
- `advanced_settings?`:
  - `source_policy {include_domains[], exclude_domains[], after_date "YYYY-MM-DD"}`
  - `fetch_policy {max_age_seconds (min 600), timeout_seconds, disable_cache_fallback}`
  - `excerpt_settings {max_chars_per_result}`
  - `location` (ISO-3166 alpha-2)
  - `max_results` (default 10)

**Response (`V1SearchResponse`):**
`{ search_id, results: [{url, title?, publish_date? (YYYY-MM-DD), excerpts: string[] (markdown)}], warnings?, usage?: [{name, count}], session_id }`

**Modes** [DOCS, https://docs.parallel.ai/search/modes]:

| Mode | Latency | Price |
|---|---|---|
| `turbo` | ~200ms | $1/1k |
| `fast` | ~700ms | $1/1k |
| `basic` | ~1s | $5/1k |
| `advanced` (default) | ~3s | $5/1k |

- Each request includes 10 results. Extra results cost $1/1k.
- Parallel recommends `fast` for most agents.
- `turbo` supports English and Japanese only.

**Legacy:** `/v1beta/search` uses a different body. Use `/v1` for new code.

TS (verbatim, https://docs.parallel.ai/search/search-quickstart):
```ts
import Parallel from "parallel-web";

const client = new Parallel({ apiKey: process.env.PARALLEL_API_KEY });

async function main() {
    const search = await client.search({
        objective: "Find latest information about Parallel Web Systems. Focus on new product releases, benchmarks, or company announcements.",
        search_queries: [
            "Parallel Web Systems products",
            "Parallel Web Systems announcements"
        ],
    });

    for (const result of search.results) {
        console.log(`${result.title}: ${result.url}`);
        for (const excerpt of result.excerpts) {
            console.log(excerpt.slice(0, 200));
        }
    }
}

main().catch(console.error);
```
To switch modes, add `mode: "fast"`.

## 3. Extract API: `POST /v1/extract` [VERIFIED]

**Purpose:** turn known public URLs into clean markdown, as focused excerpts and/or full content. Price: $1 per 1,000 URLs. Latency: 1–20s.

**Request:**
- `urls`* (up to 20)
- `objective?`
- `search_queries?`
- `max_chars_total?`
- `session_id?`
- `client_model?`
- `advanced_settings?`:
  - `fetch_policy`
  - `excerpt_settings {max_chars_per_result}`
  - `full_content: boolean | {max_chars_per_result}` (default false)

On `/v1`, `full_content`, `fetch_policy` and `excerpt_settings` **must** go inside `advanced_settings`. Sending them at the top level returns a 422.

**Response:**
`{ extract_id, results: [{url, title?, publish_date?, excerpts[], full_content?}], errors: [{url, error_type, http_status_code, content}], warnings?, usage?, session_id }`

TS (verbatim, https://docs.parallel.ai/extract/extract-quickstart):
```ts
import Parallel from "parallel-web";

const client = new Parallel({ apiKey: process.env.PARALLEL_API_KEY });

const extract = await client.extract({
    urls: ["https://www.un.org/en/about-us/history-of-the-un"],
    objective: "When was the United Nations established?",
});

for (const result of extract.results) {
    console.log(`${result.title}: ${result.url}`);
    for (const excerpt of result.excerpts) {
        console.log(excerpt.slice(0, 200));
    }
}
```
For full page markdown, pass `advanced_settings: { full_content: true }`.

(There is also an Image Search API at `POST /v1/images/search` with `fast` and `advanced` modes, priced at $1–5/1k. It is not needed here.)

---

## 4. Task API: deep research, enrichment, structured output

### 4.1 Endpoints [VERIFIED]
- `POST /v1/tasks/runs`: create a run. Returns **202** with a `TaskRun` in status `queued`.
- `GET /v1/tasks/runs/{run_id}`: get the status.
- `GET /v1/tasks/runs/{run_id}/result?timeout=<s>`: **blocks** until the run completes. Returns 408 if the timeout passes first.
- `GET /v1/tasks/runs/{run_id}/events`: SSE stream (`Accept: text/event-stream`).
- `GET /v1/tasks/runs/{run_id}/input`

### 4.2 Request `TaskRunInput`
- `processor`* string. See 4.3.
- `input`* `string | object`
- `task_spec?`: `{ output_schema*, input_schema? }`. `output_schema` is one of:
  - a bare string (same as a text schema)
  - `{type:"json", json_schema:{...}}`
  - `{type:"text", description?}`, which gives a markdown report
  - `{type:"auto"}`
  If `task_spec` is omitted, the output schema defaults to auto.
- `source_policy?` `{include_domains, exclude_domains, after_date}`
- `advanced_settings?` `{location, data_sources:{pay_per_use[], free[]}}`
- `metadata?`: string to string map. Keys can be up to 16 characters and values up to 512.
- `webhook?` `{url, event_types:["task_run.status"]}`
- `enable_events?` bool. This is on by default for `pro` and above.
- `previous_interaction_id?`: chains context from a prior run (follow-up questions).
- `mcp_servers?` `[{type:"url", url, name, headers?, allowed_tools?}]`
- `memory_scope_key?`

### 4.3 Processors (tiers) [DOCS]

| Processor | $ / 1k runs | Latency (docs range) | p50 / p90 exec | ~Max fields | Use for |
|---|---|---|---|---|---|
| `lite` | 5 | 10s–2min (pricing page says 10–60s) | 45s / 1.5min | ~2 | simple lookups |
| `base` | 10 | 15s–3min (pricing: 15–100s) | 50s / 2min | ~5 | standard enrichment |
| `core` | 25 | 60s–5min | 1.5 / 3min | ~10 | cross-referenced fields |
| `core2x` | 50 | 60s–10min | 3.5 / 6.5min | ~10 | harder enrichment |
| `pro` | 100 | 2–10min | 3.5 / 7.5min | ~20 | exploratory or deep research (CLI default) |
| `ultra` | 300 | 3–25min | 4 / 10min | ~20 | multi-source deep research |
| `ultra2x` | 600 | 5–50min | 6 / 9.5min | ~25 | difficult research |
| `ultra4x` | 1200 | 5–90min | 8 / 10.5min | ~25 | very difficult research |
| `ultra8x` | 2400 | 5min–2hr | 6.5 / 11min | ~25 | hardest research |

- You pay per **successful run**, not per field. Failed runs are not billed.
- Queue time is extra. A burst of submissions queues.
- `auto` schema (Deep Research style) works only on `pro` and above. It is the default output mode on pro and ultra.
- Deep research input should stay under 15,000 characters.
- **[UNCERTAIN]** The changelog mentions "fast processors" that run 3–5x faster and trade freshness for speed (historically named like `core-fast` / `pro-fast`). The current processor page does not list them. Do not rely on them without testing.
- For latency-sensitive calls where someone is waiting, the docs consistently send you to the **Responses API** instead.

### 4.4 Output, citations and basis [VERIFIED]

`TaskRunResult = { run: TaskRun, output: TaskRunTextOutput | TaskRunJsonOutput }`

- **Text output:** `{ type:"text", content: string, basis: FieldBasis[] }`. There is one basis entry, with `field:"output"`. In text mode the basis lists the citations for all sites visited. The report itself contains inline references and a sources list.
- **JSON output:** `{ type:"json", content: object, basis: FieldBasis[], output_schema? }`. `output_schema` is filled in only for auto mode.
- **Basis paths:** basis covers top-level fields and elements of top-level list fields, using dot-index paths such as `companies.0`. Auto mode nests further, for example `market_trends.2.description`.
- **`FieldBasis`:** `{ field, citations: [{url, title?, excerpts?[]}], reasoning, confidence: "high"|"medium"|"low"|null }`. All processors now return citations, reasoning, confidence and excerpts.
- **`mcp_tool_calls?`:** included when you used `mcp_servers`.
- **`TaskRun`:** `{ run_id, interaction_id, status: queued|action_required|running|completed|failed|cancelling|cancelled, is_active, processor, metadata, taskgroup_id, error?, warnings?, created_at, modified_at }`
- Do not add `reasoning` or `confidence` fields to your schema. They already come in `basis`.

### 4.5 JSON-schema rules for `output_schema` [DOCS, https://docs.parallel.ai/task-api/guides/specify-a-task]
- **Errors:**
  - The root must be `type:"object"` and have `properties`.
  - No root-level `anyOf`.
  - Max nesting depth is 5.
  - At most 100 properties in total.
  - At most 500 enum values.
  - Task spec: 15k characters max. Task spec plus input: **25k characters** max.
- **Warnings:**
  - Every field should be in `required`. To make a field optional, use `["string","null"]`.
  - Every object should set `additionalProperties:false`.
- **Unsupported keywords:** `format`, `pattern`, `minItems`, `maxItems`, `minimum`, `maximum`, `minLength`, `maxLength`, `uniqueItems`, `contains`, `multipleOf`, `patternProperties`, `propertyNames`, `unevaluated*`, `min/maxProperties`, `min/maxContains`.
  - Because `maxItems` is not allowed, say "exactly 10" in the `description` instead.
- **Best practices:** put per-field instructions in `description`, covering entity, action, format (for example dates as YYYY-MM-DD) and the fallback ("If unavailable, return null"). Use specific field names such as `ceo_name`.

### 4.6 Deep research as markdown: TS (verbatim, https://docs.parallel.ai/task-api/examples/task-deep-research)
```ts
import Parallel from "parallel-web";

const client = new Parallel({
  apiKey: process.env["PARALLEL_API_KEY"],
});

async function main() {
  const taskRun = await client.taskRun.create({
    input:
      "Create a comprehensive market research report on the HVAC industry in the USA including an analysis of recent M&A activity and other relevant details.",
    processor: "ultra",
    task_spec: {
      output_schema: {
        type: "text",
      },
    },
  });

  console.log(`Run ID: ${taskRun.run_id}`);

  // Poll for results with 25-second timeout, retry up to 144 times (1 hour total)
  let runResult;
  for (let i = 0; i < 144; i++) {
    try {
      runResult = await client.taskRun.result(taskRun.run_id, { timeout: 25 });
      break;
    } catch (error) {
      if (i === 143) throw error; // Last attempt failed
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  console.log(runResult.output);
}

main();
```
- The markdown is `runResult.output.content` (a string).
- To steer the report, set `output_schema: { type: "text", description: "..." }`. This controls length, sections and so on.
- For follow-up questions, create another run with `previous_interaction_id: taskRun.interaction_id`. The docs use processor `core` and a text schema for these.

### 4.7 Structured dataset: "top 10 coding agent companies" to JSON/CSV

[COMPOSED from the documented API shape. This is not a verbatim docs snippet.]

```ts
import Parallel from "parallel-web";
import { writeFileSync } from "node:fs";

const client = new Parallel(); // reads PARALLEL_API_KEY

const run = await client.taskRun.create({
  input: "Identify the top 10 AI coding agent companies/products as of today (e.g. autonomous or IDE-integrated coding agents), ranked by adoption and funding.",
  processor: "pro", // "core" is cheaper; "ultra" for more depth
  task_spec: {
    output_schema: {
      type: "json",
      json_schema: {
        type: "object",
        properties: {
          companies: {
            type: "array",
            description: "Exactly 10 companies, ordered by rank (1 = most significant).",
            items: {
              type: "object",
              properties: {
                rank: { type: "integer", description: "1-10" },
                company_name: { type: "string", description: "Legal or common company name" },
                product_name: { type: "string", description: "Flagship coding agent product" },
                website: { type: "string", description: "Official homepage URL" },
                hq_country: { type: ["string", "null"], description: "HQ country; null if unknown" },
                total_funding_usd_millions: { type: ["number", "null"], description: "Total disclosed funding in USD millions; null if undisclosed" },
                founded_year: { type: ["integer", "null"], description: "Founding year YYYY; null if unknown" },
                one_line_description: { type: "string", description: "<= 25 words" },
              },
              required: ["rank","company_name","product_name","website","hq_country","total_funding_usd_millions","founded_year","one_line_description"],
              additionalProperties: false,
            },
          },
        },
        required: ["companies"],
        additionalProperties: false,
      },
    },
  },
});

// wait (see section 4.8), then:
const res = await client.taskRun.result(run.run_id, { timeout: 600 }, { maxRetries: 0, timeout: 650_000 });
if (res.output.type !== "json") throw new Error("expected json");
const rows = (res.output.content as any).companies as Record<string, unknown>[];
writeFileSync("companies.json", JSON.stringify({ rows, basis: res.output.basis }, null, 2));
const cols = Object.keys(rows[0]);
const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
writeFileSync("companies.csv", [cols.join(","), ...rows.map(r => cols.map(c => esc(r[c])).join(","))].join("\n"));
// Per-row citations: res.output.basis.filter(b => b.field.startsWith("companies."))
```

Alternatives:
- **FindAll** (section 6) when the list must be *verified* against explicit criteria. Each candidate gets citations per match condition, and you can add enrichment columns.
- **Entity Search** for a quick, unverified list.

### 4.8 Async patterns: polling, webhooks, SSE

| Method | Best for |
|---|---|
| Polling: `retrieve()` until `status === "completed"`, then `result()` | Scripts and simple apps. Docs poll every 25s. |
| Webhook: `webhook: {url, event_types:["task_run.status"]}` | Production backends. The payload has status only, so you then call `result()`. |
| SSE: `client.taskRun.events(runId)` → `for await (const ev of stream)` | Showing live progress in a UI |

**Polling (verbatim excerpt, deep-research doc):**
```ts
while (attempts < maxAttempts) {
  const status = await client.taskRun.retrieve(taskRun.run_id);
  if (status.status === "completed") {
    const runResult = await client.taskRun.result(taskRun.run_id, { timeout: 25 });
    ...
    break;
  } else if (status.status === "failed") { ... break; }
  attempts++;
  await new Promise((resolve) => setTimeout(resolve, 25000));
}
```

**Webhook creation (verbatim, https://docs.parallel.ai/task-api/webhooks):**
```ts
const taskRun = await client.taskRun.create({
  task_spec: {
    output_schema: "Find the GDP of the specified country and year",
  },
  input: "France (2023)",
  processor: "core",
  metadata: {
    key: "value",
  },
  webhook: {
    url: "https://your-domain.com/webhooks/parallel",
    event_types: ["task_run.status"],
  },
});
```

**Webhook payload:**
`{ timestamp, type: "task_run.status", data: <TaskRun object> }`. This fires on completed and on failed.

**Webhook verification** [DOCS, https://docs.parallel.ai/resources/webhook-setup]. Signing follows the Standard Webhooks (Svix) spec.
- Headers: `webhook-id`, `webhook-timestamp` (unix seconds), `webhook-signature` (space-separated `v1,<base64>` entries).
- Signed content: `${webhook-id}.${webhook-timestamp}.${rawBody}`.
- Algorithm: HMAC-SHA256. The key is the secret with the `whsec_` prefix stripped, then **base64-decoded**. Compare against standard base64 (padded).
- Any Standard-Webhooks library works, for example `svix` or `standardwebhooks`.

Node verification (verbatim core):
```ts
function getSigningKey(secret: string): Buffer {
  const trimmed = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return Buffer.from(trimmed, "base64");
}
function computeSignature(secret: string, webhookId: string, webhookTimestamp: string, body: string | Buffer): string {
  const payload = `${webhookId}.${webhookTimestamp}.${body.toString()}`;
  const key = getSigningKey(secret);
  const digest = crypto.createHmac("sha256", key).update(payload).digest();
  return digest.toString("base64");
}
// header "webhook-signature" may hold several "v1,<sig>" entries separated by spaces; accept if any matches (timingSafeEqual)
// Express: use express.raw({ type: "application/json" }) so you sign the exact raw body.
```

**Webhook delivery behaviour:**
- Retries start after 5s and back off exponentially (doubling) for up to 48h.
- Any non-2xx response triggers a retry.
- Dedupe on `webhook-id`.
- Return 200 fast and process the event asynchronously.

**SSE** [DOCS, https://docs.parallel.ai/task-api/task-sse]:
- Event types:
  - `task_run.state` (first and last event; the final one includes the full `output`)
  - `task_run.progress_stats` (`source_stats`, `progress_meter`)
  - `task_run.progress_msg.{plan,tool_call,search,result,exec_status}`
  - `error`
- A stream stays open at most **570s**. Reconnect to continue: it replays the reasoning trace so far but is not resumable by cursor.
- For a run that is already finished, the stream returns a single `task_run.state` event that includes the output.

### 4.9 Task Groups (batch / enrichment) [VERIFIED + DOCS, https://docs.parallel.ai/task-api/group-api]

**Endpoints:**
- `POST /v1/tasks/groups`
- `POST /v1/tasks/groups/{id}/runs`. Up to **1,000 runs per POST**. Set `refresh_status:false` for bulk adds.
- `GET /v1/tasks/groups/{id}`. Returns `status.is_active` and `status.task_run_status_counts`.
- `GET /{id}/runs`: an **SSE snapshot** of all runs, with `include_input` / `include_output`. Resume with `last_event_id`.
- `GET /{id}/events`: live group status and run state changes. This stream is resumable.

TS (verbatim excerpts):
```ts
const groupResponse = await client.taskGroup.create({});
const taskgroupId = groupResponse.taskgroup_id;

const runInputs: Array<Parallel.RunInput> = companies.map((company) => ({
  input: { company_name: company.company_name, company_website: company.company_website },
  processor: "pro",
}));
const response = await client.taskGroup.addRuns(taskgroupId, {
  default_task_spec: taskSpec,   // Parallel.TaskSpec with input_schema + output_schema (type:"json")
  inputs: runInputs,
});

// wait
while (true) {
  const response = await client.taskGroup.retrieve(taskgroupId);
  if (!response.status.is_active) break;
  await new Promise((resolve) => setTimeout(resolve, 10000));
}

// collect
const runStream = await client.taskGroup.getRuns(taskgroupId, { include_input: true, include_output: true });
for await (const event of runStream) {
  if (event.type === "task_run.state" && event.output && event.input) {
    const input = event.input.input as unknown as CompanyInput;
    const output = (event.output as Parallel.TaskRunJsonOutput).content as unknown as CompanyOutput;
  }
}
```

**Classifying runs:** use `event.run.status`. A `completed` run with no output, a `failed` run and a `cancelled` run are all unsuccessful.

**Input tips:** give the minimum fields that uniquely identify each entity, for example `company_name` + `company_website`, or `person_name` + `linkedin_url`.

**Credit reservation:** each Task Group POST checks the balance for the whole batch. If the balance is short you get a 402.

---

## 5. Responses API (OpenAI-compatible, synchronous): `POST /v1/responses` [DOCS + OpenAPI]

**Basics:**
- One model id: `"parallel"`.
- `reasoning.effort` sets the tier:

| Effort | Latency | Price |
|---|---|---|
| `low` | ~5–10s | $10/1k |
| `medium` (default) | ~15–20s | $50/1k |
| `high` | ~30–60s | $250/1k |

- No token charges. You pay only for successful requests.
- Set your client timeout to 120s or more.

**Features:**
- `input` takes a string or role/content messages (text only).
- Multi-turn: `previous_response_id`.
- Structured output: `text.format = {type:"json_schema", name, schema}`.
- Streaming: `stream: true` gives the standard OpenAI Responses SSE events.
- Remote MCP tools need `require_approval:"never"`.
- The `web_search` tool's domain `filters` are honored.

**Output:**
- `output_text` holds the answer.
- `output[]` contains `web_search_call` items, `mcp_*` items and a `message` item.
- `message.content[].annotations[]` are `{type:"url_citation", url, title, start_index, end_index}`.

TS (verbatim, https://docs.parallel.ai/responses-api/responses-quickstart):
```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.PARALLEL_API_KEY,
  baseURL: "https://api.parallel.ai/v1",
});

const response = await client.responses.create({
  model: "parallel",
  input: "Who is the current CEO of the largest cloud provider by revenue?",
  reasoning: { effort: "low" },
});

console.log(response.output_text);
```
Structured output (verbatim, https://docs.parallel.ai/responses-api/features/structured-outputs): add
`text: { format: { type: "json_schema", name: "capital_info", schema: {...additionalProperties:false} } }`, then `JSON.parse(response.output_text)`.

**Chat API (legacy beta):** `POST /v1beta/chat/completions`. It is OpenAI ChatCompletions-compatible, uses `x-api-key` per the OpenAPI spec, has a 300/min rate limit and supports streaming.
- Model names: **[UNCERTAIN]** `speed` for low latency, plus `lite` / `base` / `core` research models (from the changelog).
- The changelog now points "Chat API research models" to the Responses API page. **Prefer the Responses API for new work.**

---

## 6. FindAll API: entity discovery lists (beta, `/v1beta/findall/*`) [VERIFIED]

**Purpose:** "FindAll <entities> matching <criteria>". It generates candidates, checks each one against your `match_conditions` with citations, and can optionally enrich matches with extra fields. It is asynchronous and in public beta, with 30 days' notice before breaking changes. **Do not rewrite these paths to `/v1`.**

**Flow:**
1. `ingest` turns natural language into a schema.
2. Review and edit the schema.
3. `create` the run.
4. Poll, use SSE, or wait for a webhook.
5. Call `result`.
6. Optionally call `enrich` or `extend`.

Endpoints:
- `POST /v1beta/findall/ingest` `{objective}` → `{objective, entity_type, match_conditions[{name, description}], generator}`
- `POST /v1beta/findall/runs` takes:
  - `objective`*
  - `entity_type`* (for example "companies" or "people")
  - `match_conditions`* `[{name, description}]`
  - `generator`* `preview|base|core|pro`
  - `match_limit`* (5–1000; for `preview` it is the number of candidates to evaluate, 5–10)
  - `exclude_list?` `[{name,url}]` (up to 10k)
  - `metadata?`, `webhook?`, `memory_scope_key?`

  It returns `{findall_id, status:{status, is_active, metrics:{generated_candidates_count, matched_candidates_count}, termination_reason?}, generator, ...}`.
- `GET /v1beta/findall/runs/{id}`: status.
- `GET /v1beta/findall/runs/{id}/result` → `{ run, candidates: [{candidate_id, name, url, description, match_status: generated|matched|unmatched|..., output: {<cond>: {value, type:"match_condition"|"enrichment", is_matched}}, basis: FieldBasis[]}], last_event_id }`. **Filter to `match_status === "matched"`.**
- `POST /{id}/enrich` `{processor (default "core"), output_schema:{type:"json", json_schema}, mcp_servers?}`. This runs a Task on every match, now and in future. FindAll supplies `entity_name`, `entity_url` and `entity_description` as input.
- `POST /{id}/extend`: raise the match limit. The fixed fee is not charged again.
- `POST /{id}/cancel`
- `GET /{id}/events` (SSE)
- `GET /{id}/schema`

**Termination reasons:** `low_match_rate`, `match_limit_met`, `candidates_exhausted`, `user_cancelled`, `error_occurred`, `timeout`, `insufficient_funds`.

**Webhook events:**
- `findall.candidate.generated`
- `findall.candidate.matched`
- `findall.candidate.enriched`
- `findall.run.completed`
- `findall.run.cancelled`
- `findall.run.failed`

(The OpenAPI enum for this webhook still lists `task_run.status`, which looks stale.)

**Generators and pricing:**

| Generator | Fixed | Per match | Use for |
|---|---|---|---|
| `preview` | $0.10 | $0 | Testing a query (~10 candidates). Run this first. |
| `base` | $0.25 | $0.03 | Broad queries, fewer than 20 matches |
| `core` | $2 | $0.15 | Moderate specificity, 20–50 matches |
| `pro` | $10 | $1 | Rare or hard matches |

Enrichment adds Task processor price × number of matches.

TS (verbatim, https://docs.parallel.ai/findall-api/findall-quickstart):
```ts
import Parallel from 'parallel-web';

const client = new Parallel({
  apiKey: process.env.PARALLEL_API_KEY
});

const run = await client.beta.findall.create({
  objective: "FindAll portfolio companies of Khosla Ventures founded after 2020",
  entity_type: "companies",
  match_conditions: [
    {
      name: "khosla_ventures_portfolio_check",
      description: "Company must be a portfolio company of Khosla Ventures."
    },
    {
      name: "founded_after_2020_check",
      description: "Company must have been founded after 2020."
    }
  ],
  generator: "core",
  match_limit: 5
});
// const schema = await client.beta.findall.ingest({ objective: "..." });
// const runStatus = await client.beta.findall.retrieve(run.findall_id);
// const result = await client.beta.findall.result(run.findall_id);
```
Enrich (verbatim, https://docs.parallel.ai/findall-api/features/findall-enrich):
```ts
await client.beta.findall.enrich(
  "findall_40e0ab8c10754be0b7a16477abb38a2f",
  {
    processor: "core",
    output_schema: {
      type: "json",
      json_schema: {
        type: "object",
        properties: {
          ceo_name: { type: "string", description: "Name of the CEO" },
          founding_year: { type: "string", description: "Year the company was founded" }
        },
        required: ["ceo_name", "founding_year"],
        additionalProperties: false
      }
    }
  }
);
```

**Tips:**
- Ingest can interpret time ranges too strictly. Rewrite them explicitly, for example "founded in 2025 or later".
- Getting 0 matches usually means the candidate pool is too small. Upgrade the generator before you rewrite the query.

### Entity Search (synchronous): `POST /v1beta/findall/entity-search` [VERIFIED]
- Request: `{ entity_type: "people"|"companies", objective, match_limit (5–1000, default 100) }`
- Response: `{ entity_set_id, entities: [{name, url, description}] }`
- Takes 1–3s and costs $5/1k requests (100 results included).
- No verification, enrichment or citations. You cannot page through more results.

```ts
const response = await client.beta.findall.entitySearch({
  entity_type: "companies",
  objective: "AI startups that raised Series A in 2024",
  match_limit: 100,
});
for (const entity of response.entities) console.log(`${entity.name}: ${entity.url}`);
```

---

## 7. Monitor API: track a topic over time (GA, `/v1/monitors`) [VERIFIED]

**Purpose:** scheduled web watching with deduped "material change" events delivered by webhook.

**Endpoints:**

| Method | Path | Action |
|---|---|---|
| `POST` | `/v1/monitors` | create |
| `GET` | `/v1/monitors` | list |
| `GET` | `/v1/monitors/stats` | stats |
| `GET` | `/v1/monitors/{id}` | retrieve |
| `POST` | `/v1/monitors/{id}/update` | update frequency, webhook or metadata |
| `POST` | `/v1/monitors/{id}/cancel` | cancel (irreversible) |
| `GET` | `/v1/monitors/{id}/events` | events (`?event_group_id=`, `include_completions`, `next_cursor`) |
| `POST` | `/v1/monitors/{id}/trigger` | real off-schedule run |

**Create request:**
- `type`*: `event_stream` | `snapshot`
- `frequency`*: `"<n>h|d|w"`, between 1h and 30d
- `processor`: `lite` (default) | `base` | `core`
- `settings`*:
  - for `event_stream`: `{query, output_schema?:{type:"json",json_schema}, include_backfill?, advanced_settings?:{source_policy, location}}`
  - for `snapshot`: `{task_run_id}` (a completed Task run)
- `webhook?`: `{url, event_types: ["monitor.event.detected","monitor.execution.completed","monitor.execution.failed"]}`
- `metadata?`: echoed back in webhooks

**Behaviour:**
- The monitor runs once immediately when created, then on schedule.
- It only finds **new** events from creation time onward. Set `include_backfill` for a small, non-exhaustive sample of recent events.

**Pricing:** you pay per execution, even when nothing is found.
- `lite`: $3/1k
- `base`: $10/1k
- **[UNCERTAIN]** `core` appears in the OpenAPI enum but not on the pricing page.

**Webhook payload:** `{type:"monitor.event.detected", data:{monitor_id, event:{event_group_id}, metadata}}`. Then fetch the events with `client.monitor.events(monitorId, {event_group_id})`.

**Event types:**
- `event_stream`: `{event_id, event_group_id, event_date, output:{type, content, basis}}`
- `snapshot`: `{changed_output, previous_output}`
- `completion`
- `error`

TS (verbatim, https://docs.parallel.ai/monitor-api/monitor-quickstart):
```ts
import Parallel from "parallel-web";

const client = new Parallel({ apiKey: process.env.PARALLEL_API_KEY });

const monitor = await client.monitor.create({
  type: "event_stream",
  frequency: "1d",
  processor: "lite",
  settings: { query: "AI startup funding announcements" },
  webhook: {
    url: "https://example.com/webhook",
    event_types: ["monitor.event.detected"],
  },
  metadata: { external_id: "acme-monitor-001" },
});

console.log(`Monitor ID: ${monitor.monitor_id}`);

const result = await client.monitor.events(monitorId, {
  event_group_id: eventGroupId,
});
for (const event of result.events) {
  console.log(event.output?.content);
}
```

**Query writing:** describe the intent in natural language, for example "Parallel Web Systems (parallel.ai) funding or launch announcements". Avoid boolean keyword strings and date ranges.

**Without a public webhook URL:** poll `client.monitor.events(id)` on your own schedule.

---

## 8. Rate limits [DOCS, https://docs.parallel.ai/getting-started/rate-limits]

| Product | Default | What counts |
|---|---|---|
| Search | 600/min | each POST /v1/search |
| Image Search | 600/min | |
| Extract | 600/min | |
| Tasks / TaskGroups | 2,000/min | each run created (each item in a group `inputs` counts) |
| Chat | 300/min | |
| FindAll | **300/hour** | each POST /v1beta/findall/runs |
| Entity Search | 600/min | |
| Monitor | 300/min | creates. The table still says `/v1alpha/monitors`, which is stale; GA is `/v1/monitors`. |

- Only **POSTs that create resources** count. GET polling is free against these limits.
- Limits use a **rolling 60s window**.
- On a 429, back off exponentially. To raise limits, contact support@parallel.ai.

**Error codes:**

| Code | Meaning | Retry? |
|---|---|---|
| 401 | bad key | no |
| 402 | insufficient credit (in-flight runs reserve credit; pro and ultra reserve more) | no |
| 403 | invalid processor | no |
| 404 | not found | no |
| 408 | result not ready (sync timeout) | yes |
| 422 | validation | no |
| 429 | rate limited | yes |
| 5xx | server error | yes |

Error body: `{error:{message, detail}}`.

**Search MCP free tier:** works anonymously and is rate limited by `session_id`. Add a key for higher limits.

---

## 9. MCP servers (hosted, streamable HTTP) [DOCS, https://docs.parallel.ai/integrations/mcp/quickstart]

| Server | URL | Auth | Tools |
|---|---|---|---|
| **Search MCP** | `https://search.parallel.ai/mcp` | **Free, no key.** Optional `Authorization: Bearer <PARALLEL_API_KEY>` for higher limits and config overrides. No OAuth on this URL. | `web_search` (`objective`*, `search_queries`*, `session_id`, `model_name`), `web_fetch` (`urls`* up to 20, `objective`, `search_queries`, `full_content`, `session_id`, `model_name`). About 25k characters of excerpts per call. Anonymous calls run in `fast` mode. |
| Search MCP (auth enforced / OAuth) | `https://search.parallel.ai/mcp-oauth` | Bearer key or OAuth. Anonymous calls get 401. | same as above |
| **Task MCP** | `https://task-mcp.parallel.ai/mcp` | **Required:** `Authorization: Bearer <PARALLEL_API_KEY>` or OAuth | `createDeepResearch`, `createTaskGroup`, `getStatus` (~50 tokens), `getResultMarkdown`. Asynchronous: the result is fetched in a later turn. Suited to small or experimental batches. |
| Docs MCP | `https://docs.parallel.ai/mcp` | none | docs Q&A only |

**Search MCP overrides (authenticated only).** Set them on the URL query string or in a header:
- Query string, for example `https://search.parallel.ai/mcp?mode=fast&advanced_settings.location=gb&advanced_settings.source_policy.include_domains=wikipedia.org,.gov`
- Header: `x-parallel-search-config: {"mode":"fast","advanced_settings":{"max_results":5}}`

If both set a field, the URL wins.

**Install commands:**
- Claude Code: `claude mcp add --transport http parallel-search https://search.parallel.ai/mcp`
- Claude Code, Task MCP: `claude mcp add --transport http "Parallel-Task-MCP" https://task-mcp.parallel.ai/mcp` (OAuth)
- Codex: `codex mcp add parallel-task --url https://task-mcp.parallel.ai/mcp --bearer-token-env-var PARALLEL_API_KEY`
- Generic mcp.json: `{"url":"https://task-mcp.parallel.ai/mcp","headers":{"Authorization":"Bearer ${env:PARALLEL_API_KEY}"}}`

**Programmatic use:**
- OpenAI Responses tool: `{type:"mcp", server_label:"parallel_web_search", server_url:"https://search.parallel.ai/mcp", headers:{Authorization:`Bearer ${PARALLEL_API_KEY}`}, require_approval:"never"}`
- Anthropic Messages (`mcp_servers` beta): `{type:"url", url:"https://search.parallel.ai/mcp", name:"parallel-search", authorization_token:"<PARALLEL_API_KEY>"}`
- From a Node agent, connect with `@modelcontextprotocol/sdk` using `StreamableHTTPClientTransport` and an `Authorization` header. **[UNCERTAIN]** This approach is general MCP practice and is not shown in Parallel's docs.

**Vercel AI SDK:** `@parallel-web/ai-sdk-tools` gives `searchTool` and `extractTool`, ready to plug into `streamText({ tools })`.

---

## 10. CLI: `parallel-cli` [DOCS, https://docs.parallel.ai/integrations/cli, https://parallel.ai/agents.md]

**Install:** pick one.
- `npm install -g parallel-web-cli` (v0.9.3; downloads a binary)
- `uv tool install "parallel-web-tools[cli]"`
- `pipx install "parallel-web-tools[cli]" && pipx ensurepath`
- `brew install parallel-web/tap/parallel-cli`
- `curl -fsSL https://parallel.ai/install.sh | bash`

agents.md requires version **>= 0.9.2**.

**Upgrade:**
- standalone: `parallel-cli update`
- npm: `npm update -g parallel-web-cli`
- uv: `uv tool upgrade parallel-web-tools[cli]`

**Auth:**
- Set `PARALLEL_API_KEY`, or
- run `parallel-cli login` (browser OAuth), or
- run `parallel-cli login --device` (headless).

agents.md uses `parallel-cli login --json [--no-browser]`. It emits these JSON events: `auth_start`, `device_code` (with `verification_uri_complete` and `user_code`), `auth_waiting`, `auth_success`.

Check status with `parallel-cli auth --json`. If `authenticated:false` or `selected_org_id:"legacy"`, run login again.

**Billing:**
- `parallel-cli balance get`
- `parallel-cli balance add <cents>`. This needs a payment method set up at https://platform.parallel.ai/settings.

**Skills:**
- `parallel-cli skills install [--project]` writes to `~/.agents/skills` (and `.claude/skills` if Claude Code is detected).
- Or `npx skills add parallel-web/parallel-agent-skills --all --global`.
- Skills: `/parallel-web-search`, `/parallel-web-extract`, `/parallel-deep-research`, `/parallel-data-enrichment`.

agents.md is a "parallel-cli-setup" skill. It walks an agent through install, auth, balance check, skills install, then suggests a first search or extract.

**Commands.** All take `--json`. Exit codes: 0 ok, 2 bad input, 3 auth, 4 API error, 5 timeout. `-` reads from stdin.

Search and extract:
```bash
parallel-cli search "objective text" -q "kw query" --mode fast --max-results 10 --include-domains sec.gov --after-date 2026-01-01 --json
parallel-cli extract https://example.com --objective "Find pricing" [--full-content] --json
```

Research:
```bash
parallel-cli research run "question" --processor pro|ultra [--no-wait] [-o report] --json   # -o writes .json + .md
parallel-cli research status trun_xxx --json
parallel-cli research poll trun_xxx --json
parallel-cli research processors --json
```

Enrich:
```bash
parallel-cli enrich suggest "Find the CEO and annual revenue" --json
parallel-cli enrich run --source-type csv --source in.csv --target out.csv \
  --source-columns '[{"name":"company","description":"Company name"}]' --intent "Find the CEO and annual revenue" [--processor core] [--no-wait]
parallel-cli enrich run --data '[{"company":"Google"}]' --target out.csv --intent "Find the CEO"
parallel-cli enrich status|poll tgrp_xxx --json
```

FindAll:
```bash
parallel-cli findall run "AI startups in healthcare" -g core -n 25 [--exclude '[...]'] [--dry-run] [--no-wait] --json
parallel-cli findall status|poll|result|cancel findall_xxx
parallel-cli findall entity-search "AI startups in SF" --entity-type companies --match-limit 25 --json
```

Monitor:
```bash
parallel-cli monitor create "New AI funding announcements" --frequency 1d [--processor lite|base] [--webhook URL] [--output-schema JSON] --json
parallel-cli monitor create --type snapshot --task-run-id trun_xxx --frequency 1d --json
parallel-cli monitor list|get|update|cancel|events|trigger ...
```

**[UNCERTAIN] Default mismatch:** the CLI docs say search `--mode` defaults to `basic`, while the raw API defaults to `advanced`. The CLI also sends `max_chars_total=60000` by default. For a Node app, call the SDK directly. Shelling out to the CLI is a reasonable fallback, especially `enrich run` with CSV in and out.

---

## 11. Other notes

**Memory (beta):** `/v1beta/memory/{retrieve,clear,evict}`. Task, Monitor and FindAll runs can be reused as memory, scoped by `memory_scope_key`.

**Caching guidance:** Search, Extract and Entity Search outputs are safe to cache across users. Task, FindAll and Monitor outputs can echo the input, so do not share them across tenants if inputs are private.

**Pricing summary:**

| API | Price |
|---|---|
| Search | $1–5/1k |
| Extract | $1/1k URLs |
| Task | $5–2,400/1k runs |
| Responses | $10–250/1k |
| Monitor | $3–10/1k checks |
| FindAll | $0.10–10 fixed + $0–1/match |
| Entity Search | $5/1k |

All prices are prepaid credit. Platform: https://platform.parallel.ai.

**Data connectors:** Task and Responses can use partner data via `advanced_settings.data_sources`. **[DOCS]**

**Not supported:** private, logged-in or paywalled pages. Use `mcp_servers`, for example Browser Use MCP, for those.

**Uncertain or conflicting items:**
- "Fast" Task processors (`*-fast`) are mentioned in the changelog but are not in the current processor table.
- The `lite` / `base` latency ranges differ between the pricing page and the processor page.
- The Monitor `core` processor has no published price.
- The rate-limit table references `/v1alpha/monitors`.
- The FindAll OpenAPI webhook enum shows `task_run.status`, but the docs list `findall.*` events.
- Chat API model names are not confirmed.
- CLI and API search-mode defaults differ.
- Using MCP from Node via `@modelcontextprotocol/sdk` is general MCP practice, not documented by Parallel.

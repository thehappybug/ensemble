# Composio research for a TypeScript/Node agent app built on the Cline SDK

Researched 2026-10-19. Sources: docs.composio.dev (raw `.md` pages fetched with curl, so the snippets below are verbatim), the installed CLI (`/home/mehdi/.composio/composio`), `npm view`, and the `@composio/core@0.25.0` type definitions, which I installed in a scratchpad and inspected.

Legend: **[VERIFIED]** means I ran it locally or read it in the SDK typings. **[DOCS]** means it comes from the docs. **[UNCERTAIN]** means I could not confirm it.

Docs index for agents: https://docs.composio.dev/llms.txt. The full dump is https://docs.composio.dev/llms-full.txt. Any page can be fetched as markdown by appending `.md`, for example `https://docs.composio.dev/docs/quickstart.md`.

---

## 0. TL;DR / recommended integration for a Cline SDK agent

1. **Install.** Run `npm i @composio/core zod`. The package is ESM-only and needs Node >= 22.22.3. Local Node is v24.14.0, so that's fine.
2. **Authenticate.** Set `COMPOSIO_API_KEY=ak_...`, a **project** API key from https://dashboard.composio.dev/~/project/settings/api-keys.
   - The CLI login on this machine stores a **user** key (`uak_...`) in `~/.composio/user_data.json`.
   - The SDK will **not** use a `uak_` key as a project key. It throws instead. [VERIFIED in the SDK typings]
3. **Create one session per app user.** Call `composio.create(userId, {...})` and persist `session.sessionId`. Reuse it later with `composio.use(id)`.
4. **Hand the tools to the agent.** There are two options:
   - **(A) MCP.** This is the most portable choice when the Cline SDK supports remote MCP servers (streamable HTTP). Use `composio.create(userId, { mcp: true })`, then give `session.mcp.url` and `session.mcp.headers` to the MCP client. No provider package is needed.
   - **(B) Native tools.** Read the JSON Schemas yourself and dispatch with `session.execute(slug, args)`. This gives full control over approvals and logging, and it works without MCP. To get the schemas, use either:
     - `session.tools()` with a custom provider, or
     - `composio.tools.getRawComposioTools(...)`.
5. **Choose the tool exposure.** There are two modes:
   - **Default mode** exposes about 7 *meta tools*: search, get schemas, multi-execute, manage connections, and so on. The agent discovers app tools at runtime.
   - **Fixed tool set.** For a known set such as "Gmail draft + Calendar list + Slack post", use `sessionPreset: SessionPreset.DIRECT_TOOLS` with a `tools` allowlist.
6. **Connect accounts.** Call `session.authorize("gmail")`, which returns `redirectUrl` (a Connect Link). Then call `waitForConnection()`. Alternatively, the meta tool `COMPOSIO_MANAGE_CONNECTIONS` lets the agent produce the link itself in chat.
7. **Triggers (event to file).** Two routes:
   - SDK: `composio.triggers.create(userId, "GMAIL_NEW_GMAIL_MESSAGE", {triggerConfig})`, then `composio.triggers.subscribe(cb, {filters})` over a websocket. No public URL is needed. Write each event to a directory.
   - CLI: `composio dev listen --trigger-slug ... --out events.jsonl` (needs `composio dev init`).

**Big gotcha: there are two separate projects.** [DOCS]
- **CLI side.** `composio link` and `composio execute` under a human CLI login act in the **consumer ("For You") project**. Local evidence: the `userId` is `consumer-d1ce896b-...`.
- **SDK side.** The SDK with an `ak_` project key acts in a **developer project**.
- Connections made in one are **not visible** in the other. If the app uses the SDK, connect accounts through the SDK (`session.authorize`) or through `composio dev connected-accounts link --user-id <id>`, not through plain `composio link`.
- Source: https://docs.composio.dev/kb/guide/consumer-project-boundaries-and-auth-selection.md

---

## 1. Packages and versions (`npm view`, 2026-10-19) [VERIFIED]

| Package | Version | Notes |
|---|---|---|
| `@composio/core` | **0.25.0** | Core SDK, ESM-only. `engines.node >=22.22.3`. Peer dependency is `zod >=3.25.76 <5`. Deps include `openai`, `pusher-js` (trigger websocket) and `@composio/client 2.0.0-rc.17`. |
| `@composio/slim` | 0.25.0 | Same API with a smaller install. The core package ships its docs and TS source. |
| `@composio/openai` | 0.13.0 | Plain OpenAI Chat Completions provider. Core's default provider is OpenAIProvider. |
| `@composio/anthropic` | 0.11.5 | Anthropic Messages provider. |
| `@composio/vercel` | 0.12.1 | Vercel AI SDK provider. |
| `@composio/openai-agents` | 0.11.2 | OpenAI Agents SDK provider. Do not confuse it with `@composio/openai`. |
| `@composio/claude-agent-sdk` | 0.12.2 | Claude Agent SDK provider. |
| `@composio/mastra` | 0.10.6 | |
| `@composio/langchain` | 0.11.2 | |
| `@composio/client` | 0.1.0-alpha.76 | Low-level REST client. Not needed directly. |
| `composio-core` | 0.5.39 | **LEGACY v1. Do not use.** |
| `@composio/cli` | not on npm (404) | The CLI installs with `curl -fsSL https://composio.dev/install \| sh`. |

There is no Cline-specific provider. A grep of the full docs for "cline" found nothing.

Subpath exports of `@composio/core`:
- `.`
- `./platform` (node and workerd)
- `./generated`
- `./experimental`
- `./utils/ssrf-guard`

Installed CLI: **0.2.32** (`@composio/cli@0.2.32`). `~/.composio/update-check.json` reports the latest as **0.4.5**. The docs reference newer features, so `composio upgrade` is recommended. [VERIFIED]

---

## 2. Auth model, env vars and the user_id concept

### Credentials

From the SDK `ComposioConfig` typings, verbatim [VERIFIED]:
```ts
/**
 * The project API key for the Composio API, sent as the `x-api-key` header.
 * - A string is used as-is; the environment and the CLI user config file are not consulted.
 * - Omitted: falls back to `COMPOSIO_API_KEY`, then to the project key stored by the Composio
 *   CLI in `~/.composio/user_data.json`. A stored user key (`uak_...`) is never used as a
 *   project key; the SDK throws instead of sending it.
 * - `null`: disables project-key authentication entirely ...
 * @example 'ak_1234567890'
 */
apiKey?: string | null;
userApiKey?: string | null;   // uak_*, falls back to COMPOSIO_USER_API_KEY
orgApiKey?: string | null;    // oak_*, falls back to COMPOSIO_ORG_API_KEY
orgId?: string; projectId?: string;  // scope user-key requests (x-org-id / x-project-id)
baseURL?: string | null;      // default https://backend.composio.dev
allowTracking?: boolean;      // default true (telemetry)
dangerouslyAllowAutoUploadDownloadFiles?: boolean; // default false
toolkitVersions?: ...         // pin versions (needed for legacy direct execution)
provider?: ...                // default OpenAIProvider
```

Environment variables seen in the SDK bundle [VERIFIED by grepping dist]:
- `COMPOSIO_API_KEY`
- `COMPOSIO_USER_API_KEY`
- `COMPOSIO_ORG_API_KEY`
- `COMPOSIO_BASE_URL`
- `COMPOSIO_LOG_LEVEL`
- `COMPOSIO_WEBHOOK_SECRET`
- `COMPOSIO_TOOLKIT_VERSION_<TOOLKIT>`, for example `COMPOSIO_TOOLKIT_VERSION_GMAIL`
- `COMPOSIO_DIR`

Key prefixes [DOCS]:

| Prefix | What it is | Where it goes |
|---|---|---|
| `ak_` | Project API key | `x-api-key` header; used by the SDK and REST |
| `uak_` | User API key | What the CLI login stores |
| `oak_` | Org key | `x-org-api-key` |
| `ck_` | Consumer key for Composio Connect MCP | `x-consumer-api-key` |

`.env` from the quickstart (https://docs.composio.dev/docs/quickstart.md):
```bash
COMPOSIO_API_KEY=your_composio_api_key
```

**Local state on this machine** [VERIFIED; values not printed]:
- `~/.composio/user_data.json` has the fields `api_key` (a **uak_** key), `base_url=https://backend.composio.dev`, `org_id` and `test_user_id`.
- `composio whoami` reports `account_type: human` and org `mehdi991_workspace`.
- `composio connections list` returned `{}`, so **no apps are connected yet**.
- One developer project exists: `pr_fnq5SM4XmlFn` (`mehdi991_workspace_first_project`).

How to get an `ak_` key:
- The dashboard Settings page lists API keys.
- The unattended route is `composio login --agent`. The key then lands in `~/.composio/agent.json` under `.composio.api_key`. That route is refused while a human is logged in. Source: https://docs.composio.dev/docs/agent-setup/unattended-authentication.md

### user_id [DOCS]

From https://docs.composio.dev/docs/how-composio-works.md:
> A user is an identifier from your app. Composio stores connections under that ID, so tools run with the right account and stay isolated from other users. ... **Recommended:** database UUID or primary key ... **Avoid:** email addresses ... **Never:** `default` in production.

For a single-user hackathon app, a constant such as `"local-user"` is fine. Each user ID has separate connections.

Terminology mapping (old to new):

| Old term | New term |
|---|---|
| entity ID | user ID |
| actions | tools |
| apps | toolkits |
| integration | auth config (`ac_...`) |
| connection | connected account (`ca_...`) |

### REST API

The current version is v3.1 at `https://backend.composio.dev/api/v3.1`, authenticated with the header `x-api-key: <ak_ key>`.

Smoke test, verbatim from the unattended-auth doc:
```bash
curl --fail-with-body --silent --show-error \
  https://backend.composio.dev/api/v3.1/tools/execute/HACKERNEWS_GET_USER \
  -H "x-api-key: $COMPOSIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"arguments":{"username":"pg"}}'
```

---

## 3. Getting tools for an agent

### 3.1 Sessions are the recommended path [DOCS]

Source: https://docs.composio.dev/docs/how-composio-works.md
```typescript
import { Composio } from '@composio/core';
const composio = new Composio({ apiKey: 'your_api_key' });
const session = await composio.create("user_123");

const tools = await session.tools();
```

- `composio.create` is an alias of `composio.sessions.create` (the canonical form).
- By default `session.tools()` returns **meta tools** formatted for the configured provider (default: OpenAI function format).
- Meta tools listed at https://docs.composio.dev/docs/composio-connect.md:
  - `COMPOSIO_SEARCH_TOOLS`
  - `COMPOSIO_GET_TOOL_SCHEMAS`
  - `COMPOSIO_MULTI_EXECUTE_TOOL` (up to 50 per call)
  - `COMPOSIO_MANAGE_CONNECTIONS`
  - `COMPOSIO_WAIT_FOR_CONNECTIONS`
  - `COMPOSIO_REMOTE_WORKBENCH`
  - `COMPOSIO_REMOTE_BASH_TOOL`
  - Also seen in the SDK: `COMPOSIO_PROXY_EXECUTE` (opt-in) and `COMPOSIO_SUBMIT_FEEDBACK`.
- Sessions persist and don't expire. Store `session.sessionId` and reuse it:
  ```typescript
  const session = await composio.use("session_id");
  const tools = await session.tools();
  ```

### 3.2 MCP URL for a session

This is the simplest route for any MCP-capable agent, including Cline if its SDK accepts remote MCP servers. Source: https://docs.composio.dev/docs/sessions-via-mcp.md

```typescript
import { Composio } from "@composio/core";

const composio = new Composio();
const session = await composio.create("user_123", { mcp: true });

const mcpUrl = session.mcp.url;
const mcpHeaders = session.mcp.headers;
```

- In the typings, `session.mcp` is `{ headers?: Record<string,string>; type: 'http' | 'sse'; url: string }`. [VERIFIED]
- The headers carry the credential that created the session (`x-api-key` for a project key). Treat them as a secret.
- Requires `@composio/core >= 0.19.1`.
- To resume a stored session with MCP, use `composio.use(sessionId, { mcp: true })`.

Fixed tool set over MCP, verbatim:
```typescript
import { Composio, SessionPreset } from "@composio/core";

const composio = new Composio();

const session = await composio.create("user_123", {
  toolkits: ["gmail"],
  tools: { gmail: { enable: ["GMAIL_FETCH_EMAILS", "GMAIL_CREATE_EMAIL_DRAFT"] } },
  sessionPreset: SessionPreset.DIRECT_TOOLS,
  mcp: true,
});

// A single MCP URL that exposes just these two tools
console.log(session.mcp.url);
```

Generic MCP client wiring, using the Vercel AI SDK example from the docs:
```typescript
const client = await createMCPClient({
  transport: { type: "http", url: mcp.url, headers: mcp.headers },
});
const tools = await client.tools();
```

**MCP trade-offs** [DOCS]:
- `beforeExecute` / `afterExecute` modifiers and `modifySchema` do **not** run over MCP.
- In-process custom tools (`experimental_createTool`) are **not** exposed over MCP.
- If the app needs to gate or approve tool calls itself, use native tools (3.3) or Composio's approvals feature (`tags.require_approval`, see section 9).

**Alternative without the SDK: Composio Connect (personal "For You" MCP).** Source: https://docs.composio.dev/docs/composio-connect.md

- Shared URL: `https://connect.composio.dev/mcp`, streamable HTTP.
- Auth is either OAuth in an MCP client that supports it, or the header `x-consumer-api-key: ck_...` (copy the key from the For You dashboard).
- It uses the **consumer project**, which is the same one the CLI's `composio link` connections live in.

Verbatim config:
```json
{
  "mcpServers": {
    "composio": {
      "url": "https://connect.composio.dev/mcp",
      "headers": {
        "x-consumer-api-key": "YOUR_CONSUMER_KEY"
      }
    }
  }
}
```

### 3.3 Native tools in your own harness (no MCP)

Source: https://docs.composio.dev/examples/harness-integration.md. This is the best fit for wiring into the Cline SDK's own tool registry.

```typescript
import { Composio } from '@composio/core';

const composio = new Composio();

// userId is your own identifier, stable for the life of the account
const session = await composio.create('user_123', {
  manageConnections: false,
  sandbox: { enable: false },
});
```

Fetch raw JSON Schemas, with no provider wrapping:
```typescript
const connected = await session.toolkits({ isConnected: true, limit: 100 });
const slugs = connected.items.map(toolkit => toolkit.slug);

const tools = await composio.tools.getRawComposioTools({
  toolkits: slugs,
  important: false,
});

for (const tool of tools) {
  index.add({
    name: tool.slug,                  // "GITHUB_CREATE_AN_ISSUE"
    description: tool.description,
    parameters: tool.inputParameters, // JSON Schema
  });
}
```

- **Gotcha:** without `important: false` (or `tools`, `tags`, `search` or `limit`), TS returns only a curated subset of each toolkit.
- Single tool lookup: `composio.tools.getRawComposioToolBySlug("GMAIL_SEND_EMAIL")` returns `.name`, `.description`, `.inputParameters`, `.outputParameters` and `.version`.
- To get the session's exact tool set instead: create the session with `preload: { tools: 'all' }` and a toolkit filter, then call `composio.tools.getRawToolRouterSessionTools(session.sessionId)`.

Custom provider to convert tools straight into the Cline tool format. Source: https://docs.composio.dev/docs/providers/custom-providers/typescript.md
```typescript
import { BaseAgenticProvider, Tool, ExecuteToolFn } from '@composio/core';

export class MyAgentProvider extends BaseAgenticProvider {
  readonly name = 'my-agent-platform';
  override wrapTool(tool: Tool, executeToolFn: ExecuteToolFn): AgentTool {
    return {
      name: tool.slug,
      description: tool.description || '',
      schema: tool.inputParameters || {},
      execute: async (args: Record<string, unknown>) => {
        const result = await executeToolFn(tool.slug, args);
        if (!result.successful) {
          throw new Error(result.error || 'Tool execution failed');
        }
        return result.data;
      },
    };
  }
  override wrapTools(tools: Tool[], executeToolFn: ExecuteToolFn) { return tools.map(t => this.wrapTool(t, executeToolFn)); }
}
// const composio = new Composio({ provider: new MyAgentProvider() });
// const session = await composio.create(userId, {...}); const clineTools = await session.tools();
```

[UNCERTAIN] I did not verify that the `executeToolFn` passed to an agentic provider via `session.tools()` routes through the session. The docs say "Agentic providers execute session tools on their own", which suggests it does. The safe pattern is either:
- non-agentic wrapping plus your own dispatcher calling `session.execute()`, or
- the agentic pattern, tested once.

There are also strict-schema helpers: `toStrictJsonSchema()` and `omitNullToolArguments()` from `@composio/core`.

### 3.4 Session configuration cheatsheet

Source: https://docs.composio.dev/docs/configuring-sessions.md. All snippets are verbatim TS.

```typescript
// restrict toolkits
const session = await composio.create("user_123", { toolkits: ["github", "gmail", "slack"] });
// restrict tools within toolkits
const session = await composio.create("user_123", {
  tools: {
    gmail: { enable: ["GMAIL_SEND_EMAIL", "GMAIL_FETCH_EMAILS"] },
    github: { enable: ["GITHUB_CREATE_ISSUE", "GITHUB_GET_ISSUE"] }
  }
});
// block destructive tools by tag
const session = await composio.create("user_123", { tags: { disable: ["destructiveHint"] } });
// preload known tools but keep meta tools
const session = await composio.create("user_123", {
  toolkits: ["gmail"],
  preload: { tools: ["GMAIL_FETCH_EMAILS", "GMAIL_CREATE_EMAIL_DRAFT"] },
});
// direct tools preset + re-enable connection mgmt & sandbox
const session = await composio.create("user_123", {
  toolkits: ["gmail"],
  tools: { gmail: { enable: ["GMAIL_FETCH_EMAILS", "GMAIL_CREATE_EMAIL_DRAFT"] } },
  sessionPreset: SessionPreset.DIRECT_TOOLS,
  manageConnections: { enable: true },
  sandbox: { enable: true },
});
// disable sandbox
const session = await composio.create("user_123", { sandbox: { enable: false } });
// pick a specific connected account / custom auth config
const session = await composio.create("user_123", { connectedAccounts: { gmail: ["ca_work_gmail"] } });
const session = await composio.create("user_123", { authConfigs: { github: "ac_your_github_config" } });
```

Notes:
- Tags are `readOnlyHint`, `createHint`, `updateHint` and `destructiveHint`.
- `session.update({...})` patches a session. **Maps replace, they don't merge.**
- `toolkits: { enable: [] }` means no app toolkits at all.
- Unknown root keys return a 400.
- Keep preloads under about 20 tools.

### 3.5 Legacy direct execution (supported, not recommended)

`composio.tools.get(userId, { toolkits: [...] })` and `composio.tools.execute(slug, { userId, arguments, version })`.

- These require a pinned toolkit version, set either with `toolkitVersions` in the constructor or `version` per call.
- Otherwise the call throws `ComposioToolVersionRequiredError` unless `dangerouslySkipVersionCheck: true` is set.
- Meta tools fail on this path with `"can only be called inside a tool-router session"`.

Source: https://docs.composio.dev/reference/sdk-reference/typescript/tools.md
```typescript
const result = await composio.tools.execute('HACKERNEWS_GET_USER', {
  userId: 'default',
  arguments: { userId: 'pg' },
  dangerouslySkipVersionCheck: true // Allows execution with "latest" version
});
```

---

## 4. Executing a tool directly from code

`session.execute`, verbatim from https://docs.composio.dev/examples/harness-integration.md:
```typescript
const result = await session.execute('GITHUB_CREATE_AN_ISSUE', {
  owner: 'ComposioHQ',
  repo: 'composio',
  title: 'Tool schemas drift between staging and prod',
  body: 'Filed by the harness.',
});

if (result.error) {
  throw new Error(result.error);
}

console.log(result.data);
console.log(result.logId); // look this up in the dashboard
```

Response type, from the SDK typings [VERIFIED]:
```ts
type ToolRouterSessionExecuteResponse = {
  data: Record<string, unknown>;
  error: string | null;
  logId: string;
  resultType: "completed" | "failed";   // use THIS, not `error`, to detect failure
  instantCharge?: unknown;
};
// legacy composio.tools.execute → { data, error, successful: boolean, logId?, sessionInfo? }
```

Notes [DOCS]:
- "A failed execution can have an empty `error`", so check `resultType`.
- Arguments are not validated locally. Upstream errors come back in `error`, not as exceptions. Exceptions mean transport failures.
- A session tool may throw `ComposioToolInputRequiredError` (exported from `@composio/core`) when an approval is needed. It carries `inputRequests` and `requestState`. To continue, re-call with `inputResponses` and the same `requestState`.

Meta tool call:
```typescript
const result = await session.executeMeta("COMPOSIO_SEARCH_TOOLS", {
  queries: [{ use_case: "send an email" }],
});
console.log(result.data, result.resultType);
```

Raw API passthrough, from https://docs.composio.dev/docs/extending-sessions/proxy-execute.md:
```typescript
const { status, data } = await session.proxyExecute({
  toolkit: 'github',
  endpoint: '/repos/composiohq/composio/issues/1',
  method: 'GET',
  parameters: [
    { name: 'Accept', value: 'application/vnd.github.v3+json', in: 'header' },
  ],
});
```

Proxy gotchas:
- The endpoint is relative to the toolkit base URL. Google Calendar's base URL already includes `/calendar/v3`.
- Cross-domain calls are rejected.

---

## 5. Executing from the CLI (exact syntax, real output) [VERIFIED on CLI 0.2.32]

The CLI isn't on PATH by default here. Use `/home/mehdi/.composio/composio` or `export PATH=$PATH:/home/mehdi/.composio`. The installer normally symlinks it to `~/.local/bin/composio`.

```
composio search <query...> [--toolkits text] [--limit integer] [--human]
composio execute <slug> [-d, --data text] [--file path] [--account selector] [--dry-run] [--get-schema]
                        [--skip-connection-check] [--skip-tool-params-check] [--skip-checks]
composio execute -p <slug> -d <json> <slug> -d <json> ...      # parallel
composio link [<toolkit>] [--no-wait] [--no-browser] [--alias text] [--list]
composio run <code> [-- ...args] | run -f <file> [-- ...args] [--dry-run] [--debug] [--logs-off]
composio proxy <url> --toolkit <slug> [-X method] [-H "Name: value"]... [-d data]
composio tools list <toolkit> [--query text] [--tags text] [--limit n]
composio tools info <slug>
composio triggers list <toolkit> [--limit n]
composio triggers info <slug>
composio connections list [--toolkit slug]      # JSON
composio connections remove <account>
composio artifacts cwd                          # → /tmp/composio
composio whoami | login | logout | upgrade | config experimental [<feature> [on|off]]
```

How `-d` is parsed:
- It accepts JSON or JS-object syntax, such as `-d '{ repo: "foo" }'`.
- `@file` reads from a file, and `-` reads from stdin.

Search output, which is JSON by default. Real output trimmed from `composio search "send email"`:
```json
{
  "results": [{
    "use_case": "send email",
    "recommended_plan_steps": ["..."],
    "known_pitfalls": ["[GMAIL_SEND_EMAIL] 401/403 commonly indicates missing or insufficient Gmail authorization scopes; ..."],
    "difficulty": "easy",
    "primary_tool_slugs": ["GMAIL_SEND_EMAIL", "OUTLOOK_SEND_EMAIL"],
    "related_tool_slugs": ["GMAIL_CREATE_EMAIL_DRAFT", "OUTLOOK_CREATE_DRAFT", "GMAIL_SEARCH_PEOPLE", "..."],
    "toolkits": ["gmail", "googledrive", "outlook", "sendgrid"]
  }],
  "tool_schemas": { "primary": { "GMAIL_SEND_EMAIL": "~/.composio/tool_definitions/GMAIL_SEND_EMAIL.json" } },
  "connected_toolkits": [],
  "next_steps": { "steps": [
    { "action": "Link a user account", "command": "composio link gmail" },
    { "action": "Execute a tool", "command": "composio execute \"GMAIL_SEND_EMAIL\" -d '{...}'" } ] }
}
```

`--get-schema` output:
- Shape: `{ "slug", "version": "20261018_00", "schemaPath", "inputSchema": {JSON Schema} }`.
- Schemas are cached in `~/.composio/tool_definitions/<SLUG>.json`.

`--dry-run` output (real):
```json
{
  "successful": true,
  "dryRun": true,
  "slug": "GMAIL_SEND_EMAIL",
  "arguments": { "recipient_email": "test@example.com", "subject": "Hi", "body": "Hello" },
  "userId": "consumer-d1ce896b-...",
  "schemaPath": "/home/mehdi/.composio/tool_definitions/GMAIL_SEND_EMAIL.json",
  "schemaVersion": "20261018_00"
}
```

Real execute with no connection, using the read-only `GOOGLECALENDAR_EVENTS_LIST`. **The exit code is 0** even though the call failed:
```json
{
  "successful": false,
  "error": "No active connection found for toolkit \"googlecalendar\". Run `composio link googlecalendar`, then retry.",
  "slug": "ToolRouterV2_NoActiveConnection"
}
```

Validation failure (missing required args):
- Exits **1**.
- Prints a pretty, ANSI-coloured `ToolInputValidationError` to the terminal, with lines like `- title: Required`.
- It is not JSON.

**Gotcha for wrappers:** parse stdout JSON and check `successful`. Don't rely on the exit code alone. Strip ANSI codes.

On success, the result is `{ successful: true, data: {...}, ... }`. [UNCERTAIN] I didn't execute a real tool, so the exact success envelope is unconfirmed. `composio run` helpers expose `.data`, as in `issue.data.html_url`.

`composio run --dry-run` output (real):
```
RUN_LOG_FILE=/tmp/composio-run-XXXX/artifacts/run.log
{"successful":true,"dryRun":true,"slug":"GMAIL_CREATE_EMAIL_DRAFT","arguments":{...},"userId":"consumer-...","schemaPath":"...","schemaVersion":"20261018_00"}
```

**CLI caveat** [DOCS] (https://docs.composio.dev/docs/cli.md):
> Don't build a production integration on top of the CLI. It's in constant development, and Composio doesn't offer CLI-level SLAs ... That said, the CLI works well as a bootstrap or helper layer for agent-native products.

For a hackathon, shelling out to `composio execute ... -d @args.json` is viable. It uses the **consumer project** connections made by `composio link`, needs no `ak_` key, and the user is already logged in.

---

## 6. Connecting accounts (link flow)

### SDK

Source: https://docs.composio.dev/docs/authentication/manually-authenticating.md
```typescript
const session = await composio.create("user_123");

const connectionRequest = await session.authorize("gmail");

console.log(connectionRequest.redirectUrl);
// https://connect.composio.dev/link/ln_abc123

const connectedAccount = await connectionRequest.waitForConnection(60000);
console.log(`Connected: ${connectedAccount.id}`);
```

- `session.authorize(slug, { callbackUrl })`: after the redirect, the callback gets `?status=success&connected_account_id=ca_...` appended.
- `session.ensureConnected("gmail", { timeout })` returns `{ toolkit, wasConnected, connectedAccount }`. It reuses an existing connection, whereas `authorize()` always starts a new flow.
- `session.toolkits({ isConnected: true })` lists connected toolkits. Each item looks like `{ slug, name, logo, isNoAuth, connection?: { isActive, connectedAccount?: { id, status } } }`.
- `manageConnections: false` removes the in-chat `COMPOSIO_MANAGE_CONNECTIONS` tool, so you handle auth in your own UI.
- Composio-managed OAuth is the default for Gmail, Google Calendar, Sheets, Docs, Slack and Linear, so no auth config needs creating. If the user closes the link, the account stays `INITIATED`.

Pre-flight pattern, verbatim:
```typescript
const requiredToolkits = ["gmail", "github"];
const session = await composio.create("user_123", { manageConnections: false });
const toolkits = await session.toolkits();
const connected = toolkits.items.filter((t) => t.connection?.connectedAccount).map((t) => t.slug);
const pending = requiredToolkits.filter((slug) => !connected.includes(slug));
for (const slug of pending) {
  const connectionRequest = await session.authorize(slug);
  console.log(`Connect ${slug}: ${connectionRequest.redirectUrl}`);
  await connectionRequest.waitForConnection();
}
```

### CLI

- **Consumer project:**
  - `composio link gmail` opens a browser and waits.
  - `--no-browser` prints the URL instead.
  - `--no-wait` exits immediately.
  - `--list` lists existing accounts.
  - `--alias work` adds a second account; this needs the experimental `multi_account` flag.
- **Developer project (what the SDK sees):**
  - `composio dev connected-accounts link [--auth-config ac_x] [--user-id <id>] [<toolkit>]`
  - This requires running `composio dev init` in the directory first. That writes local project context; I did not run it.

Toolkit slugs observed: `gmail`, `googlecalendar` (not `google_calendar`, although CLI help examples use the latter), `googlesheets`, `googledocs`, `googledrive`, `slack`, `slackbot`, `linear`, `outlook`.

---

## 7. Triggers: events to files

### Concepts

Source: https://docs.composio.dev/docs/triggers.md
- A trigger *type* is a slug, such as `GMAIL_NEW_GMAIL_MESSAGE`.
- A trigger *instance* (`ti_...`) is that type activated for one user's connected account.
- Gmail and Google Calendar triggers are **polling**:
  > Polling | Composio checks the provider on a schedule. | Up to ~15 min on Composio-managed auth | Gmail, Google Calendar
- Slack and Linear triggers are mostly webhook (realtime).

### SDK: create a trigger, then subscribe over websocket (no public URL needed)

Sources: https://docs.composio.dev/docs/setting-up-triggers/creating-triggers.md and https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events.md

```typescript
const triggerType = await composio.triggers.getType('GITHUB_COMMIT_EVENT');
console.log(triggerType.config);

const trigger = await composio.triggers.create(userId, 'GITHUB_COMMIT_EVENT', {
  triggerConfig: { owner: 'your-repo-owner', repo: 'your-repo-name' },
});
console.log(`Trigger created: ${trigger.triggerId}`);
// optional: connectedAccountId: 'ca_def456'
```
```typescript
await composio.triggers.subscribe(
  data => {
    console.log('Event received:', data);
  },
  { triggerId: 'your_trigger_id' }
);
// third arg: error => console.error('Trigger subscription failed:', error)
```

How `subscribe` behaves:
- It uses Pusher websockets.
- Filters are `triggerId`, `triggerSlug`, `connectedAccountId`, `toolkits` and `userId`. Passing no filters receives all project events.
- The docs say it is meant for prototyping. A desktop or local agent app with no public URL is a valid use.

Callback payload type (`IncomingTriggerPayload`) [VERIFIED in typings]:
```ts
{ id, uuid, triggerSlug, toolkitSlug, userId,
  payload?: Record<string, unknown>,          // the event data, e.g. Gmail fields below
  originalPayload?: Record<string, unknown>,
  metadata: { id, uuid, toolkitSlug, triggerSlug, triggerData?, triggerConfig,
              connectedAccount: { id, uuid, authConfigId, authConfigUUID, userId, status } } }
```

Event-to-file sketch (my code, not from the docs):
```ts
import { writeFile, mkdir } from 'node:fs/promises';
await mkdir('./inbox', { recursive: true });
await composio.triggers.subscribe(async (evt) => {
  const name = `${evt.triggerSlug}-${evt.id}.json`;
  await writeFile(`./inbox/${name}`, JSON.stringify(evt.payload ?? evt, null, 2));
}, { triggerSlug: ['GMAIL_NEW_GMAIL_MESSAGE'] as any, userId: 'local-user' });
```
[UNCERTAIN] I did not verify whether the `triggerSlug` filter accepts a string or an array. Check `TriggerSubscribeParams`.

Management calls:
- `composio.triggers.listActive({ connectedAccountIds, triggerIds, triggerNames, showDisabled })`
- `.enable(id)`, `.disable(id)` and `.delete(id)`

Production route, using a webhook:
```typescript
const subscription = await composio.triggers.setWebhookSubscription({ webhookUrl: 'https://your-app.com/webhooks/composio' });
// handler:
const result = await composio.triggers.parse(request, { verifySecret: process.env.COMPOSIO_WEBHOOK_SECRET });
if (result.rawPayload.type === 'composio.trigger.message') { const event = result.payload; /* event.triggerSlug, event.payload */ }
```

V3 webhook envelope: `{ id, type: "composio.trigger.message", metadata: { log_id, trigger_slug, trigger_id, connected_account_id, auth_config_id, user_id }, data: {...}, timestamp }`.

Signature check: HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{rawBody}`, with a 300 s tolerance.

### CLI listening

**Documented and present in 0.2.32: `composio dev listen`** (developer project; needs `composio dev init`). Verbatim help:
```
composio dev listen [--toolkits text] [--trigger-slug text] [--trigger-id text] [--connected-account-id text]
                    [--user-id text] [--json] [--table] [--max-events int] [--forward url] [--out file]
```

Doc examples (https://docs.composio.dev/docs/cli.md):
```bash
composio dev listen --trigger-slug GMAIL_NEW_GMAIL_MESSAGE --json --max-events 5
composio dev listen --toolkits github --forward https://example.com/webhook
composio dev listen --toolkits slack --out ./events.jsonl
composio dev triggers listen --forward "http://localhost:8000/webhooks/composio"   # signs with COMPOSIO_WEBHOOK_SECRET
composio dev triggers create [--connected-account-id ca_x] [--trigger-config '<json>'] <TRIGGER_SLUG>
composio dev triggers status | enable <ti_id> | disable <ti_id>   # disable is guarded
```

Running it here gives `Error • No developer project configured for this directory. Run composio dev init.` [VERIFIED]

**Top-level `composio listen` (consumer project): [UNCERTAIN]**
- Not in the current public docs.
- Hidden in CLI 0.2.32 behind an experimental flag. `composio config experimental` lists the known features `listen`, `local_tools` and `multi_account`; `listen` is currently `off`.
- Syntax from preview docs (https://docs-1v89wpn87.preview.composio.dev/docs/cli.md):
  ```bash
  composio listen GMAIL_NEW_GMAIL_MESSAGE --timeout 5m
  composio listen GMAIL_NEW_GMAIL_MESSAGE --max-events 5
  composio listen SLACK_RECEIVE_MESSAGE -p '{ trigger_config: { channel: "C123" } }' --max-events 10
  composio listen GMAIL_NEW_GMAIL_MESSAGE -p @trigger.json --stream
  composio listen GMAIL_NEW_GMAIL_MESSAGE --timeout 1hr --stream '.data.threadId'
  ```
- Per those preview docs, it "creates a temporary subscription for consumer-project trigger events and writes each payload into the session artifact folder" (`composio artifacts cwd`, which is `/tmp/composio` here). The trigger is disabled on cleanup.
- To try it: `composio config experimental listen on`, then `composio listen --help`. Upgrading to CLI 0.4.5 may change this.

### Relevant trigger slugs [VERIFIED via `composio triggers list/info`]

**Gmail**

`GMAIL_NEW_GMAIL_MESSAGE` (poll):
- Config: `interval` (minutes, default 2), `labelIds` (default `"INBOX"`), `query` (Gmail search syntax), `userId` (`"me"`).
- Payload: `id`, `message_id`, `thread_id`, `sender`, `to`, `subject`, `message_text`, `message_timestamp`, `label_ids[]`, `attachment_list[]`, `payload{}`, `preview{}`.

`GMAIL_EMAIL_SENT_TRIGGER` (poll).

**Google Calendar**

`GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER` (poll):
- Config: `calendarId` (default `"primary"`), `interval` (default 2), `showDeleted`.
- Payload: `event_id`, `calendar_id`, `summary`, `start_time`, `end_time`, `organizer_email`, `organizer_name`.

Other calendar triggers:
- `GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER`
- `GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_UPDATED_TRIGGER`
- `GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER` (full data)
- `GOOGLECALENDAR_EVENT_CANCELED_DELETED_TRIGGER`
- `GOOGLECALENDAR_ATTENDEE_RESPONSE_CHANGED_TRIGGER`
- `GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CHANGE_TRIGGER` (webhook, "soon to be deprecated")

**Slack** (all webhook):
- `SLACK_CHANNEL_MESSAGE_RECEIVED`
- `SLACK_DIRECT_MESSAGE_RECEIVED`
- `SLACK_MESSAGE_REACTION_ADDED`
- `SLACK_CHANNEL_CREATED`

**Linear**
- `LINEAR_ISSUE_CREATED_TRIGGER` and `LINEAR_ISSUE_UPDATED_TRIGGER` (webhook)
- `LINEAR_COMMENT_EVENT_TRIGGER`
- `LINEAR_PRIVATE_TEAM_ISSUE_CREATED` (poll)

**Google Sheets**
- `GOOGLESHEETS_NEW_ROWS_TRIGGER`
- `GOOGLESHEETS_CELL_RANGE_VALUES_CHANGED_TRIGGER`

---

## 8. Toolkits and exact tool slugs for the target use cases [VERIFIED via `composio search` and `--get-schema`]

Schema versions are as of 2026-10-19. Parameters marked * are required.

| Use case | Primary slug | Required / key inputs | Related slugs |
|---|---|---|---|
| Gmail send | `GMAIL_SEND_EMAIL` (v20261018_00) | `recipient_email` (alias `to`), `subject`, `body`, `is_html` (default false), `cc[]`, `bcc[]`, `extra_recipients[]`, `attachment`, `from_email`, `user_id` (default "me"). You need at least one of to/cc/bcc, and subject or body. | `GMAIL_SEARCH_PEOPLE`, `OUTLOOK_SEND_EMAIL` |
| Gmail draft | `GMAIL_CREATE_EMAIL_DRAFT` | `recipient_email`, `subject`, `body`, `is_html`, `thread_id` (for a reply draft), `cc`, `bcc`, `attachment` | `GMAIL_SEND_DRAFT`, `GMAIL_UPDATE_DRAFT`, `GMAIL_LIST_DRAFTS`, `GMAIL_GET_DRAFT`, `GMAIL_DELETE_DRAFT` |
| Gmail read | `GMAIL_FETCH_EMAILS` | `query` (Gmail syntax), `max_results` (**default 1**, max 500), `label_ids[]`, `page_token`, `include_payload`, `verbose`, `ids_only` | |
| Calendar list events | `GOOGLECALENDAR_EVENTS_LIST` (v20261010_00) | `calendarId` (default "primary"), `timeMin`, `timeMax` (RFC3339), `singleEvents`, `orderBy` ("startTime" or "updated"), `maxResults`, `pageToken`, `query`, `timeZone`, `fields` | `GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS` (uses `time_min` / `time_max`), `GOOGLECALENDAR_FIND_EVENT`, `GOOGLECALENDAR_LIST_CALENDARS`, `GOOGLECALENDAR_GET_CURRENT_DATE_TIME` |
| Sheets create | `GOOGLESHEETS_CREATE_GOOGLE_SHEET1` (note the trailing "1") | `title`, `folder_id`, `folder_name` | |
| Sheets append row | `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND` | `spreadsheetId`*, `range`*, `values`* (2D array), `valueInputOption`* | `GOOGLESHEETS_UPDATE_VALUES_BATCH` (search's top pick for "add row"), `GOOGLESHEETS_VALUES_UPDATE`, `GOOGLESHEETS_UPSERT_ROWS`, `GOOGLESHEETS_GET_SHEET_NAMES`, `GOOGLESHEETS_SEARCH_SPREADSHEETS` |
| Docs create | `GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN` (v20261008_00) | `title`*, `markdown_text` (alias `content`), `image_assets[]` | `GOOGLEDOCS_CREATE_DOCUMENT`, `GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN` (overwrites the whole body), `GOOGLEDOCS_UPDATE_DOCUMENT_SECTION_MARKDOWN`, `GOOGLEDOCS_INSERT_TEXT_ACTION`, `GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT` |
| Slack post | `SLACK_SEND_MESSAGE` (v20261015_00) | `channel`* (ID or name without "#"), `markdown_text` (use for normal text) or `blocks` + `fallback_text`, `thread_ts`, `reply_broadcast`, `unfurl_links` | `SLACK_FIND_CHANNELS`, `SLACK_UPDATES_A_SLACK_MESSAGE`, `SLACK_SCHEDULE_MESSAGE`, `SLACKBOT_SEND_MESSAGE` |
| Linear create issue | `LINEAR_CREATE_LINEAR_ISSUE` (v20260924_00) | `title`*, `team_id`* (UUID), `description` (markdown), `priority` (0=none, 1=urgent … 4=low), `assignee_id`, `state_id`, `project_id`, `label_ids[]`, `due_date`, `estimate`, `parent_id`, `cycle_id` | `LINEAR_LIST_LINEAR_TEAMS` (call first to get `team_id`), `LINEAR_LIST_LINEAR_STATES`, `LINEAR_LIST_LINEAR_PROJECTS`, `LINEAR_LIST_LINEAR_USERS`, `LINEAR_GET_ISSUE_DEFAULTS` |

Slug naming caveats:
- CLI help text uses `SLACK_SEND_A_MESSAGE_TO_A_SLACK_CHANNEL` and `GITHUB_CREATE_AN_ISSUE`, while current search returns `SLACK_SEND_MESSAGE`.
- Slugs change across toolkit versions, so always confirm with `composio search` or `getRawComposioToolBySlug`.

Known pitfalls, verbatim from the `composio search` output:
- `[GOOGLECALENDAR_EVENTS_LIST] orderBy=startTime requires singleEvents=true` (the tool auto-sets it). `timeMax` is exclusive, and timestamps must be RFC3339 with an offset.
- `[GMAIL_CREATE_EMAIL_DRAFT] Use the draft id in data.id ... data.message.id is not the draft id.` HTML needs `is_html=true`.
- `[GOOGLESHEETS_CREATE_GOOGLE_SHEET1] Downstream tools require the ID at data.spreadsheetId`. The default first-tab name may be localized.
- `[GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN] Only ONE table is allowed per call`. Rely on the returned `document_id` / `document_url`.
- `[SLACK_SEND_MESSAGE] Not idempotent—retries can create duplicate posts`. HTTP 429 can occur, so respect Retry-After.
- `[LINEAR_CREATE_LINEAR_ISSUE] Can return status_code=200 with successful=false when project_id is incompatible with team_id`. `[LINEAR_LIST_LINEAR_TEAMS] Teams may appear under response.data.teams`.

---

## 9. Rate limits, retries and other gotchas

**Rate limits** (https://docs.composio.dev/reference/rate-limits.md):

| Plan | Limit |
|---|---|
| Hobby | 2,000 requests/min |
| Pro | 10,000 requests/min |
| Enterprise | custom |

- Limits are per organization over a fixed one-minute window, shared by all endpoints.
- Headers: `X-RateLimit`, `X-RateLimit-Remaining`, `X-RateLimit-Window-Size`, and `Retry-After` on 429.
- Provider quotas, such as Google API limits, are separate.

**Retries** (https://docs.composio.dev/kb/guide/sdk-tool-execution-retries.md):
> TypeScript SDK 0.14.0 changed tool execution and Proxy Execute so non-idempotent writes are not automatically retried ... check the execution log or provider state before manually retrying.

`session.executeMeta` is sent once with no retries.

**Other gotchas:**
- **Consumer vs developer project split** (see section 0): CLI `link` connections are not visible to the SDK with an `ak_` key, and the reverse also holds.
- **The SDK refuses a `uak_` key as `apiKey`.** You need an `ak_` project key.
- **ESM-only, Node >= 22.22.3.** If the Cline SDK app is CommonJS, use dynamic `import()`.
- **Execute sessions through the session.** Use `session.execute()` or the provider helper with the session. Passing a user ID uses the legacy path, where meta tools fail with "can only be called inside a tool-router session".
- **Check `resultType`, not `error`.**
- **Default meta tools mean multi-step discovery.**
  - `COMPOSIO_SEARCH_TOOLS` returns plans and pitfalls.
  - `COMPOSIO_MULTI_EXECUTE_TOOL` runs the tools.
  - For a deterministic small app, `SessionPreset.DIRECT_TOOLS` with an allowlist is simpler and cheaper on context.
- **Remote sandbox.** It is on by default (`COMPOSIO_REMOTE_WORKBENCH` / `COMPOSIO_REMOTE_BASH_TOOL`). Disable it with `sandbox: { enable: false }` when the agent has its own shell, which Cline does. It is not covered by Zero Data Retention.
- **Approvals.** Sessions can require user approval per tag, via `tags: { require_approval: ["destructiveHint"] }`. The SDK then throws `ComposioToolInputRequiredError`. Details: https://docs.composio.dev/docs/approvals.md (not read in detail).
- **File uploads.** These need `dangerouslyAllowAutoUploadDownloadFiles: true`. The default allowlist dir is `~/.composio/temp`. The CLI uses `--file`.
- **Trigger latency.** Gmail and Calendar triggers are polling. The configured `interval` defaults to 2 min, but the docs say up to about 15 min on managed auth.
- **Telemetry.** `allowTracking` defaults to true; set it to false to opt out.
- **CLI exit codes.** Execution failures such as a missing connection exit 0 with `"successful": false` in JSON. Validation errors exit 1 with non-JSON pretty output.
- **CLI version.** 0.2.32 is installed and 0.4.5 is available. Docs examples (for example `composio setup`, top-level `listen`) may not match the installed version.

---

## 10. Suggested minimal integration (my synthesis, not verbatim docs)

```ts
// composio.ts  (ESM)
import { Composio, SessionPreset } from '@composio/core';
const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY, allowTracking: false });
const USER = process.env.COMPOSIO_USER_ID ?? 'local-user';

export async function getSession(storedId?: string) {
  if (storedId) return composio.use(storedId, { mcp: true });
  return composio.create(USER, {
    toolkits: ['gmail', 'googlecalendar', 'googlesheets', 'googledocs', 'slack', 'linear'],
    sandbox: { enable: false },
    tags: { require_approval: ['destructiveHint'] }, // optional
    mcp: true,
  });
}
// Option A: give session.mcp.url + session.mcp.headers to Cline's MCP client config.
// Option B: const r = await session.execute('GOOGLECALENDAR_EVENTS_LIST', { calendarId: 'primary', timeMin, timeMax, singleEvents: true, orderBy: 'startTime' });
//           if (r.resultType === 'failed') ...; use r.data
// Connect: const req = await session.authorize('gmail'); show req.redirectUrl; await req.waitForConnection(120_000);
// Events:  await composio.triggers.create(USER, 'GMAIL_NEW_GMAIL_MESSAGE', { triggerConfig: { labelIds: 'INBOX', interval: 1 } });
//          await composio.triggers.subscribe(evt => writeFile(`inbox/${evt.id}.json`, JSON.stringify(evt.payload)), { userId: USER });
```

CLI-only fallback for a hackathon, using the user's existing consumer-project login with no `ak_` key:
```bash
composio link gmail        # once, opens browser
composio execute GOOGLECALENDAR_EVENTS_LIST -d '{ calendarId: "primary", timeMin: "2026-10-19T00:00:00Z", timeMax: "2026-10-26T00:00:00Z", singleEvents: true, orderBy: "startTime" }'
composio execute GMAIL_CREATE_EMAIL_DRAFT -d @draft.json
```
Then parse the stdout JSON and check `.successful`.

---

## Source URLs

- https://docs.composio.dev/llms.txt
- https://docs.composio.dev/docs/quickstart.md
- https://docs.composio.dev/docs/how-composio-works.md
- https://docs.composio.dev/docs/configuring-sessions.md
- https://docs.composio.dev/docs/sessions-via-mcp.md
- https://docs.composio.dev/docs/composio-connect.md
- https://docs.composio.dev/docs/cli.md
- https://docs.composio.dev/docs/authentication/manually-authenticating.md
- https://docs.composio.dev/docs/triggers.md
- https://docs.composio.dev/docs/setting-up-triggers/creating-triggers.md
- https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events.md
- https://docs.composio.dev/docs/setting-up-triggers/managing-triggers.md
- https://docs.composio.dev/examples/harness-integration.md
- https://docs.composio.dev/docs/providers/custom-providers/typescript.md
- https://docs.composio.dev/docs/extending-sessions/proxy-execute.md
- https://docs.composio.dev/reference/sdk-reference/typescript/tools.md
- https://docs.composio.dev/reference/sdk-reference/typescript/session.md
- https://docs.composio.dev/reference/sdk-reference/typescript/composio.md
- https://docs.composio.dev/reference/rate-limits.md
- https://docs.composio.dev/kb/guide/platform-rate-limits.md
- https://docs.composio.dev/kb/guide/sdk-tool-execution-retries.md
- https://docs.composio.dev/kb/guide/consumer-project-boundaries-and-auth-selection.md
- https://docs.composio.dev/docs/agent-setup/unattended-authentication.md
- Preview docs for top-level `composio listen` (unofficial): https://docs-1v89wpn87.preview.composio.dev/docs/cli.md

The raw docs are saved locally in `/tmp/claude-1000/-home-mehdi-cline-hackathon/e505d838-c7ef-40f2-a178-413ce6750c65/scratchpad/docs/`, including `full.txt`, the complete docs dump. CLI tool schemas are in `.../scratchpad/schemas/`.

# S3 — Composio backend spike

Observed 2026-10-19. This was a read-only inspection; no tools were executed, accounts linked, credentials added, CLI state intentionally edited, or CLI upgrade attempted.

- Workspace `.env` contains `COMPOSIO_API_KEY` with a `ck_` prefix, rather than the SDK project-key prefix `ak_`. The calling process has no exported `COMPOSIO_API_KEY`. Secret values were not printed.
- Installed CLI is **0.2.32** (`composio --version`). `composio whoami` succeeds locally and reports `account_type: "human"`; account email and organization are null in this invocation.
- `composio connections list` fails with exit 1 and `services/HttpServerError: Unable to connect. Is the computer able to access the url?`. Current connected accounts could not be verified. The earlier research reported no connections, but that is historical evidence only.
- `composio execute GMAIL_CREATE_EMAIL_DRAFT --get-schema` fails with the same network error. CLI help confirms `--get-schema` fetches the input schema without execution, `--dry-run` validates/previews without execution, and both `--skip-connection-check` and `--skip-tool-params-check` exist. No current remote schema or dry-run success was obtained.
- The verified research records Gmail draft arguments `recipient_email`, `subject`, `body`, `is_html`, and response draft ID `data.id`; Linear creation requires `title` and `team_id`. Treat these as fixtures until live schema retrieval succeeds, and validate actual plans against backend-fetched schemas.

**Backend decision:** follow SPEC §11.1 and use **CLI** for `backend: auto` while no `ak_` key is available. A `ck_` consumer key must not be passed as an SDK project key. Keep the SDK implementation available for an explicitly provided `ak_` project key, with separate SDK-project connections. Expose the selected backend and connection-check errors in `doctor`.

**Unverified / user prerequisites:** network access to Composio, valid current CLI login, and Gmail plus Linear connections. A real draft to the user's own address, Linear issue creation, linking accounts, modifying auth state, and upgrading the CLI all remain deferred pending the user's explicit authorization. Consequently the real-write part of S3 and any 0.4.5 output comparison are not claimed as passing. Offline development can proceed with mocked schemas/execution and both real backend adapters.

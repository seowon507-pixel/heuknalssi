# Supabase shared-state deployment

The backend uses Supabase only from the server for anonymous sessions,
location candidates, analysis records, idempotency records, and fixed-window
rate-limit buckets. Process memory remains the development fallback and never
makes a deployment `READY`.

## Create and review the migration

The Supabase CLI was not installed in the implementation workspace, and no
package or global tool was installed. Therefore
[`shared-state-setup.sql`](./shared-state-setup.sql) is reviewed setup SQL, not
a fabricated migration file.

In a checkout with an authenticated Supabase CLI:

```sh
supabase --version
supabase migration --help
supabase migration new shared_state_foundation
```

Copy the reviewed setup SQL into the CLI-generated migration, review the diff,
and apply it to an isolated or preview project through the repository's normal
Supabase workflow. Run the database security/performance advisors available in
that CLI version before production. If the team temporarily uses the Dashboard
SQL editor, run this file as one unit and still capture the same SQL in a
CLI-generated migration before release.

The SQL intentionally:

- explicitly grants tables and RPCs only to `service_role`;
- revokes table/RPC access from `PUBLIC`, `anon`, and `authenticated`;
- enables RLS on both exposed-schema tables with no public policies;
- uses `SECURITY INVOKER` RPCs with an empty `search_path`;
- hashes rate-limit and idempotency keys before storage;
- performs candidate claims, compare-and-set, idempotency, and counters
  atomically in Postgres;
- removes bounded batches of expired rows during health probes.

These explicit grants are required by Supabase's 2026 Data API defaults. RLS is
defense in depth here; the server secret/legacy service-role key maps to the
`service_role` database role and bypasses RLS, so the key must never reach a
browser.

## Configure the server

Set these values only in the deployment platform's server-side secret store:

```text
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SECRET_KEY=<dedicated sb_secret_... backend key>
```

`SUPABASE_SERVICE_ROLE_KEY` remains a legacy fallback. Prefer a dedicated
`SUPABASE_SECRET_KEY` so it can be rotated independently. Opaque `sb_secret_*`
keys are sent only in the `apikey` header; legacy JWT service-role keys also use
the `Authorization` header. Neither value is serialized into API responses.

## Runtime verification and rollout

1. Deploy the SQL to a non-production Supabase project.
2. Deploy the backend with the two server-only values.
3. Call `GET /api/health/preflight` from an allowed operational origin.
4. Confirm `storage.state` is `READY`, `storage.probe` is
   `ATOMIC_WRITE_READ_DELETE`, and `storage.verifiedAt` is current.
5. Confirm two backend instances can resume one session and retrieve one
   analysis, and that duplicate idempotency keys and rate-limit buckets are
   shared.
6. Promote only after the normal adapter/rule/mapping readiness checks also
   pass. `deploymentState` remains `HOLD` if the storage RPC is missing,
   unreachable, denied, or returns an invalid result.

The health probe performs a transactional write, lock-read, equality check,
and delete through the same Data API role used by runtime state. Merely setting
environment values yields `CONFIGURED_UNVERIFIED`, never `READY`.

Official references:

- <https://supabase.com/docs/guides/api/securing-your-api>
- <https://supabase.com/docs/guides/getting-started/api-keys>
- <https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically>

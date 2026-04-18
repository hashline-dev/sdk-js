# Agent Audit Ledger — Engineering Specification

**Status:** Draft v0.1
**Owner:** Nikola (d00xDev)
**Purpose:** This document is the single source of truth for Claude Code to build the MVP. Treat every "MUST" as a hard requirement and every "SHOULD" as a strong default that requires justification to deviate from. Open questions are collected at the end — do not silently resolve them; flag them.

---

## 1. Product summary

A hosted, append-only, tamper-evident audit log purpose-built for AI agent workloads. Customers send events describing what their agents did (prompts, tool calls, results, decisions, human approvals, errors). The service stores them with per-run hash chaining so that any subsequent tampering is detectable, indexes them for query, and exports them as compliance-ready evidence packs.

**One-sentence pitch:** "Datadog for AI agents, but with cryptographic integrity your auditors will accept."

### 1.1 Primary users

1. **Integrator (developer)** — embeds SDK in their agent code, calls `log(event)` from their app.
2. **Investigator (engineer/ops)** — queries runs via API or (later) dashboard to reconstruct what happened.
3. **Auditor (compliance/external)** — receives exported compliance packs and verifies chain integrity.

### 1.2 In-scope for v1

- Event ingestion API (single + batch).
- Per-run hash-chained append-only storage.
- Query API (by run, by tenant + time window, by event type).
- Chain verification API.
- Export API (JSONL + verification artifacts).
- API-key auth with tenant isolation.
- TypeScript SDK (reference implementation).

### 1.3 Explicit non-goals for v1

- **No dashboard UI.** CLI + API only.
- **No policy enforcement.** This is a log, not a gateway.
- **No PII scrubbing or tokenisation.** Out of scope.
- **No framework-specific integrations** (LangChain, CrewAI, etc.). Generic SDK only.
- **No multi-region replication.** Single region, data-residency-selectable per tenant.
- **No OpenTelemetry compatibility.** Comes in v1.1.
- **No billing integration.** Manual usage reporting until PMF signal.
- **No external anchoring** (blockchain/notarisation). Hash chain only in v1; root-hash anchoring in v1.1.

If Claude Code finds itself implementing something in this list, stop and ask.

---

## 2. Architecture

### 2.1 Stack

| Concern | Choice | Rationale |
|---|---|---|
| Compute | Cloudflare Workers | Per-request isolation, global anycast, cheap ingestion. |
| Per-run state & ordering | Durable Objects (one per run) | Strong ordering + single-writer guarantee required for hash chain. |
| Query index | D1 | Relational, adequate for v1 query patterns, low ops burden. |
| Event archival | R2 with object lock | Immutability + zero egress cost for export. |
| Batch/async work | Workers Queues | Archival offload, export job processing. |
| SDK language (v1) | TypeScript | Largest AI-dev market. |
| Spec language | TypeScript strict mode | No `any` unless justified in a comment. |

### 2.2 Component overview

```
┌─────────────┐          ┌───────────────────┐
│   Client    │  HTTPS   │  Ingestion Worker │
│ (SDK or raw)│ ───────▶ │  (API entrypoint) │
└─────────────┘          └─────────┬─────────┘
                                   │
                          auth +   │ route by run_id
                         validate  ▼
                         ┌───────────────────────┐
                         │ Run Durable Object    │
                         │  - assigns seq        │
                         │  - computes hash      │
                         │  - writes to DO state │
                         └─┬─────────────────┬───┘
                           │                 │
                 (sync)    │                 │ (async via Queue)
                           ▼                 ▼
                      ┌────────┐       ┌────────┐
                      │   D1   │       │   R2   │
                      │ index  │       │ archive│
                      └────────┘       └────────┘
```

### 2.3 Ingestion path (hot path)

1. Worker receives request → authenticates API key → resolves tenant.
2. Validates event envelope against schema.
3. Forwards to Run DO keyed by `tenant_id:run_id`.
4. DO acquires internal lock, assigns `seq`, computes `hash`, persists to DO storage, updates `last_hash`.
5. DO writes index row to D1 synchronously (so query reads see the event immediately).
6. DO enqueues R2 archival job asynchronously.
7. Worker returns 200 with `{id, seq, hash}`.

**P50 target:** < 50ms end-to-end from ingestion Worker perspective.
**P99 target:** < 300ms.

### 2.4 Why DO per run, not per tenant

Hash chain correctness requires a single writer per chain. A tenant may have thousands of concurrent runs; using one DO per tenant would serialise all of them and destroy throughput. One DO per run gives us unbounded horizontal parallelism across runs while preserving ordering within a run.

Trade-off: DO cold-start on first event of a new run. Acceptable — runs typically have many events.

---

## 3. Core concepts and data model

### 3.1 IDs

- All IDs use **ULID** (lexicographically sortable, time-ordered, collision-safe).
- Prefixes: `tenant_`, `run_`, `evt_`, `key_`, `export_`.
- Example: `run_01HXYZ123ABC456DEF789GH`.

### 3.2 Tenant

```ts
type Tenant = {
  id: string;              // tenant_*
  name: string;
  created_at: number;      // unix ms
  plan: 'hobby' | 'pro' | 'team' | 'enterprise';
  region: 'auto' | 'eu' | 'us' | 'apac';  // data residency; 'auto' for v1
  settings: {
    event_retention_days: number;
    max_event_size_bytes: number;   // default 256KB
  };
};
```

### 3.3 API Key

```ts
type ApiKey = {
  id: string;              // key_*
  tenant_id: string;
  name: string;
  hash: string;            // SHA-256 of the raw key; raw key shown once at creation
  prefix: string;          // first 8 chars, for UI display
  scopes: Array<'events:write' | 'events:read' | 'runs:read' | 'exports:write'>;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};
```

Raw key format: `al_live_<48 random base62 chars>` (or `al_test_` for test keys).

### 3.4 Run

A run is a logical unit of agent execution. Lifecycle: open → (events appended) → closed. A run MAY be closed explicitly via `run_ended` event, or implicitly after a configurable idle timeout (default 24h).

```ts
type Run = {
  id: string;              // run_*
  tenant_id: string;
  agent_id: string | null;     // client-supplied identifier for the agent
  principal: string | null;    // client-supplied human principal ID
  started_at: number;
  ended_at: number | null;
  event_count: number;
  last_hash: string;           // most recent event hash; "genesis" if no events yet
  last_seq: number;            // most recent seq; -1 if no events yet
  status: 'open' | 'closed' | 'sealed';
  metadata: Record<string, string | number | boolean>;   // client-supplied tags
};
```

`sealed` state: run is closed AND final Merkle root (v1.1) has been computed. Not used in v1 but reserved.

### 3.5 Event envelope

```ts
type EventType =
  | 'run_started'
  | 'run_ended'
  | 'prompt'
  | 'completion'
  | 'tool_call'
  | 'tool_result'
  | 'decision'
  | 'human_approval_requested'
  | 'human_approval_granted'
  | 'human_approval_denied'
  | 'error'
  | 'annotation';

type Actor = {
  type: 'agent' | 'human' | 'system';
  id: string;
  principal?: string;
};

type EventBase = {
  id: string;                  // evt_*
  run_id: string;
  tenant_id: string;
  seq: number;                 // monotonic, 0-indexed within a run
  type: EventType;
  created_at: number;          // unix ms (server-assigned at ingestion)
  client_ts: number | null;    // client-supplied timestamp
  actor: Actor;
  payload: unknown;            // type-specific, see schemas below
  prev_hash: string;
  hash: string;
};
```

Per-type payload schemas MUST be defined as Zod schemas in `src/schemas/events.ts`. Implementation note: use a discriminated union on `type`. Examples:

```ts
// tool_call
{
  name: string;
  arguments: unknown;          // JSON-serialisable
  call_id: string;             // client-generated, for correlating with tool_result
}

// tool_result
{
  call_id: string;             // MUST match a prior tool_call in same run
  status: 'ok' | 'error';
  result: unknown;
  duration_ms: number;
}

// prompt / completion
{
  model: string;
  content: string | Array<{type: 'text'|'image'|'tool_use'|'tool_result', ...}>;
  tokens_in?: number;
  tokens_out?: number;
}

// decision
{
  rationale: string;
  chosen: string;
  alternatives?: string[];
}

// human_approval_requested / granted / denied
{
  request_id: string;
  reason?: string;
  approver?: string;           // for granted/denied
}

// error
{
  kind: string;
  message: string;
  stack?: string;
}

// annotation — freeform, for instrumentation metadata
{
  key: string;
  value: unknown;
}
```

### 3.6 Hash chain algorithm

```
function compute_hash(event, prev_hash):
  # event has all fields EXCEPT `hash`
  # canonical serialisation: sorted keys, no whitespace, UTF-8
  canonical = canonical_json({
    id: event.id,
    run_id: event.run_id,
    tenant_id: event.tenant_id,
    seq: event.seq,
    type: event.type,
    created_at: event.created_at,
    client_ts: event.client_ts,
    actor: event.actor,
    payload: event.payload,
    prev_hash: prev_hash
  })
  return "sha256:" + hex(sha256(canonical))
```

**Genesis value:** `prev_hash` for the first event in a run (`seq = 0`) is the string `"genesis:" + run_id`. This binds the chain start to the run identity so that two runs with identical first-event payloads produce different hashes.

**Canonical JSON rules (MUST):**
- Object keys sorted ASCII-ascending.
- No whitespace between tokens.
- Strings UTF-8, JSON-standard escaping.
- Numbers: integers as integers, no trailing `.0`; floats disallowed in hashed fields (use strings for anything fractional).
- Arrays preserve insertion order.

A pure-function implementation MUST live in `src/chain/canonical.ts` with extensive tests and published test vectors (see §9.2).

### 3.7 Verification

A run chain is valid iff:

1. Events exist for `seq = 0..N-1` with no gaps.
2. Event 0's `prev_hash == "genesis:" + run_id`.
3. For every event `i > 0`: `events[i].prev_hash == events[i-1].hash`.
4. For every event `i`: `compute_hash(events[i], events[i].prev_hash) == events[i].hash`.

Verification endpoint returns either `{valid: true}` or `{valid: false, break_at_seq: N, reason: "..."}`.

---

## 4. Storage design

### 4.1 Durable Object state (per run)

Each Run DO persists:

- `run` record (as in §3.4).
- `events[]` — the last **200 events**, in-memory, for fast reads. Older events live only in R2 + D1 index.
- `last_hash`, `last_seq` — cached for hot path.

Periodically (every 50 events OR every 30s of idle), the DO flushes older events out of its in-memory cache; they remain in R2 + D1.

### 4.2 D1 schema

```sql
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'auto',
  settings TEXT NOT NULL,        -- JSON
  created_at INTEGER NOT NULL
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scopes TEXT NOT NULL,          -- JSON array
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT,
  principal TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  event_count INTEGER NOT NULL DEFAULT 0,
  last_hash TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT -1,
  status TEXT NOT NULL DEFAULT 'open',
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_runs_tenant_started ON runs(tenant_id, started_at DESC);
CREATE INDEX idx_runs_agent ON runs(tenant_id, agent_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  tenant_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  r2_key TEXT,                   -- null until archived
  -- denormalised for query perf
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  tool_name TEXT,
  UNIQUE(run_id, seq)
);
CREATE INDEX idx_events_run ON events(run_id, seq);
CREATE INDEX idx_events_tenant_created ON events(tenant_id, created_at DESC);
CREATE INDEX idx_events_type ON events(tenant_id, type, created_at DESC);

CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,          -- 'queued'|'running'|'done'|'failed'
  r2_key TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT
);
```

Migrations live in `migrations/` numbered `0001_init.sql`, `0002_*.sql`, etc. Apply via Wrangler's D1 migration tooling.

### 4.3 R2 layout

```
<bucket>/
  events/
    <tenant_id>/
      <run_id>/
        <seq_padded_10>.json      # one object per event, raw envelope
  exports/
    <tenant_id>/
      <export_id>.jsonl           # or .zip for compliance pack
```

Object lock: Governance mode, retention = tenant's `event_retention_days`. For v1, single global default (30 days on hobby, 90 on pro, 365 on team).

### 4.4 Retention & deletion

Retention is per-tenant. A daily scheduled Worker (Cron Trigger) removes D1 rows and R2 objects past retention. DO state is pruned via alarm when a run's events age out. Deletes are physical and final; we explicitly DO NOT offer "soft delete" — this is an audit log.

**Sole exception:** GDPR Article 17 ("right to erasure") requests. v1 does not automate these; documented as a manual ops runbook.

---

## 5. API

### 5.1 Conventions

- Base URL: `https://api.<domain>/v1`
- All requests: `Authorization: Bearer <api_key>`
- All requests/responses: `application/json; charset=utf-8`.
- Errors: RFC 7807 problem+json:
  ```json
  {"type":"about:blank","title":"invalid_event","status":400,"detail":"payload.call_id missing","instance":"req_..."}
  ```
- Every response includes `X-Request-Id`.
- Rate limits per API key, returned as `X-RateLimit-*` headers.

### 5.2 Endpoints (v1)

#### POST /v1/events
Ingest a single event.

Request body:
```json
{
  "run_id": "run_...",       // required; creates run if not exists
  "type": "tool_call",
  "actor": {"type":"agent","id":"agent_xyz","principal":"user_abc"},
  "payload": { /* type-specific */ },
  "client_ts": 1713456789000,
  "client_event_id": "..."   // optional, for idempotency
}
```

Response `200`:
```json
{"id":"evt_...","run_id":"run_...","seq":42,"hash":"sha256:..."}
```

Idempotency: if `client_event_id` is provided and a prior request in the same run used the same value, return the prior result. Implemented via a small LRU in the Run DO.

#### POST /v1/events/batch
Ingest up to 500 events in one request. All events MUST belong to the same `run_id`. Events are appended in array order. Atomic: either all succeed or none are written.

#### POST /v1/runs
Explicitly create a run. Optional — an unknown run_id in `POST /v1/events` auto-creates. Useful for attaching metadata upfront.

#### GET /v1/runs/:id
Return Run record.

#### GET /v1/runs/:id/events?after_seq=&limit=
Paginated event list. Default limit 100, max 1000. Returns events in seq order.

#### GET /v1/runs?agent_id=&principal=&from=&to=&status=&limit=&cursor=
List runs. Cursor-based pagination.

#### POST /v1/runs/:id/verify
Walks the entire chain. Returns:
```json
{"valid": true, "events_verified": 427}
```
or
```json
{"valid": false, "break_at_seq": 123, "reason": "prev_hash mismatch"}
```

For runs > 10K events, returns `202 Accepted` + verification job reference.

#### POST /v1/runs/:id/export
Request an export. Body:
```json
{"format": "jsonl" | "compliance_pack"}
```
Returns:
```json
{"export_id":"export_...","status":"queued"}
```

#### GET /v1/exports/:id
Poll export status; when `done`, includes a pre-signed R2 URL valid for 1h.

### 5.3 Rate limits (v1 defaults)

| Plan | Events/sec | Events/month |
|---|---|---|
| Hobby | 10 | 100K |
| Pro | 100 | 10M |
| Team | 500 | 100M |
| Enterprise | negotiated | negotiated |

Enforced at ingestion Worker via a Durable Object counter keyed by API key.

---

## 6. Authentication & tenant isolation

- API keys checked against `api_keys.hash` (SHA-256 of raw key, constant-time compare).
- Every D1 query MUST include `tenant_id` in the WHERE clause. No exceptions. This is the single most common source of multi-tenancy bugs.
- DO names MUST be scoped: `${tenant_id}:${run_id}`. A malicious/misbehaving client CANNOT target another tenant's DO even if they guess a run_id.
- R2 keys always prefixed with `tenant_id`.
- Add an integration test (§9) that creates two tenants and asserts tenant A cannot read any of tenant B's data via any endpoint.

---

## 7. Repository layout

```
/
├── README.md
├── spec.md                          # this document
├── wrangler.toml                    # single env for v1; dev + production targets
├── package.json
├── tsconfig.json                    # strict: true, noImplicitAny: true
├── migrations/
│   └── 0001_init.sql
├── src/
│   ├── index.ts                     # Worker fetch entrypoint, router
│   ├── router.ts                    # lightweight router (itty-router or hand-rolled)
│   ├── auth/
│   │   ├── api_key.ts               # parse + verify
│   │   └── tenant.ts                # load tenant; inject into req context
│   ├── chain/
│   │   ├── canonical.ts             # canonical_json
│   │   ├── hash.ts                  # compute_hash
│   │   └── verify.ts                # verify_chain
│   ├── do/
│   │   └── run.ts                   # RunDurableObject class
│   ├── handlers/
│   │   ├── events.ts                # POST /events, /events/batch
│   │   ├── runs.ts                  # GET /runs, /runs/:id, etc.
│   │   ├── verify.ts
│   │   └── exports.ts
│   ├── schemas/
│   │   ├── events.ts                # Zod schemas per EventType
│   │   └── common.ts
│   ├── storage/
│   │   ├── d1.ts                    # typed query helpers
│   │   ├── r2.ts                    # event archival
│   │   └── queue.ts
│   ├── lib/
│   │   ├── ulid.ts
│   │   ├── errors.ts                # problem+json helpers
│   │   └── time.ts
│   └── types.ts                     # shared types; mirrors spec §3
├── test/
│   ├── unit/
│   │   ├── canonical.test.ts        # MUST include published vectors (§9.2)
│   │   ├── hash.test.ts
│   │   └── verify.test.ts
│   ├── integration/
│   │   ├── ingestion.test.ts
│   │   ├── query.test.ts
│   │   ├── verification.test.ts
│   │   └── tenant_isolation.test.ts # §6 requirement
│   └── fixtures/
│       └── vectors.json             # hash chain test vectors
├── sdk/
│   └── typescript/
│       ├── package.json
│       ├── src/
│       │   └── index.ts
│       └── test/
└── scripts/
    ├── create_tenant.ts             # bootstrap a tenant + first API key
    └── verify_cli.ts                # CLI to verify exported pack
```

---

## 8. Implementation milestones

Each milestone has a concrete exit criterion. Claude Code MUST NOT start a milestone until the prior one's exit criteria are met.

### Milestone 0 — Project skeleton
- Wrangler project initialised.
- TS strict mode configured.
- D1 database created, `0001_init.sql` applied to local.
- One hello-world route.
- `npm test` runs and passes (on the single trivial test).

**Exit:** `npm run dev` serves `GET /health` returning `{ok:true}`; `npm test` green.

### Milestone 1 — Canonical JSON + hash chain primitives (pure functions)
- `src/chain/canonical.ts`, `src/chain/hash.ts`, `src/chain/verify.ts`.
- Unit tests covering every canonicalisation rule from §3.6.
- Test vectors in `test/fixtures/vectors.json` — at least 10 hand-computed events producing known hashes.

**Exit:** all unit tests pass; vectors published in `vectors.json` reproduce byte-identically when the code is run.

### Milestone 2 — Tenants, API keys, auth middleware
- Tenant + API key D1 tables populated via `scripts/create_tenant.ts`.
- Middleware that parses `Authorization`, verifies hash, injects tenant + scopes into request context.
- 401 on missing/invalid/revoked keys.

**Exit:** `curl` with valid key hits a stub `/v1/me` endpoint returning tenant; invalid key returns 401 problem+json.

### Milestone 3 — Run Durable Object + single-event ingest
- `RunDurableObject` class.
- `POST /v1/events` → DO → assigns seq, computes hash, writes DO state + D1 event row.
- R2 archival NOT yet wired.
- `GET /v1/runs/:id` and `GET /v1/runs/:id/events` return inserted data.

**Exit:** ingesting 100 events to the same run produces a valid chain when verified against the vectors algorithm; D1 events table has 100 rows with correct seq/hash/prev_hash.

### Milestone 4 — Batch ingest + idempotency
- `POST /v1/events/batch` (up to 500 events, same run, atomic).
- Idempotency via `client_event_id`.

**Exit:** replaying the same batch request twice results in the same server event IDs and only 500 rows in D1.

### Milestone 5 — R2 archival via Queue
- After DO commits, enqueue archival job.
- Queue consumer writes event envelope to R2 with object lock.
- `events.r2_key` populated after archival.

**Exit:** all events from milestone 3/4 have non-null `r2_key` within 60s; objects retrievable from R2.

### Milestone 6 — Verify & list endpoints
- `POST /v1/runs/:id/verify` (inline for < 10K events, async job for larger).
- `GET /v1/runs` with filtering + cursor pagination.
- Query filtering by type.

**Exit:** verify returns `valid:true` for a clean run; manually corrupting a single hash in D1 causes verify to return `valid:false` with correct `break_at_seq`.

### Milestone 7 — Export (JSONL)
- `POST /v1/runs/:id/export` enqueues job.
- Consumer streams events from D1 + R2 into a single JSONL in R2, appends a `MANIFEST.json` with run metadata + final `last_hash`.
- Pre-signed URL via `GET /v1/exports/:id`.

**Exit:** exported JSONL, when fed to `scripts/verify_cli.ts`, reports valid chain.

### Milestone 8 — Tenant isolation tests + rate limiting
- Integration test in `test/integration/tenant_isolation.test.ts` (see §9.3).
- Rate limiting DO per API key; 429 problem+json when exceeded.

**Exit:** isolation test green; ab/oha test confirms 429s at configured limit.

### Milestone 9 — TS SDK v0.1
- `sdk/typescript` implements `Client`, `client.event(...)`, `client.batch(...)`, auto-retry on 5xx, no-op if telemetry disabled.
- Example in `sdk/typescript/examples/basic.ts`.

**Exit:** example runs against local dev worker and produces a verifiable run.

### Milestone 10 — Deploy to production
- Prod D1 + R2 + Queue provisioned.
- Deploy via `wrangler deploy`.
- Smoke test against prod.

**Exit:** a prod API key can ingest and verify a real run end-to-end.

---

## 9. Testing & verification

### 9.1 Test strategy

- **Unit:** chain primitives, canonical JSON, Zod schemas. Vitest.
- **Integration:** run against Miniflare / Wrangler's local dev simulating D1, DO, R2, Queues.
- **Contract:** OpenAPI 3.1 spec at `openapi.yaml` kept in sync; a test asserts handler responses match schema.
- **End-to-end:** a script that hits a deployed staging worker with a realistic agent run transcript and verifies the export.

### 9.2 Hash chain test vectors

`test/fixtures/vectors.json` MUST contain a minimum of 10 events across multiple runs, with pre-computed canonical JSON strings and expected hashes. This is the immutable contract for the hash chain implementation — if any change to canonicalisation or hashing breaks these vectors, that is a wire-compatibility break and must be a deliberate versioned decision.

### 9.3 Tenant-isolation test (required)

```
Given tenant A with run_A and tenant B with run_B:
  A's key MUST NOT be able to:
    - GET /v1/runs/run_B
    - GET /v1/runs/run_B/events
    - POST /v1/runs/run_B/verify
    - POST /v1/events  with run_id = run_B   (creates a DIFFERENT run under A)
    - POST /v1/runs/run_B/export
  All above MUST return 404 (not 403 — don't leak existence).
```

### 9.4 Verification commands (for the human to sanity-check)

After each milestone, these MUST produce green results:

```bash
npm test                              # unit + integration
npm run typecheck                     # tsc --noEmit
npm run lint
curl -H "Authorization: Bearer $KEY" https://localhost:8787/v1/me
# smoke script (after milestone 3)
npx tsx scripts/smoke.ts
```

`scripts/smoke.ts` MUST: create a run, append ~50 synthetic events, call verify, assert valid.

---

## 10. Observability

- Structured logging via `console.log(JSON.stringify(...))` with fields: `ts, level, req_id, tenant_id, run_id, msg, ...`.
- Worker Analytics Engine dataset `events_ingested` with dimensions: tenant_id, type, outcome.
- Tail workers for DO-level issues.
- No external APM in v1.

---

## 11. Security requirements

- All secrets via Wrangler secrets; none in `wrangler.toml`.
- Raw API keys displayed to user ONCE at creation; only the SHA-256 hash stored.
- Constant-time compare for key hash lookup where feasible.
- No PII handling features — customers are responsible for what they log. Document this prominently in the SDK README.
- CORS disabled by default on ingestion API; SDKs call from backend.
- A single OWASP-style pass before milestone 10: no SQL injection vectors (we use parameterised D1 queries only; grep for string concatenation in queries), no unauthenticated endpoints except `/health`.

---

## 12. Open questions (DO NOT silently resolve)

1. **Pricing metering.** When does usage counting happen — on ingest, on archival, or both? Current assumption: ingest.
2. **Event size cap.** Hard-coded 256KB; should this be per-plan?
3. **Client-side vs server-side event IDs.** Current spec: server assigns `evt_*`, client can provide `client_event_id` for idempotency. Acceptable?
4. **Region routing.** `region: 'auto'` in v1 means all data sits wherever CF routes it. For EU data residency, do we need a separate worker/bucket per region? Deferred decision.
5. **SDK telemetry.** Should the SDK emit its own self-health events? Nice but out of scope for v1.
6. **Chain-break remediation.** If verify finds a break, do we expose any repair mechanism? Default answer: no, ever. Confirm.
7. **MCP compatibility.** Should ingest also accept an MCP-shaped event format as an alias? Probably v1.1.
8. **Free tier abuse.** Hobby 100K events/mo is generous. What signals do we use to flag abuse?

These questions MUST be answered before the spec goes to v1.0 (this is v0.1).

---

## 13. Working agreement for Claude Code

- Read this entire spec before starting any milestone. Confirm understanding by summarising the milestone's scope before writing code.
- Do not skip ahead. Milestones are ordered for a reason.
- If a requirement is ambiguous, stop and ask — do not guess.
- If an implementation choice is NOT specified, pick the most boring, well-documented option in the Cloudflare Workers ecosystem and leave a short comment explaining the choice.
- Every new file begins with a header comment: `// <path> — <one-line purpose>`.
- Every non-trivial function has a JSDoc block with at least: purpose, params, returns, and any invariants.
- For each milestone, produce:
  - A `MILESTONE_<N>_NOTES.md` summarising what was built, what was deferred, and how to verify.
  - A verification run (`npm test`, plus any milestone-specific scripts) with output included or summarised.
- NEVER commit secrets, API keys, or test vectors containing real customer data.

# OpenSwitchboard — server (private)

The core switchboard service (phase 0.C). One container, three concerns:

1. **MCP endpoint** — `/mcp`, Streamable HTTP (stateless JSON mode), tools:
   `publish_intent`, `check_matches`, `respond`, `open_channel`,
   `list_intents`, `amend_intent`, `withdraw_intent`. Tool schemas embed
   `@openswitchboard/schema`; errors use the protocol's machine-readable
   shape. Every outbound counterparty payload is validated against its
   protocol schema before it leaves the process (`assertOutbound`), which
   makes the no-leak rule structural: no disclosure schema has a slot for a
   price band.
2. **OAuth 2.1** — authorization-code + PKCE (S256 mandatory), RFC 7591
   dynamic client registration, rotated refresh tokens, RFC 8414 + RFC 9728
   metadata. Opaque tokens, sha256-hashed at rest, bound to one account.
3. **Domain core** — Postgres (Aurora Serverless v2, pgvector), envelope
   encryption (per-account KMS data keys; every decrypt writes a WORM audit
   line to the consent-log bucket **before** plaintext is returned), TTL
   expiry, per-token quotas, and the Bedrock screening pipeline (publish
   stays `PENDING_SCREENING` until screening passes; rejects become
   `SCREENING_REJECTED` with the reason logged internally only).

## Product rules enforced server-side

- Price bands (budget ceiling / reserve floor) are matching inputs only:
  envelope-encrypted at rest, decrypted only inside the matching engine,
  structurally absent from every disclosure payload.
- Stage-3 (`match.mutual`) is returned only when **both** humans'
  `stage3-optin` consent tokens exist. The gate queries `consent_tokens`
  directly.
- The only offer-accept state reachable through any agent API is
  `awaiting-human` (`respond(send_to_human)`). `accepted-by-human` is set
  exclusively by `acceptOfferByHuman()`, which has **no public route** — in
  0.C it is reachable only via the IAM-gated internal ops queue; in 0.D the
  counter's human-approval UI becomes the caller.
- Declines carry no reason (schema-level `additionalProperties: false`).
- Every free-text field to a counterparty is provenance-labelled.
- Locations are resolved server-side. A card names a suburb, city or region in
  `geo.place`; the switchboard places it against the offline gazetteer in
  `data/gazetteer.json.gz` and stores a centre point, a canonical geohash4
  cell and a reach. Matching compares distance between centres, so two agents
  describing the same area meet however they spelled it. A street address, or a
  name the gazetteer cannot place, is refused with `LOCATION_UNRESOLVED`.
- Publish is blocked until screening passes; there is no bypass. If Bedrock
  is unavailable, cards simply stay `PENDING_SCREENING` (SQS redelivery →
  DLQ), never published unscreened.

## The human pages (phase 0.D)

Served from the root of their own hostname (`my-dev.openswitchboard.ai` dev,
`my.openswitchboard.ai` prod; same ALB/service, SNI cert, host separation
enforced in-app) — the ONE human-facing surface: registration
(email code → PIN → optional passkey → 18+ + consent, WORM-logged),
login (email code or passkey), approval pages for stage-3 disclosure and
offer acceptance (three facts big; anomalies louder), the ledger
(edit → re-screen, withdraw immediate), the kill switch (one tap pauses all
cards and suspends every agent token; un-pause needs login + PIN), and the
blind-mode toggle (stored now, consumed by 0.E).

They used to live at `/counter/*` on `counter[-dev].openswitchboard.ai`.
Both old names still answer, with a 308 to the same path on the matching
`my.*` host, and an old `/counter` path 308s to the same path without the
prefix — so an approval link emailed before the move still lands on the page
it names. The internals keep the old name: `src/counter/`, `COUNTER_ORIGIN`,
`osb/<env>/counter/keys`.

**Structural isolation** (unit- and live-tested in both directions): every
human-page route sits behind a guard that hard-403s any request carrying an
`Authorization` header, so an MCP bearer token is useless there;
counter auth is a host-only `osb_counter` session cookie (HttpOnly, Secure,
SameSite=Lax) that `/mcp` never reads. The PIN (argon2id at rest, 5 tries
then lockout with backoff) and passkeys (WebAuthn, RP ID = counter host)
never transit the agent path.

**Approval links** are single-use, 15-minute-TTL, HMAC-signed and bound to
`{account, action, amount, counterparty}` (key in Secrets Manager
`osb/<env>/counter/keys`); the DB stores only the token hash.

The `/oauth/authorize` endpoint on the MCP host now only validates the
request and 302s the human to `/authorize` on the human host; the 0.C
access-code login page is gone. **Prod keeps registration CLOSED**: `/register`
and `/oauth/authorize` render "registration opens at launch" — no bypass,
and the ops worker still refuses `create-account` in prod. The dev operator
bootstrap CLI (`npm run bootstrap-account`) remains for test accounts; those
accounts sign in on the human pages with email codes like everyone else.

### SES sandbox (until production access lands)

The `openswitchboard.ai` SES identity is verified (DKIM + MAIL FROM), but
the account is still in the SES **sandbox**, so sends to unverified
recipients are rejected. Every counter flow still performs the real
`SendEmail` call — the full email path is exercised the moment production
access is granted. Consequences, by design:

- **dev only**: a sandbox `MessageRejected` is logged loudly and the flow
  continues; the dev test harness stamps/reads the verification code on the
  just-created row via the RDS Data API instead of an inbox. This is test
  observability, NOT a bypass: codes stay hashed at rest, single-use, and
  15-minute-TTL, and nothing about validation changes.
- **prod**: any send failure is a hard failure (NO-FALLBACKS).

## Development

```sh
npm ci
npm test                 # unit + conformance against local validators
npm run lint             # tsc --noEmit
```

Place data (GeoNames, CC BY 4.0 — see `NOTICE`) is committed as
`data/gazetteer.json.gz` and baked into the image, so resolution runs
in-process with no network call. Refresh it only when the data needs it:

```sh
npm run build:gazetteer                        # downloads the GeoNames dump
OSB_GEONAMES_DIR=/path/to/dump npm run build:gazetteer
```

Cards written before the 0.3.0 location change are placed by a one-shot,
idempotent op that re-runs the same normalisation and hands each placed card
back to the matcher:

```sh
AWS_PROFILE=openswitchboard npx tsx scripts/ops.ts backfill-geo --env dev
```

Integration gates (against the live dev deployment; needs the
`openswitchboard` AWS profile for the internal ops queue):

```sh
AWS_PROFILE=openswitchboard npm run test:integration
```

Deployment: the image is built by CDK (`DockerImageAsset`) from this
directory via the infra repo (`openswitchboard-ai/infra`, stacks
`Osb-Dev-Core` / `Osb-Prod-Core`). Infra CI checks this repo out read-only
via a deploy key.

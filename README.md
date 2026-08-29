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
- Publish is blocked until screening passes; there is no bypass. If Bedrock
  is unavailable, cards simply stay `PENDING_SCREENING` (SQS redelivery →
  DLQ), never published unscreened.

## Interim auth page (0.C only)

SES (magic links) arrives in 0.E and the counter (registration, PIN,
passkeys) in 0.D, so for 0.C the `/oauth/authorize` login page authenticates
**dev/test accounts created by the operator bootstrap CLI**
(`npm run bootstrap-account`; the access code is scrypt-hashed client-side
and only the hash crosses the IAM-gated ops queue).

**0.D replaces this page** with the counter's registration/PIN/passkey flow.
**Prod keeps registration CLOSED**: the prod authorize flow renders a clean
"registration opens at launch" page — there is no bypass and no prod
bootstrap path (the ops worker refuses `create-account` in prod).

## Development

```sh
npm ci
npm test                 # unit + conformance against local validators
npm run lint             # tsc --noEmit
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

/**
 * Protocol layer: loads @openswitchboard/schema JSON documents, compiles Ajv
 * validators, and provides the machine-readable error shape.
 *
 * IMPORTANT: every payload sent to a counterparty is validated OUTBOUND
 * against its protocol schema before it leaves the process. Since no
 * disclosure schema has a slot for a price band, this makes the no-leak rule
 * structural on the wire, not advisory.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const require_ = createRequire(import.meta.url);
// Resolve the installed @openswitchboard/schema package root via its package.json.
const schemaPkgRoot = dirname(require_.resolve('@openswitchboard/schema/package.json'));

export const SCHEMA_NAMES = [
  'common',
  'intent-card',
  'match.signal',
  'match.attributes',
  'match.mutual',
  // What this switchboard puts on the wire: nothing an agent reads says
  // "channel" any more, so the kind, the object and the id all say
  // conversation. The schema package renames these documents in its own
  // release; until the installed copy carries them, they are derived from the
  // channel.* documents it does carry (see loadSchemaDoc), so the vocabulary is
  // enforced by a real validator either way.
  'conversation.open',
  'conversation.message',
  // The names those documents shipped under. Registered only while the
  // installed schema package still has them, because its conformance fixtures
  // are written against them; they fall away with the dependency bump.
  'channel.open',
  'channel.message',
  'offer',
  'settlement',
  'error',
  'deny-list',
] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];

export const SCHEMA_VERSION: string = JSON.parse(
  readFileSync(join(schemaPkgRoot, 'package.json'), 'utf8'),
).version;

/** The older document a conversation.* document is derived from, when the
 *  installed schema package predates the rename. */
const CONVERSATION_SOURCE: Record<string, string> = {
  'conversation.open': 'channel.open',
  'conversation.message': 'channel.message',
};

const schemaFile = (name: string): string => join(schemaPkgRoot, 'schemas', `${name}.json`);

/** Does the installed schema package carry this document under this name? */
function schemaShipped(name: string): boolean {
  return existsSync(schemaFile(name));
}

/**
 * Restate a stage-4 document in the vocabulary the switchboard speaks: the
 * `kind` const, the `channel` object and every `channel_id` become
 * `conversation` / `conversation_id`, and the document gets its own $id so Ajv
 * holds it alongside the published one. Purely mechanical — no constraint is
 * added, dropped or loosened.
 */
function conversationDoc(name: string, source: string): any {
  const text = JSON.stringify(loadSchemaDoc(source as SchemaName))
    .replaceAll(`v0/${source}.json`, `v0/${name}.json`)
    .replaceAll(`"${source}"`, `"${name}"`)
    .replaceAll('"channel_id"', '"conversation_id"')
    .replaceAll('"channel"', '"conversation"');
  const doc = JSON.parse(text);
  // The prose too, so a document that is read (or one day bundled into a tool
  // schema) never reintroduces the word its own fields no longer use.
  const prose = (node: any): void => {
    if (Array.isArray(node)) return node.forEach(prose);
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'description' || k === 'title') && typeof v === 'string') {
        node[k] = v.replaceAll('channel_id', 'conversation_id').replace(/\bchannel(s?)\b/g, 'conversation$1');
      } else prose(v);
    }
  };
  prose(doc);
  return doc;
}

export function loadSchemaDoc(name: SchemaName): any {
  const derivedFrom = CONVERSATION_SOURCE[name];
  // Prefer the package's own document. Deriving is the fallback for an
  // installed copy that predates the rename, and it retires itself the moment
  // the dependency is bumped.
  if (derivedFrom && !schemaShipped(name)) return conversationDoc(name, derivedFrom);
  return JSON.parse(readFileSync(schemaFile(name), 'utf8'));
}

export function loadDenyListSeed(): any {
  return JSON.parse(readFileSync(join(schemaPkgRoot, 'data', 'deny-list.seed.json'), 'utf8'));
}

export function loadTaxonomy(): any {
  return JSON.parse(readFileSync(join(schemaPkgRoot, 'data', 'taxonomy.v2.json'), 'utf8'));
}

export interface ValidationResult {
  valid: boolean;
  reasons: string[];
}

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
(addFormats as any).default ? (addFormats as any).default(ajv) : (addFormats as any)(ajv);
// Register every document the installed package can supply. The channel.*
// names drop out of this loop once the dependency carries conversation.* of its
// own, which is exactly when nothing asks for them any more.
for (const name of SCHEMA_NAMES) {
  if (!schemaShipped(name) && !CONVERSATION_SOURCE[name]) continue;
  ajv.addSchema(loadSchemaDoc(name));
}

export function validatePayload(schema: SchemaName, data: unknown): ValidationResult {
  const validate = ajv.getSchema(`https://schema.openswitchboard.ai/v0/${schema}.json`);
  if (!validate) throw new Error(`unknown schema: ${schema}`);
  const valid = validate(data) as boolean;
  const reasons = (validate.errors ?? []).map(
    (e) => `${e.instancePath} ${e.keyword} ${e.message} ${JSON.stringify(e.params)}`,
  );
  return { valid, reasons };
}

/**
 * Assert an outbound counterparty payload conforms to its schema. Throws if
 * not — a switchboard that would emit a non-conformant disclosure payload has
 * a bug and must not send anything at all.
 */
export function assertOutbound<T>(schema: SchemaName, data: T): T {
  const r = validatePayload(schema, data);
  if (!r.valid) {
    throw new Error(`outbound payload failed ${schema} validation: ${r.reasons.join('; ')}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Machine-readable errors (schemas/error.json).
// ---------------------------------------------------------------------------
export type ErrorCode =
  | 'CONSENT_REQUIRED'
  | 'SCHEMA_VERSION_UNSUPPORTED'
  | 'QUOTA_EXCEEDED'
  | 'CATEGORY_PROHIBITED'
  | 'STAGE_LOCKED'
  | 'INTENT_EXPIRED'
  | 'SCREENING_REJECTED'
  | 'RATE_LIMITED'
  | 'RATE_LIMITED_OFFERS'
  | 'SETTLEMENT_UNAVAILABLE'
  | 'LOCATION_UNRESOLVED'
  | 'LOCATION_AMBIGUOUS';

/** One place a shared name could have meant, on LOCATION_AMBIGUOUS. */
export interface ErrorCandidate {
  /** "Perth, Scotland, GB" — what an agent puts to its human. */
  display: string;
  /** "Perth, Scotland" — what goes back in the card's geo.place. */
  place: string;
}

export interface ProtocolError {
  schema_version: string;
  code: ErrorCode;
  human_action?: string;
  retry_after?: number;
  /** Up to three open taxonomy categories nearest a refused one. */
  suggestions?: string[];
  /** Up to five places a bare name could have meant, largest first. */
  candidates?: ErrorCandidate[];
  docs_url: string;
}

export class OsbError extends Error {
  readonly payload: ProtocolError;
  constructor(
    code: ErrorCode,
    opts: {
      human_action?: string;
      retry_after?: number;
      suggestions?: string[];
      candidates?: ErrorCandidate[];
    } = {},
  ) {
    super(code);
    this.payload = assertOutbound('error', {
      schema_version: SCHEMA_VERSION,
      code,
      ...(opts.human_action ? { human_action: opts.human_action } : {}),
      ...(opts.retry_after !== undefined ? { retry_after: opts.retry_after } : {}),
      ...(opts.suggestions?.length ? { suggestions: opts.suggestions.slice(0, 3) } : {}),
      ...(opts.candidates?.length ? { candidates: opts.candidates.slice(0, 5) } : {}),
      docs_url: `https://openswitchboard.ai/docs/errors#${code}`,
    });
  }
}

/**
 * Server-side assertion (belt to the schemas' braces): a decline payload
 * carries NO reason, at any depth, under any key spelling. The disclosure
 * schemas already forbid one structurally; this makes the rule an invariant
 * of the code path too, so a future schema slip cannot open a probing side
 * channel.
 */
export function assertReasonless<T>(payload: T): T {
  const scan = (o: any, path: string): void => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (/reason/i.test(k)) {
        throw new Error(`decline payload must be reasonless; found '${path}.${k}'`);
      }
      scan(v, `${path}.${k}`);
    }
  };
  scan(payload, '$');
  return payload;
}

/** Reject unknown MAJOR schema versions (SPEC §9). */
export function checkSchemaVersion(v: unknown): void {
  const ours = Number(SCHEMA_VERSION.split('.')[0]);
  if (typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v) || Number(v.split('.')[0]) !== ours) {
    throw new OsbError('SCHEMA_VERSION_UNSUPPORTED', {
      human_action: `Upgrade your agent to @openswitchboard/schema ${SCHEMA_VERSION}.`,
    });
  }
}

/**
 * Bundle a protocol schema into a single self-contained JSON Schema document
 * (inlining common.json's $defs) for embedding as an MCP tool input schema.
 */
export function bundledSchema(name: SchemaName): any {
  const doc = loadSchemaDoc(name);
  const common = loadSchemaDoc('common');
  const text = JSON.stringify(doc).replaceAll('common.json#/$defs/', '#/$defs/');
  const bundled = JSON.parse(text);
  bundled.$defs = { ...(bundled.$defs ?? {}), ...common.$defs };
  delete bundled.$id;
  delete bundled.$schema;
  return bundled;
}

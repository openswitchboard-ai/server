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
  // What this switchboard puts on the wire: nothing an agent reads says
  // "match" any more, so the kind and the id both say intro — the switchboard
  // makes introductions. The schema package renames these documents in its own
  // release; until the installed copy carries them, they are derived from the
  // match.* documents it does carry (see loadSchemaDoc), so the vocabulary is
  // enforced by a real validator either way.
  'intro.signal',
  'intro.attributes',
  'intro.mutual',
  // The names those documents shipped under. Registered while the installed
  // schema package still has them, because its conformance fixtures are
  // written against them; they fall away with the dependency bump.
  'match.signal',
  'match.attributes',
  'match.mutual',
  // The same story one round earlier: nothing an agent reads says "channel".
  'conversation.open',
  'conversation.message',
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

/** The older document one of this switchboard's documents is derived from,
 *  when the installed schema package predates the rename. */
const DERIVED_FROM: Record<string, string> = {
  'conversation.open': 'channel.open',
  'conversation.message': 'channel.message',
  'intro.signal': 'match.signal',
  'intro.attributes': 'match.attributes',
  'intro.mutual': 'match.mutual',
};

/**
 * The words this switchboard puts on the wire, against the words the installed
 * schema package still writes. Each pair is applied to a document's JSON text
 * as a whole quoted token, so it only ever rewrites a property name, an enum
 * value or a const — never prose, and never a constraint.
 */
const WIRE_TOKENS: [string, string][] = [
  ['match_id', 'intro_id'],
  ['channel_id', 'conversation_id'],
  ['channel', 'conversation'],
  ['WANT', 'looking_for'],
  ['HAVE', 'offering'],
  ['STAGE_LOCKED', 'NOT_UNLOCKED_YET'],
];

/** Every document this switchboard SENDS. Only these are restated in the wire
 *  vocabulary; intent-card is inbound and keeps the package's own words, which
 *  the tool layer translates into. */
const OUTBOUND_NAMES: string[] = [
  'intro.signal',
  'intro.attributes',
  'intro.mutual',
  'conversation.open',
  'conversation.message',
  'offer',
  'settlement',
  'error',
];

const schemaFile = (name: string): string => join(schemaPkgRoot, 'schemas', `${name}.json`);
const canonicalId = (name: string): string =>
  `https://schema.openswitchboard.ai/v0/${name}.json`;
/** A wire copy keeps the published document's directory so its
 *  `common.json#/$defs/...` references still resolve. */
const wireId = (name: string): string =>
  `https://schema.openswitchboard.ai/v0/${name}.wire.json`;

/** Does the installed schema package carry this document under this name? */
function schemaShipped(name: string): boolean {
  return existsSync(schemaFile(name));
}

/** Does this document still write any of the words the wire has left behind? */
function predatesWireWords(doc: any): boolean {
  const text = JSON.stringify(doc);
  return WIRE_TOKENS.some(([from]) => text.includes(`"${from}"`));
}

/**
 * Restate a document in the vocabulary the switchboard speaks. Field names,
 * enum values and consts move by whole token; the prose moves with them so a
 * document that is read (or one day bundled into a tool schema) never
 * reintroduces a word its own fields no longer use. Purely mechanical — no
 * constraint is added, dropped or loosened.
 */
function wireForm(doc: any, id: string): any {
  let text = JSON.stringify(doc);
  for (const [from, to] of WIRE_TOKENS) text = text.replaceAll(`"${from}"`, `"${to}"`);
  const out = JSON.parse(text);
  out.$id = id;
  const prose = (node: any): void => {
    if (Array.isArray(node)) return node.forEach(prose);
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'description' || k === 'title') && typeof v === 'string') {
        node[k] = v
          .replaceAll('match_id', 'intro_id')
          .replaceAll('channel_id', 'conversation_id')
          .replaceAll('STAGE_LOCKED', 'NOT_UNLOCKED_YET')
          .replaceAll('check_matches', 'check_in')
          .replace(/\bmatch\.(signal|attributes|mutual)\b/g, 'intro.$1')
          .replace(/\bchannel\.(open|message)\b/g, 'conversation.$1')
          .replace(/\bchannel(s?)\b/gi, 'conversation$1')
          .replace(/\bmatch(es)?\b/gi, (m) => (m.toLowerCase().endsWith('es') ? 'introductions' : 'introduction'))
          .replace(/\bmatched\b/gi, 'introduced')
          .replace(/\bWANT\b/g, 'want')
          .replace(/\bHAVE\b/g, 'have');
      } else prose(v);
    }
  };
  prose(out);
  return out;
}

export function loadSchemaDoc(name: SchemaName): any {
  const derivedFrom = DERIVED_FROM[name];
  // Prefer the package's own document. Deriving is the fallback for an
  // installed copy that predates the rename, and it retires itself the moment
  // the dependency is bumped.
  if (derivedFrom && !schemaShipped(name)) {
    const source = JSON.parse(readFileSync(schemaFile(derivedFrom), 'utf8'));
    const doc = wireForm(source, canonicalId(name));
    // The kind const travels with the name.
    if (doc.properties?.kind?.const === derivedFrom) doc.properties.kind.const = name;
    return doc;
  }
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
  /** The validator's own account, path first: for logs and for tests. */
  reasons: string[];
  /**
   * The same refusals said in words. This is what an agent is handed when a
   * post will not go up, because the validator's own account leaks straight
   * into a chat window and reads like a fault the person at the keyboard
   * caused. One sentence per thing wrong, naming the thing.
   */
  plain: string[];
}

/** What a slot will take, in words. */
const TYPE_WORDS: Record<string, string> = {
  integer: 'a whole number',
  number: 'a number',
  string: 'words',
  boolean: 'true or false',
  array: 'a list',
  object: 'a set of fields',
  null: 'nothing at all',
};

/** Where the trouble is, as one dotted name an agent's author can find. */
function whereIs(instancePath: string, extra?: string): string {
  const parts = instancePath.split('/').filter(Boolean);
  if (extra) parts.push(extra);
  return parts.join('.') || 'what was sent';
}

/**
 * One validator complaint, said plainly. Nothing here is a judgement about
 * the human: it says what is missing, what is the wrong shape, and what is
 * not taken, and it is safe to read out loud if a client ever prints it.
 */
export function plainReason(e: any): string {
  const p = e?.params ?? {};
  const at = whereIs(e?.instancePath ?? '');
  switch (e?.keyword) {
    case 'required':
      return `${whereIs(e.instancePath, p.missingProperty)} is needed, and nothing was sent for it`;
    case 'additionalProperties':
      return `${whereIs(e.instancePath, p.additionalProperty)} is not something this takes`;
    case 'type': {
      const types = (Array.isArray(p.type) ? p.type : [p.type]).map(
        (t: string) => TYPE_WORDS[t] ?? String(t),
      );
      return `${at} has to be ${types.join(' or ')}`;
    }
    case 'enum':
      return `${at} has to be one of: ${(p.allowedValues ?? []).join(', ')}`;
    case 'const':
      return `${at} has to be ${String(p.allowedValue)}`;
    case 'minimum':
    case 'exclusiveMinimum':
      return `${at} has to be ${p.limit} or more`;
    case 'maximum':
    case 'exclusiveMaximum':
      return `${at} has to be ${p.limit} or less`;
    case 'minLength':
      return p.limit === 1 ? `${at} cannot be empty` : `${at} needs ${p.limit} characters or more`;
    case 'maxLength':
      return `${at} has to be ${p.limit} characters or fewer`;
    case 'minItems':
      return `${at} needs ${p.limit} of them or more`;
    case 'maxItems':
      return `${at} holds ${p.limit} of them or fewer`;
    case 'pattern':
    case 'format':
      return `${at} is not written the way this takes it`;
    default:
      return `${at} ${String(e?.message ?? 'is not right').replace(/^must /, 'has to ')}`.trim();
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
(addFormats as any).default ? (addFormats as any).default(ajv) : (addFormats as any)(ajv);

/**
 * Where an outbound payload is actually checked, when the installed package's
 * document still writes a word this switchboard has left behind. The published
 * document stays registered under its own $id — the schema package's own
 * conformance fixtures are written against it, and validatePayload keeps
 * answering for it — and a wire copy sits beside it for assertOutbound. The
 * copy is only made while it differs, so it retires itself with the dependency
 * bump.
 */
const WIRE_ID = new Map<string, string>();

// Register every document the installed package can supply. The match.* and
// channel.* names drop out of this loop once the dependency carries intro.* and
// conversation.* of its own, which is exactly when nothing asks for them any
// more.
for (const name of SCHEMA_NAMES) {
  if (!schemaShipped(name) && !DERIVED_FROM[name]) continue;
  const doc = loadSchemaDoc(name);
  ajv.addSchema(doc);
  if (OUTBOUND_NAMES.includes(name) && predatesWireWords(doc)) {
    ajv.addSchema(wireForm(doc, wireId(name)));
    WIRE_ID.set(name, wireId(name));
  }
}

function validateAgainst(id: string, schema: string, data: unknown): ValidationResult {
  const validate = ajv.getSchema(id);
  if (!validate) throw new Error(`unknown schema: ${schema}`);
  const valid = validate(data) as boolean;
  const errors = validate.errors ?? [];
  const reasons = errors.map(
    (e) => `${e.instancePath} ${e.keyword} ${e.message} ${JSON.stringify(e.params)}`,
  );
  return { valid, reasons, plain: errors.map(plainReason) };
}

/** Validate against the PUBLISHED document of that name — what the protocol
 *  says, which is what the schema package's conformance suite asks about. */
export function validatePayload(schema: SchemaName, data: unknown): ValidationResult {
  return validateAgainst(canonicalId(schema), schema, data);
}

/** Validate against the WIRE form: the document as this switchboard sends it.
 *  Identical to validatePayload for every name the installed package already
 *  writes in the switchboard's own words. */
export function validateOutbound(schema: SchemaName, data: unknown): ValidationResult {
  return validateAgainst(WIRE_ID.get(schema) ?? canonicalId(schema), schema, data);
}

/**
 * Assert an outbound counterparty payload conforms to its schema. Throws if
 * not — a switchboard that would emit a non-conformant disclosure payload has
 * a bug and must not send anything at all. This is the wire form: the document
 * as this switchboard sends it, in the words it sends them in.
 */
export function assertOutbound<T>(schema: SchemaName, data: T): T {
  const r = validateOutbound(schema, data);
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
  // What the agent is told when a step is not open to it yet. The switchboard
  // keeps its stages; the word it says out loud does not.
  | 'NOT_UNLOCKED_YET'
  | 'INTENT_EXPIRED'
  | 'SCREENING_REJECTED'
  | 'RATE_LIMITED'
  | 'RATE_LIMITED_OFFERS'
  | 'SETTLEMENT_UNAVAILABLE'
  | 'LOCATION_UNRESOLVED'
  | 'LOCATION_AMBIGUOUS'
  // Nothing in, nothing out: this account has been stopped by the operator
  // (docs/trust-and-safety.md). Ahead of the pinned error document — see
  // AHEAD_OF_SCHEMA below.
  | 'SUSPENDED'
  // This side of a conversation has spent the window its human's last press
  // granted it (domain/conversationWindow.ts). Nothing is lost and collecting
  // still works; one press starts a fresh window. Also ahead of the pinned
  // error document.
  | 'CONVERSATION_PAUSED';

/**
 * Codes this server ships that the pinned error document has not caught up
 * with. Their payloads are BUILT rather than validated: the field set is
 * exactly the one the document already admits, and the only thing it would
 * fail on is the code's own spelling.
 *
 * The alternative — waiting for a schema release before an operator can stop
 * an account — is not one this repository is willing to offer. The list is
 * meant to be short and to empty itself as the schema catches up.
 */
const AHEAD_OF_SCHEMA: readonly ErrorCode[] = ['SUSPENDED', 'CONVERSATION_PAUSED'];

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
  /**
   * The press an agent may wait on, when this refusal carries a link. Added
   * after the schema check rather than inside it: the published error document
   * closes itself to unknown properties, and this field is ahead of it. It is
   * additive and optional, so an agent holding the older schema ignores it.
   */
  press_id?: string;
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
      /** The approval link row this refusal handed over, to wait on. */
      press_id?: string;
    } = {},
  ) {
    super(code);
    const payload = {
      schema_version: SCHEMA_VERSION,
      code,
      ...(opts.human_action ? { human_action: opts.human_action } : {}),
      ...(opts.retry_after !== undefined ? { retry_after: opts.retry_after } : {}),
      ...(opts.suggestions?.length ? { suggestions: opts.suggestions.slice(0, 3) } : {}),
      ...(opts.candidates?.length ? { candidates: opts.candidates.slice(0, 5) } : {}),
      docs_url: `https://openswitchboard.ai/docs/errors#${code}`,
    };
    this.payload = AHEAD_OF_SCHEMA.includes(code)
      ? (payload as ProtocolError)
      : assertOutbound('error', payload);
    // After the check, deliberately: see the note on ProtocolError.press_id.
    if (opts.press_id) this.payload.press_id = opts.press_id;
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

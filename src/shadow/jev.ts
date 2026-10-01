/**
 * ASKING SOMEBODY ELSE'S MODEL, AND CHANGING NOTHING BY IT.
 * (docs/jev-shadow.md; the two trials are in src/shadow/jevTrials.ts.)
 *
 * TypeSafe AI's "Jev" System One model answers small, closed questions: pick
 * one of these options, score this on this ladder, how true is this. Two of
 * the switchboard's own judgements are exactly that shape — which taxonomy
 * node a posting belongs under, and whether a want and a have are about the
 * same thing — and both of them are currently made by a cosine over Titan
 * embeddings plus a weighted blend. Whether a model built for the job would
 * do better is a question with an answer, and this is the cheapest honest way
 * to get it.
 *
 * SHADOW MEANS SHADOW. Jev is asked, its answer is written down beside ours,
 * and nothing the switchboard does moves because of it. No card is filed
 * differently, no pair is scored differently, no human hears anything. The
 * only thing in this repository that reads jev_shadow is a report script an
 * operator runs by hand. If that ever stops being true it stops being a
 * shadow, and the decision to let an outside model touch a live judgement is
 * a decision somebody makes deliberately, with a DPA in hand — not one that
 * arrives by a small edit to a call site.
 *
 * THE SHADOW IS DEV ONLY, TWICE OVER. The trials are off unless
 * JEV_SECRET_ARN is set, and they refuse to come up in prod even if somebody
 * sets it (askJev below). Belt and braces because the infra deploy reaches
 * both environments from one command.
 *
 * THE ONE EXCEPTION IS THE BORDERLINE JUDGE (founder, 29 September 2026;
 * src/domain/jevJudge.ts). That decision was made deliberately, as the
 * paragraph above asked: Jev decides the tier of a borderline pair where
 * JEV_MATCHING is on (config.ts; on in dev, OFF in prod by default until a
 * data-processing agreement and privacy wording are in place). It has its own
 * entry point, askJevForMatching, gated on that flag and nothing else; askJev
 * keeps refusing prod, so switching the judge on never switches the shadow on.
 *
 * WHAT NEVER LEAVES. No price, no geography, no account id, no email, no
 * conversation text, no free text beyond the poster's own word for the thing
 * and their structured attributes. The state builders in jevTrials.ts are
 * where that is enforced and where the tests assert on the exact key set,
 * because "we only send a bit of it" is a claim that has to be checkable.
 *
 * WHAT IS NEVER LOGGED: the API key, and the state. A posting's words at info
 * level would put the thing we are being careful about into the one place
 * that is read casually. Counts, ids, statuses and latencies, same as
 * everywhere else in this service.
 *
 * NEVER THROWS. Every path out of askJev is a value. A shadow that can fail a
 * screening worker or a matching run is worse than no shadow at all, and the
 * callers are already wrapped as well — this is the inner of two belts.
 */
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { secretsManager } from '../aws.js';
import type { Config } from '../config.js';

/** The one endpoint, and a parameter only so the suite can point elsewhere. */
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** The model. Pinned by name rather than by version: this is a shadow, and a
 *  newer System One is the thing we would want to be reading about anyway. */
export const JEV_MODEL = 'jev-latest';

/**
 * Four seconds. Nothing waits on this — both callers have already answered
 * and moved on — but a request that has not come back by then is holding a
 * socket and a task's attention for an answer nobody is going to read today.
 */
export const JEV_TIMEOUT_MS = 4_000;

/** The one retry's pause. Short because the caller is fire-and-forget and the
 *  next posting is already behind this one. */
export const JEV_RETRY_MS = 400;

/** The statuses worth asking again about: rate limited, and overloaded. */
export const JEV_RETRY_STATUSES = [429, 529];

/**
 * The largest answer body read. A handful of short answers is a few hundred
 * bytes; anything near this is not an answer, and a body is never buffered
 * past it (2026-09-28 review).
 */
export const JEV_MAX_BODY_BYTES = 64 * 1024;

/**
 * WHERE THE KEY MAY BE SENT (2026-09-28 review). JEV_ENDPOINT can be
 * overridden from the environment, and the request carries the bearer key, so
 * an override is held to https and to the documented endpoint's own host. The
 * suite (NODE_ENV=test) may point it anywhere, because it stubs fetch.
 */
export function jevEndpointAllowed(
  endpoint: string,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  if (nodeEnv === 'test') return true;
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && u.host === new URL(JEV_ENDPOINT).host;
  } catch {
    return false;
  }
}

/** A token count as a whole number that fits the column, whatever was sent. */
function tokenCount(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.min(2_000_000_000, Math.max(0, Math.trunc(n))) : 0;
}

/** A body read no further than the cap. Throws past it. */

async function readCappedJson(res: any): Promise<unknown> {
  const declared = Number(res?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > JEV_MAX_BODY_BYTES) throw new Error('too-large');
  let text: string;
  const reader = res?.body?.getReader?.();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > JEV_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('too-large');
      }
      chunks.push(value);
    }
    text = Buffer.concat(chunks).toString('utf8');
  } else if (typeof res?.text === 'function') {
    text = String(await res.text());
    if (Buffer.byteLength(text, 'utf8') > JEV_MAX_BODY_BYTES) throw new Error('too-large');
  } else {
    throw new Error('unreadable');
  }
  return JSON.parse(text);
}

/**
 * Only the answers to questions that were asked, and inside each only what
 * the question allows: a choice that is one of the offered keys, probabilities
 * over the offered keys, a noul in [0, 1], a score's legend cut to a line.
 * Anything else is dropped rather than stored.
 */
export function whitelistAnswers(
  answers: Record<string, JevAnswer>,
  questions: Record<string, JevQuestion>,
): Record<string, JevAnswer> {
  const out: Record<string, JevAnswer> = {};
  const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
  const onlyKeys = (p: Record<string, number>, keys: string[]) => {
    const kept: Record<string, number> = {};
    for (const k of keys) if (typeof p?.[k] === 'number') kept[k] = clamp01(p[k]);
    return kept;
  };
  for (const [id, q] of Object.entries(questions)) {
    const a = answers[id];
    if (!a || a.type !== q.type) continue;
    if (q.type === 'choice' && a.type === 'choice') {
      const keys = Object.keys(q.criteria);
      if (!keys.includes(a.choice)) continue;
      out[id] = {
        type: 'choice',
        choice: a.choice,
        probabilities: onlyKeys(a.probabilities, keys),
        confidence: clamp01(a.confidence),
      };
    } else if (q.type === 'noul' && a.type === 'noul') {
      if (!Number.isFinite(a.noul)) continue;
      out[id] = { type: 'noul', noul: clamp01(a.noul) };
    } else if (q.type === 'score' && a.type === 'score') {
      if (!Number.isFinite(a.score)) continue;
      out[id] = {
        type: 'score',
        score: a.score,
        legend: String(a.legend ?? '').slice(0, 200),
        probabilities: onlyKeys(a.probabilities, q.criteria),
        confidence: clamp01(a.confidence),
      };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The question and answer shapes, as docs.typesafe.ai/api.md describes them.
// ---------------------------------------------------------------------------

/** Pick one. `criteria` maps an option key to a description of it. */
export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

/** How true is it. `criteria` optionally says what true and false mean. */
export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}

/** Where on this ladder. `criteria` is the ordered levels, lowest first. */
export interface JevScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion | JevScoreQuestion;

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevNoulAnswer {
  type: 'noul';
  /** 0..1. Not a probability and not a yes/no; the API's own word for it. */
  noul: number;
}

export interface JevScoreAnswer {
  type: 'score';
  score: number;
  /** The level's own words, which is what makes the number readable later. */
  legend: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer;

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
}

export type JevResult =
  | {
      ok: true;
      answers: Record<string, JevAnswer>;
      usage?: JevUsage;
      /** Wall clock for the whole call, retry included. Recorded, not acted on. */
      latencyMs: number;
    }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Whether this deployment has it at all.
// ---------------------------------------------------------------------------

interface JevState {
  cfg: Config;
  /** The SHADOW. Settled at init: false in prod, and false with no secret configured. */
  enabled: boolean;
  /** The BORDERLINE JUDGE (jevJudge.ts). Settled at init: JEV_MATCHING on
   *  and a secret configured, in any environment. */
  matching?: boolean;
  /** SHELF CHOICE AT THE DOOR (domain/jevShelf.ts). Settled at init: JEV_SHELF
   *  on and a secret configured, in any environment. */
  shelf?: boolean;
  key?: string;
  keyFetchedAt?: number;
}

let state: JevState | undefined;

/**
 * Called once at boot, the same shape initPhotoDna and initStripe use, and it
 * says out loud which of the two reasons it is off for. "No ARN" is the
 * ordinary state of any deployment nobody has switched this on for; "prod"
 * is the interesting one, because it means an env var reached an environment
 * that was never supposed to have it and somebody should go and look.
 */
export function initJev(cfg: Config, log: (msg: string) => void = () => {}): void {
  const hasArn = !!cfg.jevSecretArn;
  const wantsMatching = cfg.jevMatching === true;
  const matching = wantsMatching && hasArn;
  const wantsShelf = cfg.jevShelf === true;
  const shelf = wantsShelf && hasArn;
  if (cfg.envName === 'prod') {
    state = { cfg, enabled: false, matching, shelf };
    if (hasArn && !wantsMatching && !wantsShelf) {
      log(
        'jev shadow refuses to start in prod: JEV_SECRET_ARN is set on a prod task ' +
          'with JEV_MATCHING off. The shadow is dev-only and stays off here.',
      );
    }
  } else {
    state = { cfg, enabled: hasArn, matching, shelf };
    log(
      hasArn
        ? 'jev shadow is on for this deployment: answers are recorded and change nothing'
        : 'jev shadow is off for this deployment: JEV_SECRET_ARN is not set',
    );
  }
  if (matching) {
    log(
      'jev matching is on for this deployment: borderline pairs are judged by Jev, ' +
        'and by the rules wherever Jev does not answer in time',
    );
  } else if (wantsMatching) {
    log('jev matching is on in config but JEV_SECRET_ARN is not set: the rules judge every pair');
  }
  if (shelf) {
    log('jev shelf choice is on for this deployment: Jev may choose among the door\'s shelves when the door is unsure');
  } else if (wantsShelf) {
    log('jev shelf choice is on in config but JEV_SECRET_ARN is not set: the rules choose every shelf');
  }
}

/** True only where the shadow may actually call out. */
export function jevEnabled(): boolean {
  return !!state?.enabled;
}

/** True only where the borderline judge may call out (jevJudge.ts). */
export function jevMatchingEnabled(): boolean {
  return !!state?.matching;
}

/** True only where shelf choice at the door may call out (jevShelf.ts). */
export function jevShelfEnabled(): boolean {
  return !!state?.shelf;
}

/** For the suite: forget the decision and the cached key. */
export function resetJevForTests(): void {
  state = undefined;
}

/**
 * The API key, from Secrets Manager, held five minutes — the same window and
 * the same reasoning as the Stripe and PhotoDNA keys. Returned and never
 * logged, never put in an error, never written down.
 */
async function apiKey(cfg: Config): Promise<string> {
  const s = state;
  if (s && s.key && Date.now() - (s.keyFetchedAt ?? 0) < 5 * 60_000) return s.key;
  if (!cfg.jevSecretArn) throw new Error('jev secret is not configured');
  const r = await secretsManager.send(new GetSecretValueCommand({ SecretId: cfg.jevSecretArn }));
  const json = JSON.parse(r.SecretString ?? '{}');
  if (!json.apiKey) throw new Error('jev secret is missing apiKey');
  if (s) {
    s.key = String(json.apiKey);
    s.keyFetchedAt = Date.now();
  }
  return String(json.apiKey);
}

// ---------------------------------------------------------------------------
// The call.
// ---------------------------------------------------------------------------

/**
 * Read the API's answer into the three shapes above, keeping only fields this
 * repository knows the meaning of. It is somebody else's API and the field
 * names are theirs to change, so anything unreadable is dropped rather than
 * stored: a jev_shadow row with a half-understood answer in it would be read
 * later as if it meant something.
 */
export function readJevAnswers(payload: unknown): Record<string, JevAnswer> {
  const body = payload as Record<string, any> | undefined;
  const raw = body?.answers ?? body?.questions ?? body;
  const out: Record<string, JevAnswer> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, a] of Object.entries(raw as Record<string, any>)) {
    if (!a || typeof a !== 'object') continue;
    if (a.type === 'choice' && typeof a.choice === 'string') {
      out[id] = {
        type: 'choice',
        choice: a.choice,
        probabilities: numberMap(a.probabilities),
        confidence: Number(a.confidence ?? 0),
      };
    } else if (a.type === 'noul' && typeof a.noul === 'number') {
      out[id] = { type: 'noul', noul: a.noul };
    } else if (typeof a.score === 'number') {
      // The score answer is the one shape the docs do not give a `type` for.
      out[id] = {
        type: 'score',
        score: a.score,
        legend: String(a.legend ?? ''),
        probabilities: numberMap(a.probabilities),
        confidence: Number(a.confidence ?? 0),
      };
    }
  }
  return out;
}

function numberMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
  }
  return out;
}

/**
 * Ask Jev. One HTTP call, one retry on 429 or 529, and a value on every path
 * out including the ones that went wrong.
 *
 * The reasons are deliberately coarse — 'http-429', 'timeout', 'disabled' —
 * because they end up in a log line and a status is the whole of what is safe
 * to put there. A response body from a service we have just handed a key to is
 * not, and neither is any part of the state.
 */
export async function askJev(
  subject: unknown,
  questions: Record<string, JevQuestion>,
  opts: { timeoutMs?: number } = {},
): Promise<JevResult> {
  // Deliberately the process's own settled decision and nothing a caller can
  // pass in. There is no argument that turns this on somewhere it is off.
  const cfg = state?.cfg;
  if (!cfg) return { ok: false, reason: 'not-initialised' };
  if (cfg.envName === 'prod') return { ok: false, reason: 'prod' };
  if (!jevEnabled()) return { ok: false, reason: 'disabled' };

  let key: string;
  try {
    key = await apiKey(cfg);
  } catch {
    // No message in the line: the failures here are "no ARN" and "the secret
    // is not the shape we expect", and neither is worth risking a key in a log.
    return { ok: false, reason: 'no-key' };
  }
  return postToJev({
    state: subject,
    questions,
    apiKey: key,
    endpoint: cfg.jevEndpoint ?? JEV_ENDPOINT,
    model: cfg.jevModel ?? JEV_MODEL,
    timeoutMs: opts.timeoutMs,
  });
}

/**
 * Ask Jev FOR THE MATCHER (src/domain/jevJudge.ts), which is the one path
 * allowed to call out in prod, and only where JEV_MATCHING is on and a secret
 * is configured. Settled at boot like askJev's gate; nothing a caller passes
 * can turn it on. One attempt, no retry: a matching run is waiting on it, and
 * the rules' answer is always there to fall back on.
 */
export async function askJevForMatching(
  subject: unknown,
  questions: Record<string, JevQuestion>,
  opts: { timeoutMs: number },
): Promise<JevResult> {
  const cfg = state?.cfg;
  if (!cfg) return { ok: false, reason: 'not-initialised' };
  if (!jevMatchingEnabled()) return { ok: false, reason: 'disabled' };
  let key: string;
  try {
    key = await apiKey(cfg);
  } catch {
    return { ok: false, reason: 'no-key' };
  }
  return postToJev({
    state: subject,
    questions,
    apiKey: key,
    endpoint: cfg.jevEndpoint ?? JEV_ENDPOINT,
    model: cfg.jevModel ?? JEV_MODEL,
    timeoutMs: opts.timeoutMs,
    retry: false,
  });
}

/**
 * Ask Jev WHICH SHELF, at the publish door (src/domain/jevShelf.ts). The second
 * prod-capable path, with its own flag: JEV_SHELF on and a secret configured.
 * Settled at boot; nothing a caller passes can turn it on. One attempt, no
 * retry: a posting is waiting, and the door's own answer is always there.
 */
export async function askJevForShelf(
  subject: unknown,
  questions: Record<string, JevQuestion>,
  opts: { timeoutMs: number },
): Promise<JevResult> {
  const cfg = state?.cfg;
  if (!cfg) return { ok: false, reason: 'not-initialised' };
  if (!jevShelfEnabled()) return { ok: false, reason: 'disabled' };
  let key: string;
  try {
    key = await apiKey(cfg);
  } catch {
    return { ok: false, reason: 'no-key' };
  }
  return postToJev({
    state: subject,
    questions,
    apiKey: key,
    endpoint: cfg.jevEndpoint ?? JEV_ENDPOINT,
    model: cfg.jevModel ?? JEV_MODEL,
    timeoutMs: opts.timeoutMs,
    retry: false,
  });
}

/**
 * The HTTP half on its own: everything above the wire and nothing about this
 * deployment.
 *
 * It is separate because the offline transcript scorer
 * (scripts/eval/jev-transcript-score.mts) needs exactly this — the request
 * shape, the retry, the reading of the answers — and must NOT come through the
 * server's boot path: it is a thing a person runs against a file, with a key it
 * fetches itself, and it has no Config, no database and no business reaching
 * for either. Nothing about the dev-only rule is weakened by that, because
 * everything this function knows it was handed.
 */
export async function postToJev(req: {
  state: unknown;
  questions: Record<string, JevQuestion>;
  apiKey: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  /** One retry on 429/529 (the default), or none. */
  retry?: boolean;
}): Promise<JevResult> {
  const { state: subject, questions, apiKey: key } = req;
  if (!Object.keys(questions).length) return { ok: false, reason: 'no-questions' };

  const started = Date.now();
  const body = JSON.stringify({
    state: subject,
    model: req.model ?? JEV_MODEL,
    questions,
  });
  const endpoint = req.endpoint ?? JEV_ENDPOINT;
  if (!jevEndpointAllowed(endpoint)) return { ok: false, reason: 'bad-endpoint' };
  const timeoutMs = req.timeoutMs ?? JEV_TIMEOUT_MS;

  for (let attempt = 1; attempt <= 2; attempt++) {
    // AbortController rather than AbortSignal.timeout so the timer is ours to
    // clear: a four-second handle left behind per posting is a slow leak on a
    // worker that never stops.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: ac.signal,
      });
      if (!res.ok) {
        if (attempt === 1 && req.retry !== false && JEV_RETRY_STATUSES.includes(res.status)) {
          clearTimeout(timer);
          await new Promise((r) => setTimeout(r, JEV_RETRY_MS));
          continue;
        }
        return { ok: false, reason: `http-${res.status}` };
      }
      let payload: unknown;
      try {
        payload = await readCappedJson(res);
      } catch (e: any) {
        return { ok: false, reason: e?.message === 'too-large' ? 'too-large' : 'unreadable' };
      }
      const answers = whitelistAnswers(readJevAnswers(payload), questions);
      if (!Object.keys(answers).length) return { ok: false, reason: 'unreadable' };

      const usage = (payload as any)?.usage;
      return {
        ok: true,
        answers,
        ...(usage && typeof usage === 'object'
          ? {
              usage: {
                input_tokens: tokenCount(usage.input_tokens),
                output_tokens: tokenCount(usage.output_tokens),
              },
            }
          : {}),
        latencyMs: Date.now() - started,
      };
    } catch (e: any) {
      // An abort and a dead socket are the same to a shadow: no answer.
      return { ok: false, reason: e?.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: 'retried' };
}

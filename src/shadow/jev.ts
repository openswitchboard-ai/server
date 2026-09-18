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
 * DEV ONLY, TWICE OVER. The feature is off unless JEV_SECRET_ARN is set, and
 * it refuses to come up in prod even if somebody sets it. There is no
 * osb/prod/jev secret and infra never makes one. Belt and braces because the
 * infra deploy reaches both environments from one command, and "prod got the
 * env var by accident" is a thing that happens to every project eventually.
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
  /** Settled at init: false in prod, and false with no secret configured. */
  enabled: boolean;
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
  if (cfg.envName === 'prod') {
    state = { cfg, enabled: false };
    if (hasArn) {
      log(
        'jev shadow refuses to start in prod: JEV_SECRET_ARN is set on a prod task, ' +
          'which infra does not do. The shadow is dev-only and stays off here.',
      );
    }
    return;
  }
  state = { cfg, enabled: hasArn };
  log(
    hasArn
      ? 'jev shadow is on for this deployment: answers are recorded and change nothing'
      : 'jev shadow is off for this deployment: JEV_SECRET_ARN is not set',
  );
}

/** True only where the shadow may actually call out. */
export function jevEnabled(): boolean {
  return !!state?.enabled;
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
        if (attempt === 1 && JEV_RETRY_STATUSES.includes(res.status)) {
          clearTimeout(timer);
          await new Promise((r) => setTimeout(r, JEV_RETRY_MS));
          continue;
        }
        return { ok: false, reason: `http-${res.status}` };
      }
      const payload = await res.json();
      const answers = readJevAnswers(payload);
      if (!Object.keys(answers).length) return { ok: false, reason: 'unreadable' };
      const usage = (payload as any)?.usage;
      return {
        ok: true,
        answers,
        ...(usage && typeof usage === 'object'
          ? {
              usage: {
                input_tokens: Number(usage.input_tokens ?? 0),
                output_tokens: Number(usage.output_tokens ?? 0),
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

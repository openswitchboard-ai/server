/**
 * EDGE-CASE PROBE against the DEV switchboard. Never prod: assertDev() refuses
 * any host without "-dev." in it.
 *
 * For each use case in cases.ts it bootstraps throwaway dev accounts exactly
 * the way the integration suite does (ops-queue create-account, counter sign-in,
 * PIN, onboarding, OAuth 2.1 as 'osb-integration-suite'), posts over MCP the
 * way an assistant would, answers question-type refusals with the obvious
 * facts (at most a few tries), then waits for introductions and records what
 * the switchboard said back. Every tool answer is kept, redacted.
 *
 * Teardown ALWAYS runs: withdraw_intent on everything posted, a list sweep for
 * anything missed, then retireAccountCards over every account created.
 *
 *   AWS_PROFILE=openswitchboard AWS_REGION=us-east-1 npm run probe [-- --only 3,4]
 *
 * Output: a redacted JSON log in test/probe/out/ (gitignored); the report is
 * written by hand from it.
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BASE_URL,
  bootstrapActor,
  mcpRpc,
  retireAccountCards,
  type TestActor,
} from '../integration/helpers.js';
import { assertDev, loadRatelimitBypass } from '../rehearsal/config.js';
import { CASES, type Case, type Listing, type Posting } from './cases.js';

const OUT = join(import.meta.dirname, 'out');
mkdirSync(OUT, { recursive: true });
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const ACCOUNTS_FILE = join(OUT, `accounts-${STAMP}.txt`);

const POST_WAIT_MS = Number(process.env.PROBE_SCREEN_WAIT_MS ?? 240_000);
const MATCH_WAIT_MS = Number(process.env.PROBE_MATCH_WAIT_MS ?? 180_000);

/** Links with a token, keys, and every uuid come out of anything written down. */
export function redact(v: unknown): unknown {
  const s = JSON.stringify(v, (_k, x) =>
    typeof x === 'string'
      ? x
          .replace(/https?:\/\/[^\s"'<>]*\/a\/[^\s"'<>]+/g, '[link redacted]')
          .replace(/osb_ak_[A-Za-z0-9_-]+/g, '[key redacted]')
          .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[id]')
      : x,
  );
  return s === undefined ? undefined : JSON.parse(s);
}

let rpc = 1;
/** A raw tools/call, no auto-confirm: every answer is recorded as it came. */
async function call(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpc++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  if (!res.ok) return { http: res.status, isError: true, result: { http_error: raw.slice(0, 400) } as any };
  const line = raw.split('\n').find((l) => l.startsWith('data:'));
  const payload = JSON.parse(line ? line.slice(5) : raw);
  if (payload.error) return { http: 200, isError: true, result: { rpc_error: payload.error } as any };
  const text = payload.result?.content?.[0]?.text;
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : payload.result;
  } catch {
    parsed = { text };
  }
  return { http: 200, isError: payload.result?.isError === true, result: parsed };
}

interface Step {
  tool: string;
  args: unknown;
  isError: boolean;
  what_happened?: string;
  code?: string;
  human_action?: string;
  questions?: unknown;
  result: unknown;
}

interface PostRecord {
  actor: string;
  label: string;
  steps: Step[];
  intentId?: string;
  outcome: string;
}

interface CaseRecord {
  n: number;
  title: string;
  note?: string;
  posts: PostRecord[];
  states?: Record<string, unknown>;
  sweeps?: Record<string, unknown>;
  waitedMs?: number;
  error?: string;
}

type Live = { actor: TestActor; key: string; intentIds: string[] };

function summarise(r: any): Pick<Step, 'what_happened' | 'code' | 'human_action' | 'questions'> {
  return {
    what_happened: r?.what_happened,
    code: r?.code ?? r?.error,
    human_action: r?.human_action ?? r?.say ?? r?.message,
    questions: r?.questions,
  };
}

/** Post one listing and answer question-type refusals like a reasonable assistant. */
async function postLikeAnAssistant(live: Live, p: Posting): Promise<PostRecord> {
  const rec: PostRecord = { actor: live.key, label: p.label, steps: [], outcome: 'unknown' };
  let listing: Listing = structuredClone(p.listing);
  let reference: string | undefined;
  let detailUnknown = false;
  let extraUsed = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const args: Record<string, unknown> = { listing };
    if (reference) args.reference = reference;
    if (detailUnknown) args.detail_unknown = true;
    const r = await call(live.actor.accessToken, 'publish_intent', args);
    const res = r.result ?? {};
    rec.steps.push({ tool: 'publish_intent', args, isError: r.isError, ...summarise(res), result: res });
    if (!r.isError && res.intent_id && !res.nothing_happened) {
      rec.intentId = res.intent_id;
      live.intentIds.push(res.intent_id);
      rec.outcome = `posted (${res.state ?? res.lifecycle_state ?? 'state not given'})`;
      return rec;
    }
    if (r.isError) {
      rec.outcome = `error: ${res.code ?? res.error ?? 'unknown'}`;
      return rec;
    }
    reference = res.reference ?? reference;
    switch (res.what_happened) {
      case 'confirm_figure':
        // The human said the figure was theirs: send it again as it stands.
        continue;
      case 'more_detail_needed': {
        const qs = JSON.stringify(res.questions ?? '') + String(res.human_action ?? '');
        if (/reach|posted to|pick-up|collect/i.test(qs)) {
          const geo = listing.geo as any;
          listing = { ...listing, geo: { ...geo, reach: 'radius', radius_km: geo?.radius_km ?? 25 } };
          continue;
        }
        if (p.extra && !extraUsed) {
          extraUsed = true;
          listing = { ...listing, attributes: { ...(listing.attributes as any), ...p.extra } };
          continue;
        }
        if (!detailUnknown) {
          detailUnknown = true;
          continue;
        }
        rec.outcome = 'stuck: more detail asked after detail_unknown';
        return rec;
      }
      case 'shelf_unclear': {
        const c = (res.candidates ?? [])[0];
        const cat = typeof c === 'string' ? c : (c?.category ?? c?.path ?? c?.shelf);
        if (!cat) {
          rec.outcome = 'stuck: shelf_unclear with no usable candidate';
          return rec;
        }
        listing = { ...listing, category: cat };
        continue;
      }
      case 'place_unclear': {
        const c = (res.candidates ?? res.places ?? [])[0];
        const place = typeof c === 'string' ? c : (c?.place ?? c?.name ?? c?.label);
        if (!place || attempt > 1) {
          rec.outcome = `refused: ${res.code}`;
          return rec;
        }
        listing = { ...listing, geo: { ...(listing.geo as any), place } };
        continue;
      }
      default:
        rec.outcome = `refused: ${res.code ?? res.what_happened}`;
        return rec;
    }
  }
  rec.outcome = 'stuck: gave up after 5 tries';
  return rec;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function introSummary(ci: any) {
  return {
    introductions: (ci?.introductions ?? []).map((m: any) => ({
      state: m.state,
      in_line: m.in_line,
      tier: m.possible_note ? 'possible' : 'sure',
      note: m.note?.text ?? m.note,
      possible_note: m.possible_note?.text ?? m.possible_note,
      kind: m.kind ?? m.signal?.kind ?? m.about,
      raw: m,
    })),
    near_misses: ci?.near_misses ?? [],
    error: ci?.what_happened && ci?.nothing_happened ? ci : undefined,
  };
}

async function runCase(c: Case, lives: Map<string, Live>): Promise<CaseRecord> {
  const rec: CaseRecord = { n: c.n, title: c.title, note: c.note, posts: [] };
  const started = Date.now();
  try {
    for (const a of c.actors) {
      const live = lives.get(`${c.n}:${a.key}`)!;
      for (const p of a.postings) rec.posts.push(await postLikeAnAssistant(live, p));
    }
    const mine = c.actors.map((a) => lives.get(`${c.n}:${a.key}`)!);
    // Wait for screening to settle every posting that went up.
    const deadline = Date.now() + POST_WAIT_MS;
    let states: Record<string, unknown> = {};
    for (;;) {
      states = {};
      let pending = false;
      for (const l of mine) {
        if (!l.intentIds.length) continue;
        const r = await call(l.actor.accessToken, 'list_intents', {});
        states[l.key] = (r.result?.intents ?? []).map((i: any) => ({
          kind: i.listing?.kind,
          category: i.listing?.category,
          state: i.state,
          expires_at: i.expires_at ?? i.listing?.expires_at,
          ttl_days: i.listing?.ttl_days,
          note: i.note?.text ?? i.note,
          raw: i,
        }));
        if ((r.result?.intents ?? []).some((i: any) => /PENDING/i.test(String(i.state)))) pending = true;
        if (!r.result?.intents) states[l.key] = r.result;
      }
      if (!pending || Date.now() > deadline) break;
      await sleep(15_000);
    }
    rec.states = states;
    // Then the introductions.
    const posted = mine.filter((l) => l.intentIds.length);
    const sweeps: Record<string, unknown> = {};
    if (c.waitForMatches && posted.length) {
      const until = Date.now() + MATCH_WAIT_MS;
      for (;;) {
        let allSeen = true;
        for (const l of posted) {
          const r = await call(l.actor.accessToken, 'check_in', {});
          sweeps[l.key] = introSummary(r.result);
          if (!((sweeps[l.key] as any).introductions.length)) allSeen = false;
        }
        const expected = new Set(c.expectPairs.flat());
        const expectedSeen = [...expected].every((k) => (sweeps[k] as any)?.introductions?.length);
        if ((expected.size && expectedSeen) || allSeen || Date.now() > until) break;
        await sleep(20_000);
      }
    } else {
      for (const l of posted) {
        const r = await call(l.actor.accessToken, 'check_in', {});
        sweeps[l.key] = introSummary(r.result);
      }
    }
    rec.sweeps = sweeps;
  } catch (e) {
    rec.error = (e as Error).message;
  }
  rec.waitedMs = Date.now() - started;
  return rec;
}

async function main() {
  assertDev();
  if (!/-dev\./.test(BASE_URL)) throw new Error('refusing: not a dev host');
  const bypass = await loadRatelimitBypass();
  console.log(`probe against ${BASE_URL} (rate-limit bypass: ${bypass ? 'yes' : 'no'})`);

  const onlyArg = process.argv.indexOf('--only');
  const only = onlyArg >= 0 ? new Set(process.argv[onlyArg + 1].split(',').map(Number)) : undefined;

  const lives = new Map<string, Live>();
  const accountIds: string[] = [];
  const results: CaseRecord[] = [];
  let schemaVersion = '';
  try {
    // Actors first, all at once: the ops queue is the slow part.
    const all = CASES('0.0.0').filter((c) => !only || only.has(c.n));
    const specs = all.flatMap((c) => c.actors.map((a) => ({ c, a })));
    console.log(`bootstrapping ${specs.length} throwaway dev accounts`);
    const settled = await Promise.allSettled(
      specs.map(async ({ c, a }) => {
        const actor = await bootstrapActor(a.firstName, a.locality);
        accountIds.push(actor.accountId);
        appendFileSync(ACCOUNTS_FILE, `${actor.accountId}\n`);
        lives.set(`${c.n}:${a.key}`, { actor, key: a.key, intentIds: [] });
      }),
    );
    const failed = settled.filter((s) => s.status === 'rejected');
    if (failed.length) {
      throw new Error(`${failed.length} account(s) failed to bootstrap: ${(failed[0] as PromiseRejectedResult).reason}`);
    }

    // The schema version the live tool schema tells an assistant to use.
    const first = [...lives.values()][0];
    const tl = await mcpRpc(first.actor.accessToken, 'tools/list', {});
    const pub = tl.result.tools.find((t: any) => t.name === 'publish_intent');
    schemaVersion =
      String(pub.inputSchema.properties.listing.properties.schema_version.description).match(/"(\d+\.\d+\.\d+)"/)?.[1] ?? '';
    const svDescription = String(pub.inputSchema.properties.listing.properties.schema_version.description ?? '');
    writeFileSync(join(OUT, `schema-version-description-${STAMP}.txt`), svDescription);
    if (!schemaVersion) {
      // Older deployments do not state the value in the tool schema; the
      // deployment's own health answer does.
      const hz = (await (await fetch(`${BASE_URL}/healthz`)).json()) as any;
      schemaVersion = String(hz.schema_version ?? '');
      console.log('the live tool schema does not state the schema version; took it from /healthz');
    }
    if (!schemaVersion) throw new Error('could not find the schema version');
    console.log(`live schema version: ${schemaVersion}`);
    // The posting manual section, once, as context for the report.
    const manual = await call(first.actor.accessToken, 'read_manual', { section: 'posting' });
    writeFileSync(join(OUT, `manual-posting-${STAMP}.json`), JSON.stringify(redact(manual.result), null, 2));

    const cases = CASES(schemaVersion).filter((c) => !only || only.has(c.n));
    const recs = await Promise.all(cases.map((c) => runCase(c, lives)));
    results.push(...recs);
  } catch (e) {
    console.error(`probe stopped: ${(e as Error).message}`);
    results.push({ n: 0, title: 'run error', posts: [], error: (e as Error).message });
  } finally {
    // TEARDOWN, always.
    let withdrawn = 0;
    for (const l of lives.values()) {
      for (const id of l.intentIds) {
        try {
          const r = await call(l.actor.accessToken, 'withdraw_intent', { intent_id: id });
          if (!r.isError) withdrawn++;
        } catch {
          /* best effort */
        }
      }
      try {
        const r = await call(l.actor.accessToken, 'list_intents', {});
        for (const i of r.result?.intents ?? []) {
          if (/PUBLISHED|PENDING/i.test(String(i.state)) && !l.intentIds.includes(i.intent_id)) {
            await call(l.actor.accessToken, 'withdraw_intent', { intent_id: i.intent_id });
            withdrawn++;
          }
        }
      } catch {
        /* best effort */
      }
    }
    console.log(`teardown: withdrew ${withdrawn} posting(s) through withdraw_intent`);
    await retireAccountCards(accountIds, 'probe teardown');
    const file = join(OUT, `probe-${STAMP}.json`);
    writeFileSync(file, JSON.stringify(redact({ schemaVersion, base: BASE_URL, results }), null, 2));
    console.log(`log: ${file}`);
  }
}

await main();
process.exit(0);

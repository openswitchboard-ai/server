/**
 * DB-side progress watching for the duet.
 *
 * Neither agent is asked "how far have you got?" — that would burn each
 * account's 60/h MCP read ceiling, and worse, it would let an agent's own
 * account of events into the run's record of what actually happened. So the
 * harness watches the same rows the product writes: the two accounts' cards,
 * the match between them, the interest flags, the stage-3 opt-in tokens, the
 * offers, the per-sender message tallies (the one durable trace of a channel
 * message — the messages themselves are encrypted and deleted on delivery),
 * and the archive.
 *
 * Snapshots are diffed into an EVENT TIMELINE, which is what the deadlock rule
 * reads: six nudge rounds with no new event and nothing put to either human
 * means the run has stopped moving.
 */
import { dbExec } from '../sim/harness.js';

export interface DbEvent {
  at: string;
  /** Which side, where the event belongs to one. */
  side?: 'priya' | 'marlowe' | 'both';
  kind: string;
  detail: string;
}

export interface CardRow {
  id: string;
  accountId: string;
  type: string;
  category: string;
  state: string;
  /** What the agent chose to write down. The richness gap between the two
   *  sides' attribute sets is what the semantic score turns on. */
  attributes: Record<string, unknown>;
  geo: Record<string, unknown>;
}

export interface MatchRow {
  id: string;
  accountWant: string;
  accountHave: string;
  stage: number;
  interestWant: boolean;
  interestHave: boolean;
  state: string;
  channelId?: string;
  openedAt?: string;
  archivedAt?: string;
}

export interface ConsentRow {
  matchId: string;
  accountId: string;
  kind: string;
  via: string;
}

export interface OfferRow {
  id: string;
  matchId: string;
  proposer: string;
  amount: number;
  ccy: string;
  state: string;
}

/**
 * A scored pair that passed every hard rule but fell short of the 0.75
 * create threshold, so no match was made. When the two run accounts turn up
 * here it is the single most important number of the run: the two agents wrote
 * listings for the same thing, in the same place, in the same category, and
 * the engine decided they were not close enough to introduce.
 */
export interface NearMissRow {
  wantAccount: string;
  haveAccount: string;
  score: number;
  category: string;
}

export interface Snapshot {
  at: string;
  cards: CardRow[];
  matches: MatchRow[];
  consents: ConsentRow[];
  offers: OfferRow[];
  /** channel_id -> sender account -> messages sent (a durable tally). */
  sends: Record<string, Record<string, number>>;
  /** Near-misses where BOTH sides are this run's accounts. */
  nearMisses: NearMissRow[];
}

const safeJson = (v: any): Record<string, unknown> => {
  try {
    return JSON.parse(String(v ?? '{}')) ?? {};
  } catch {
    return {};
  }
};

const b = (v: any): boolean => v === true || v === 't' || v === 'true' || v === 1;

export class ProgressWatcher {
  readonly events: DbEvent[] = [];
  private last?: Snapshot;

  constructor(
    private readonly accounts: { priya: string; marlowe: string },
    private readonly since: string,
  ) {}

  private sideOf(accountId?: string): DbEvent['side'] {
    if (!accountId) return undefined;
    const a = accountId.toLowerCase();
    if (a === this.accounts.priya.toLowerCase()) return 'priya';
    if (a === this.accounts.marlowe.toLowerCase()) return 'marlowe';
    return undefined;
  }

  private ids(): string {
    return `${this.accounts.priya},${this.accounts.marlowe}`;
  }

  async snapshot(): Promise<Snapshot> {
    const at = new Date().toISOString();
    const cardRows = await dbExec(
      `SELECT id::text, account_id::text, type, category, lifecycle_state,
              attributes::text, geo::text
         FROM cards
        WHERE account_id = ANY(string_to_array(:ids, ',')::uuid[])
          AND created_at > :since::timestamptz
        ORDER BY created_at`,
      [{ name: 'ids', value: this.ids() }, { name: 'since', value: this.since }],
    );
    const cards: CardRow[] = cardRows.map((r) => ({
      id: String(r[0]),
      accountId: String(r[1]),
      type: String(r[2]),
      category: String(r[3]),
      state: String(r[4]),
      attributes: safeJson(r[5]),
      geo: safeJson(r[6]),
    }));

    const matchRows = await dbExec(
      `SELECT id::text, account_want::text, account_have::text, stage,
              interest_want, interest_have, state, channel_id,
              opened_at::text, archived_at::text
         FROM matches
        WHERE (account_want = ANY(string_to_array(:ids, ',')::uuid[])
            OR account_have = ANY(string_to_array(:ids, ',')::uuid[]))
          AND created_at > :since::timestamptz
        ORDER BY created_at`,
      [{ name: 'ids', value: this.ids() }, { name: 'since', value: this.since }],
    );
    const matches: MatchRow[] = matchRows.map((r) => ({
      id: String(r[0]),
      accountWant: String(r[1]),
      accountHave: String(r[2]),
      stage: Number(r[3]),
      interestWant: b(r[4]),
      interestHave: b(r[5]),
      state: String(r[6]),
      channelId: r[7] ? String(r[7]) : undefined,
      openedAt: r[8] ? String(r[8]) : undefined,
      archivedAt: r[9] ? String(r[9]) : undefined,
    }));

    const matchIds = matches.map((m) => m.id).join(',');
    let consents: ConsentRow[] = [];
    let offers: OfferRow[] = [];
    const sends: Record<string, Record<string, number>> = {};
    if (matchIds) {
      const cr = await dbExec(
        `SELECT match_id::text, account_id::text, kind, recorded_via
           FROM consent_tokens
          WHERE match_id = ANY(string_to_array(:m, ',')::uuid[])`,
        [{ name: 'm', value: matchIds }],
      );
      consents = cr.map((r) => ({
        matchId: String(r[0]),
        accountId: String(r[1]),
        kind: String(r[2]),
        via: String(r[3]),
      }));
      const or = await dbExec(
        `SELECT id::text, match_id::text, proposer_account::text, amount::text, ccy, state
           FROM offers
          WHERE match_id = ANY(string_to_array(:m, ',')::uuid[])
          ORDER BY created_at`,
        [{ name: 'm', value: matchIds }],
      );
      offers = or.map((r) => ({
        id: String(r[0]),
        matchId: String(r[1]),
        proposer: String(r[2]),
        amount: Number(r[3]),
        ccy: String(r[4]),
        state: String(r[5]),
      }));
      const channelIds = matches.map((m) => m.channelId).filter(Boolean).join(',');
      if (channelIds) {
        // The only durable evidence a message crossed: delivery deletes the
        // message row, but the per-sender hourly tally survives it.
        const sr = await dbExec(
          `SELECT channel_id, sender_account::text, sum(n)::int
             FROM channel_send_rate
            WHERE channel_id = ANY(string_to_array(:c, ','))
            GROUP BY 1, 2`,
          [{ name: 'c', value: channelIds }],
        );
        for (const r of sr) {
          const ch = String(r[0]);
          sends[ch] = sends[ch] ?? {};
          sends[ch][String(r[1])] = Number(r[2]);
        }
      }
    }
    // Why the two sides did NOT meet, when they did not. Scoped to pairs where
    // both cards belong to this run, so nothing about anyone else is read.
    const nmRows = await dbExec(
      `SELECT nm.score, cw.account_id::text, ch.account_id::text, nm.category
         FROM near_misses nm
         JOIN cards cw ON cw.id = nm.card_want
         JOIN cards ch ON ch.id = nm.card_have
        WHERE cw.account_id = ANY(string_to_array(:ids, ',')::uuid[])
          AND ch.account_id = ANY(string_to_array(:ids, ',')::uuid[])
          AND nm.created_at > :since::timestamptz
        ORDER BY nm.created_at`,
      [{ name: 'ids', value: this.ids() }, { name: 'since', value: this.since }],
    );
    const nearMisses: NearMissRow[] = nmRows.map((r) => ({
      score: Number(r[0]),
      wantAccount: String(r[1]),
      haveAccount: String(r[2]),
      category: String(r[3]),
    }));

    return { at, cards, matches, consents, offers, sends, nearMisses };
  }

  /** Take a snapshot, diff it against the last, and append what is new. */
  async poll(): Promise<DbEvent[]> {
    const now = await this.snapshot();
    const fresh: DbEvent[] = [];
    const push = (kind: string, detail: string, side?: DbEvent['side']) =>
      fresh.push({ at: now.at, kind, detail, side });

    const prev = this.last;
    const prevCards = new Map((prev?.cards ?? []).map((c) => [c.id, c]));
    for (const c of now.cards) {
      const p = prevCards.get(c.id);
      if (!p) {
        push('card-published', `${c.type} ${c.category} (${c.state})`, this.sideOf(c.accountId));
      } else if (p.state !== c.state) {
        push('card-state', `${c.category}: ${p.state} -> ${c.state}`, this.sideOf(c.accountId));
      }
    }

    const prevMatches = new Map((prev?.matches ?? []).map((m) => [m.id, m]));
    for (const m of now.matches) {
      const p = prevMatches.get(m.id);
      const bothOurs =
        !!this.sideOf(m.accountWant) && !!this.sideOf(m.accountHave) ? 'both' : undefined;
      if (!p) {
        push('match-created', `${m.id.slice(0, 8)} (${bothOurs ? 'our two agents' : 'one of ours + an outsider'})`, bothOurs);
        continue;
      }
      if (p.interestWant !== m.interestWant) {
        push('interest', `${m.id.slice(0, 8)}: want side now ${m.interestWant}`, this.sideOf(m.accountWant));
      }
      if (p.interestHave !== m.interestHave) {
        push('interest', `${m.id.slice(0, 8)}: have side now ${m.interestHave}`, this.sideOf(m.accountHave));
      }
      if (p.stage !== m.stage) push('stage', `${m.id.slice(0, 8)}: stage ${p.stage} -> ${m.stage}`, bothOurs);
      if (p.state !== m.state) push('match-state', `${m.id.slice(0, 8)}: ${p.state} -> ${m.state}`, bothOurs);
      if (!p.channelId && m.channelId) push('conversation-open', `${m.id.slice(0, 8)} channel opened`, bothOurs);
      if (!p.archivedAt && m.archivedAt) push('archived', `${m.id.slice(0, 8)} archived`, bothOurs);
    }

    const key = (c: ConsentRow) => `${c.matchId}|${c.accountId}|${c.kind}`;
    const prevConsent = new Set((prev?.consents ?? []).map(key));
    for (const c of now.consents) {
      if (!prevConsent.has(key(c))) {
        push('consent', `${c.kind} recorded via ${c.via} on ${c.matchId.slice(0, 8)}`, this.sideOf(c.accountId));
      }
    }

    const prevOffers = new Map((prev?.offers ?? []).map((o) => [o.id, o]));
    for (const o of now.offers) {
      const p = prevOffers.get(o.id);
      if (!p) push('offer', `${o.amount} ${o.ccy} proposed (${o.state})`, this.sideOf(o.proposer));
      else if (p.state !== o.state) push('offer-state', `${o.amount} ${o.ccy}: ${p.state} -> ${o.state}`, this.sideOf(o.proposer));
    }

    for (const [ch, bySender] of Object.entries(now.sends)) {
      for (const [sender, n] of Object.entries(bySender)) {
        const before = prev?.sends?.[ch]?.[sender] ?? 0;
        if (n > before) {
          push('message-sent', `${n - before} message(s) on ${ch.slice(0, 8)} (total ${n})`, this.sideOf(sender));
        }
      }
    }

    const seenNm = new Set(
      (prev?.nearMisses ?? []).map((n) => `${n.wantAccount}|${n.haveAccount}|${n.score}`),
    );
    for (const n of now.nearMisses) {
      if (seenNm.has(`${n.wantAccount}|${n.haveAccount}|${n.score}`)) continue;
      push(
        'near-miss',
        `the two agents' own listings scored ${n.score.toFixed(4)} on ${n.category} — below the 0.75 create threshold, so no introduction was made`,
        'both',
      );
    }

    this.last = now;
    this.events.push(...fresh);
    return fresh;
  }

  get latest(): Snapshot | undefined {
    return this.last;
  }

  /** The match with our two accounts on opposite sides, if the matcher made one. */
  ourMatch(): MatchRow | undefined {
    return (this.last?.matches ?? []).find(
      (m) => !!this.sideOf(m.accountWant) && !!this.sideOf(m.accountHave),
    );
  }

  /**
   * A stage-3 opt-in this side's HUMAN still has to record: both sides have
   * shown interest on the match, and no opt-in token exists for the account.
   */
  stage3Pending(accountId: string): MatchRow[] {
    const s = this.last;
    if (!s) return [];
    return s.matches.filter((m) => {
      if (m.state !== 'open') return false;
      const party = m.accountWant === accountId || m.accountHave === accountId;
      if (!party) return false;
      if (!(m.interestWant && m.interestHave)) return false;
      return !s.consents.some(
        (c) => c.matchId === m.id && c.accountId === accountId && c.kind === 'stage3-optin',
      );
    });
  }

  /** An offer this side's human is being asked to accept (they did not make it). */
  offersAwaiting(accountId: string): OfferRow[] {
    const s = this.last;
    if (!s) return [];
    return s.offers.filter(
      (o) =>
        o.proposer !== accountId &&
        ['proposed', 'awaiting-human'].includes(o.state) &&
        s.matches.some(
          (m) => m.id === o.matchId && (m.accountWant === accountId || m.accountHave === accountId),
        ),
    );
  }
}

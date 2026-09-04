/**
 * The SCRIPTED counterparty side of the realism eval. Nagatha (the real agent
 * under test) is driven conversationally over SSH; everything on the OTHER side
 * of each match — posting the card that pairs with hers, reciprocating interest,
 * opting in on the approval page, opening the channel, sending a message,
 * making an offer, declining — is scripted here, over MCP against dev, exactly
 * the way the protocol sim harness drives a synthetic actor. We reuse the sim
 * Harness for its live-match observation (waitMatchDB, off the read ceiling),
 * card/match tracking and teardown, and the integration helpers for the
 * human-page steps (shared profile, approval-page opt-in, auto-negotiate).
 */
import {
  approveDisclosure,
  bootstrapActor,
  setAutoNegotiate,
  setSharedProfile,
} from '../integration/helpers.js';
import { Harness, McpResult, SimActor, dbExec, log } from '../sim/harness.js';

export interface NagathaCard {
  id: string;
  accountId: string;
  category: string;
  geo: any;
  attributes: Record<string, unknown>;
  type: string;
}

export class Counterpart {
  readonly h = new Harness();
  actor!: SimActor;
  readonly firstName: string;
  readonly locality: string;

  private constructor(firstName: string, locality: string) {
    this.firstName = firstName;
    this.locality = locality;
  }

  static async create(locality = 'Fremantle'): Promise<Counterpart> {
    const firstName = `Robin${randomSuffix()}`;
    const c = new Counterpart(firstName, locality);
    log(`bootstrapping counterpart "${firstName}" (${locality}) on dev...`);
    const a = await bootstrapActor(firstName, locality);
    c.actor = { ...a, label: 'counterpart', firstName, locality };
    c.h.actors.push(c.actor);
    log(`counterpart ready: account ${a.accountId.slice(0, 8)}`);
    return c;
  }

  mcp(name: string, args: Record<string, unknown>): Promise<McpResult> {
    return this.h.mcp(this.actor.accessToken, name, args);
  }

  /**
   * Find the card Nagatha just posted: the newest PUBLISHED card whose category
   * matches the SQL LIKE pattern `categoryLike` (e.g. "goods.bicycle%"), created
   * after `sinceIso`, that is NOT the counterpart's own account. A scoped,
   * non-enumerating lookup — this is how we learn her card id and the
   * geo/attributes to mirror, without any read against her account. The LIKE
   * pattern is used so we are robust to which exact taxonomy node she picks.
   */
  async findNagathaCard(categoryLike: string, sinceIso: string): Promise<NagathaCard | undefined> {
    const rows = await dbExec(
      `SELECT id::text, account_id::text, category, geo::text, type, attributes::text
         FROM cards
        WHERE category LIKE :cat AND lifecycle_state = 'PUBLISHED'
          AND created_at > :since::timestamptz
          AND account_id <> :self::uuid
        ORDER BY created_at DESC LIMIT 1`,
      [
        { name: 'cat', value: categoryLike },
        { name: 'since', value: sinceIso },
        { name: 'self', value: this.actor.accountId },
      ],
    );
    const r = rows[0];
    if (!r) return undefined;
    return {
      id: r[0] as string,
      accountId: r[1] as string,
      category: r[2] as string,
      geo: JSON.parse((r[3] as string) ?? '{}'),
      type: r[4] as string,
      attributes: JSON.parse((r[5] as string) ?? '{}'),
    };
  }

  /** Poll for Nagatha's card in a category for up to timeoutMs. */
  async waitNagathaCard(
    categoryLike: string,
    sinceIso: string,
    timeoutMs = 60_000,
  ): Promise<NagathaCard | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const card = await this.findNagathaCard(categoryLike, sinceIso);
      if (card) return card;
      if (Date.now() > deadline) return undefined;
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  /**
   * Publish the opposite-type card that pairs with Nagatha's, in the same place
   * (so both resolve to the same centre) and same category, mirroring her
   * attributes for a high semantic score. Returns the counterpart card id.
   */
  async postCounterpartCard(
    nag: NagathaCard,
    place: string,
    attributes?: Record<string, unknown>,
    opts: { reach?: string } = {},
  ): Promise<string> {
    const type = nag.type === 'WANT' ? 'HAVE' : 'WANT';
    // Mirror HER attributes by default: identical projection keys/values keep the
    // semantic cosine high (a divergent attribute set once scored a compatible
    // guitar pair at 0.68 — a near-miss below the 0.75 match threshold).
    const attrs = attributes ?? nag.attributes ?? {};
    const card: Record<string, unknown> = {
      schema_version: '0.3.0',
      type,
      category: nag.category,
      geo: { place, radius_km: 25, ...(opts.reach ? { reach: opts.reach } : {}) },
      ttl_days: 1,
      attributes: attrs,
    };
    let r = await this.h.publish(this.actor, card, { expectError: true });
    if (r.isError) {
      // Retry without attributes if the schema refused a mirrored one.
      log(`counterpart publish refused (${JSON.stringify(r.result).slice(0, 160)}); retrying thin`);
      const thin = { ...card };
      delete (thin as any).attributes;
      r = await this.h.publish(this.actor, thin, { expectError: true });
    }
    if (r.isError || !r.result?.intent_id) {
      throw new Error(`counterpart publish failed: ${JSON.stringify(r.result).slice(0, 240)}`);
    }
    return r.result.intent_id as string;
  }

  /** Wait for the LIVE matcher to pair Nagatha's card with the counterpart's. */
  async waitMatch(nagCardId: string, cpCardId: string, timeoutMs = 120_000): Promise<string | undefined> {
    const id = await this.h.waitMatchDB(nagCardId, cpCardId, timeoutMs);
    if (id) this.h.registerMatch(this.actor.accessToken, id);
    return id;
  }

  async expressInterest(matchId: string): Promise<McpResult> {
    return this.mcp('respond', { match_id: matchId, action: 'express_interest' });
  }

  /**
   * Opt in from the counterpart side, the way its human would: put the first
   * name + area on the shared-profile page, then record the opt-in through the
   * approval page (the path we fully control via the counterpart's session).
   */
  async optIn(matchId: string): Promise<void> {
    await setSharedProfile(this.actor.jar, this.firstName, this.locality);
    await approveDisclosure(this.actor.jar, matchId, this.actor.pin, {
      firstName: this.firstName,
      locality: this.locality,
    });
  }

  async openChannel(matchId: string): Promise<McpResult> {
    return this.mcp('open_conversation', { match_id: matchId });
  }

  async channelSend(matchId: string, text: string): Promise<McpResult> {
    return this.mcp('send_message', { match_id: matchId, text });
  }

  async channelReceive(matchId: string): Promise<McpResult> {
    return this.mcp('collect_messages', { match_id: matchId });
  }

  /** Switch the counterpart card to auto-negotiate, then propose an offer. */
  async proposeOffer(
    cpCardId: string,
    matchId: string,
    amount: number,
    ccy = 'AUD',
  ): Promise<McpResult> {
    await setAutoNegotiate(this.actor.jar, cpCardId, { open: amount, limit: amount, step: 10, ccy });
    return this.mcp('respond', {
      match_id: matchId,
      action: 'propose_offer',
      offer: { amount, ccy, expiry: new Date(Date.now() + 3 * 86_400_000).toISOString() },
    });
  }

  async decline(matchId: string): Promise<McpResult> {
    return this.mcp('respond', { match_id: matchId, action: 'decline' });
  }

  /** Withdraw counterpart cards, archive tracked matches. Best-effort. */
  async teardown(): Promise<{ cardsWithdrawn: number; matchesArchived: number }> {
    return this.h.teardown();
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

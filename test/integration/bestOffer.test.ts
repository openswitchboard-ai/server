/**
 * A WHOLE BEST OFFER, against LIVE dev (14 November 2026).
 *
 * A seller posts a have on best offer with a private floor. Two buyers are
 * introduced and each puts in one sealed number by their own human's press,
 * one of them under the floor. A third buyer is still waiting in line and can
 * put nothing in. The window closes, the seller's assistant reads every number
 * at once with a yes or no for "under the floor" and never the floor itself,
 * the seller is told once that the numbers are ready, and their human accepts
 * one: the other is declined and that buyer is told the seller went with
 * someone else.
 *
 * Along the way, the three refusals that keep it sealed:
 *  - an assistant's number on a best offer takes the consent-link road, even
 *    with Auto-negotiate on (a best offer is always the human's own press);
 *  - a second number from the same buyer is refused (one number each);
 *  - a buyer in line has no introduction yet, so no number at all (M5).
 *
 * THE ONE TEST-ONLY REACH: the window is a day long, so the harness winds the
 * card's own clock back (gather_until) in the dev database and asks the ops
 * queue for an ordinary 'sequencer-tick', the same op the schedule sends. The
 * close itself, the lapses and the seller's notice are all the real sweep's.
 * This is the shape settlement.test.ts uses for its clocks (windClockBack):
 * nothing in the product can shorten the window, and the database write needs
 * the dev deployment's own Data API credentials, which nothing on prod holds.
 *
 * Two other fixture writes, both said where they are made: the buyers' wants
 * are given room for more than one live introduction, so a fixture card left
 * on the shared board by another suite cannot fill their slot first; and the
 * third buyer's two introductions are set to the state a full want leaves
 * them in, whichever order the matcher happened to make them in.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  TestActor,
  bootstrapActor,
  counterFetch,
  dbExec,
  humanOffer,
  mcpCall,
  minimalHave,
  minimalWant,
  poll,
  sendOp,
  setAutoNegotiate,
  waitForCardStates,
} from './helpers.js';

const RUN = process.env.RUN_INTEGRATION === '1';
const d = RUN ? describe : describe.skip;

/** The seller's private floor. Odd on purpose: anything that leaks it shows. */
const FLOOR = 317;
const OVER = 452; // buyer A, over the floor
const UNDER = 263; // buyer B, under it

const form = (o: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});
const expiry = () => new Date(Date.now() + 86_400_000).toISOString();

let seller: TestActor;
let ari: TestActor; // buyer A
let bea: TestActor; // buyer B
let cal: TestActor; // buyer C, in line
let haveId: string;
let blockerId: string;
const wants: Record<string, string> = {};
const intros: Record<string, string> = {};

async function introBetween(want: string, have: string): Promise<string> {
  return poll(async () => {
    const rows = await dbExec(
      'SELECT id::text FROM matches WHERE card_want = :w::uuid AND card_have = :h::uuid',
      [
        { name: 'w', value: want },
        { name: 'h', value: have },
      ],
    );
    return rows[0] ? String(rows[0][0]) : undefined;
  }, 'the introduction to appear');
}

async function isLive(introId: string): Promise<boolean> {
  const [[live]] = await dbExec('SELECT live FROM matches WHERE id = :id::uuid', [
    { name: 'id', value: introId },
  ]);
  return live === true;
}

async function offersOn(introId: string): Promise<{ id: string; amount: number; state: string }[]> {
  const rows = await dbExec(
    `SELECT id::text, amount::text, state FROM offers WHERE match_id = :id::uuid ORDER BY created_at`,
    [{ name: 'id', value: introId }],
  );
  return rows.map(([id, amount, state]) => ({ id: String(id), amount: Number(amount), state: String(state) }));
}

/** The sweep entry carrying the closed window's numbers, if there is one. */
async function bestOffersOnSweep(): Promise<{ raw: string; best: any } | undefined> {
  const r = await mcpCall(seller.accessToken, 'check_in', { intent_id: haveId });
  expect(r.isError, JSON.stringify(r.result)).toBe(false);
  const entry = (r.result.introductions ?? []).find((e: any) => e.best_offers);
  return entry ? { raw: r.raw, best: entry.best_offers } : undefined;
}

d('a whole best offer, sealed numbers to an accepted one', () => {
  beforeAll(async () => {
    [seller, ari, bea, cal] = await Promise.all([
      bootstrapActor('Sally', 'Hobart, Tasmania, Australia'),
      bootstrapActor('Ari', 'Hobart, Tasmania, Australia'),
      bootstrapActor('Bea', 'Hobart, Tasmania, Australia'),
      bootstrapActor('Cal', 'Hobart, Tasmania, Australia'),
    ]);
    const bike = { item: 'mountain bike', condition: 'good' };
    const h = await mcpCall(seller.accessToken, 'publish_intent', {
      listing: minimalHave({ sale: 'best-offer', price: { band: { min: FLOOR }, ccy: 'AUD' }, attributes: bike }),
    });
    expect(h.isError, JSON.stringify(h.result)).toBe(false);
    haveId = h.result.intent_id;
    // Something else for Cal to be talking about, on a shelf none of the
    // three wants is on, so the matcher pairs nobody else with it.
    const b = await mcpCall(seller.accessToken, 'publish_intent', {
      listing: minimalHave({
        category: 'goods.bicycle.road',
        attributes: { item: 'road bike', condition: 'good' },
        ask: { amount: 200, ccy: 'AUD' },
      }),
    });
    expect(b.isError, JSON.stringify(b.result)).toBe(false);
    blockerId = b.result.intent_id;
    for (const [name, actor] of [['ari', ari], ['bea', bea], ['cal', cal]] as const) {
      const w = await mcpCall(actor.accessToken, 'publish_intent', { listing: minimalWant({ attributes: bike }) });
      expect(w.isError, JSON.stringify(w.result)).toBe(false);
      wants[name] = w.result.intent_id;
    }
    await waitForCardStates(seller.accessToken, [haveId, blockerId], ['PUBLISHED']);
    for (const [name, actor] of [['ari', ari], ['bea', bea], ['cal', cal]] as const) {
      await waitForCardStates(actor.accessToken, [wants[name]], ['PUBLISHED']);
    }

    // FIXTURE: room on the two buyers' wants (see the header).
    await dbExec(`UPDATE cards SET slots = 10 WHERE id = ANY(string_to_array(:ids, ',')::uuid[])`, [
      { name: 'ids', value: `${wants.ari},${wants.bea}` },
    ]);

    // Cal first meets the road bike, then the best offer.
    await sendOp({ op: 'create-match', card_want: wants.cal, card_have: blockerId, score: 0.9 });
    const calBlocker = await introBetween(wants.cal, blockerId);
    for (const name of ['ari', 'bea', 'cal'] as const) {
      await sendOp({ op: 'create-match', card_want: wants[name], card_have: haveId, score: 0.9 });
      intros[name] = await introBetween(wants[name], haveId);
    }
    // FIXTURE: Cal's want holds one slot, and it is taken by the road bike.
    await dbExec(`UPDATE matches SET live = true, live_at = now(), last_movement_at = now() WHERE id = :id::uuid`, [
      { name: 'id', value: calBlocker },
    ]);
    await dbExec(`UPDATE matches SET live = false, live_at = NULL WHERE id = :id::uuid`, [
      { name: 'id', value: intros.cal },
    ]);

    // The window opened at the first candidate, and both buyers are live in it.
    const [[open]] = await dbExec(
      `SELECT gather_until > now() AND gather_closed_at IS NULL FROM cards WHERE id = :id::uuid`,
      [{ name: 'id', value: haveId }],
    );
    expect(open).toBe(true);
    await poll(async () => ((await isLive(intros.ari)) && (await isLive(intros.bea)) ? true : undefined), 'both buyers live');
    expect(await isLive(intros.cal)).toBe(false);
  }, 900_000);

  it("an assistant's number takes the consent-link road, even with Auto-negotiate on", async () => {
    await setAutoNegotiate(ari.jar, wants.ari, { limit: 1000 });
    const r = await mcpCall(ari.accessToken, 'respond', {
      intro_id: intros.ari,
      action: 'propose_offer',
      offer: { amount: OVER, ccy: 'AUD', expiry: expiry() },
    });
    expect(r.isError).toBe(false);
    expect(r.result.code).toBe('CONSENT_REQUIRED');
    expect(String(r.result.human_action)).toMatch(/https?:\/\/\S+\/a\/\S+/);
    // Nothing went in: the number is the human's to press.
    expect(await offersOn(intros.ari)).toEqual([]);
  });

  it("each buyer puts in one number by their human's press, one of them under the floor", async () => {
    const a = await humanOffer(ari.jar, intros.ari, { amount: OVER, pin: ari.pin });
    expect(a.status, await a.clone().text()).toBe(200);
    const b = await humanOffer(bea.jar, intros.bea, { amount: UNDER, pin: bea.pin });
    // Under the floor goes in like any other: nothing is refused for being low.
    expect(b.status, await b.clone().text()).toBe(200);
    expect((await offersOn(intros.ari)).map((o) => [o.amount, o.state])).toEqual([[OVER, 'proposed']]);
    expect((await offersOn(intros.bea)).map((o) => [o.amount, o.state])).toEqual([[UNDER, 'proposed']]);
  });

  it('a second number from the same buyer is refused', async () => {
    const again = await humanOffer(ari.jar, intros.ari, { amount: OVER + 50, pin: ari.pin });
    expect(again.status).toBe(409);
    expect(await again.text()).toContain('one number each');
    expect(await offersOn(intros.ari)).toHaveLength(1);
  });

  it('a buyer still in line cannot put a number in, by either road', async () => {
    const page = await humanOffer(cal.jar, intros.cal, { amount: 400, pin: cal.pin });
    expect(page.status).toBe(404);
    const agent = await mcpCall(cal.accessToken, 'respond', {
      intro_id: intros.cal,
      action: 'propose_offer',
      offer: { amount: 400, ccy: 'AUD', expiry: expiry() },
    });
    expect(agent.result.code, JSON.stringify(agent.result)).toBe('NOT_UNLOCKED_YET');
    expect(agent.raw).not.toMatch(new RegExp(`${OVER}|${UNDER}|${FLOOR}`));
    expect(await offersOn(intros.cal)).toEqual([]);
  });

  it('the seller sees nothing while the window is open', async () => {
    expect(await bestOffersOnSweep()).toBeUndefined();
    const listed = await mcpCall(seller.accessToken, 'respond', { intro_id: intros.ari, action: 'list_offers' });
    expect(listed.result.offers).toEqual([]);
  });

  it('the window closes on the sweep, files away whoever put nothing in, and tells the seller once', async () => {
    // TEST-ONLY: the card's own clock, wound back (see the header).
    await dbExec(
      `UPDATE cards SET gather_until = now() - interval '1 second'
        WHERE id = :id::uuid AND gather_closed_at IS NULL`,
      [{ name: 'id', value: haveId }],
    );
    await sendOp({ op: 'sequencer-tick' });
    await poll(async () => {
      const [[closed]] = await dbExec('SELECT gather_closed_at IS NOT NULL FROM cards WHERE id = :id::uuid', [
        { name: 'id', value: haveId },
      ]);
      return closed === true ? true : undefined;
    }, 'the window to close', 180_000);
    // Cal, in line with no number, is filed away the way a lapsed slot is.
    const [[state, via]] = await dbExec('SELECT state, archived_via FROM matches WHERE id = :id::uuid', [
      { name: 'id', value: intros.cal },
    ]);
    expect([state, via]).toEqual(['archived', 'lapsed']);

    // The notice: one row under the window's own key. It is 'sent' to an
    // address that hears by email ('sandbox-rejected' where SES says so on
    // dev), and the one fixed notice with nothing of the numbers in it.
    const key = `best-offer-closed:${haveId}`;
    const sends = await poll(async () => {
      const rows = await dbExec(
        `SELECT status, template, subject, account_id::text FROM email_sends WHERE dedupe_key = :k`,
        [{ name: 'k', value: key }],
      );
      return rows.length && rows[0][0] !== 'sending' ? rows : undefined;
    }, 'the close notice', 180_000);
    expect(sends).toHaveLength(1);
    expect(['sent', 'sandbox-rejected', 'suppressed']).toContain(sends[0][0]);
    expect(sends[0][1]).toBe('best-offer-closed');
    expect(String(sends[0][2])).not.toMatch(/\d/);
    expect(sends[0][3]).toBe(seller.accountId);

    // Another tick changes nothing: still one notice for this seller.
    await sendOp({ op: 'sequencer-tick' });
    await new Promise((r) => setTimeout(r, 20_000));
    const [[n]] = await dbExec(
      `SELECT count(*)::int FROM email_sends WHERE template = 'best-offer-closed' AND account_id = :a::uuid`,
      [{ name: 'a', value: seller.accountId }],
    );
    expect(Number(n)).toBe(1);
  }, 400_000);

  it('the seller reads every number at once, under the floor marked, the floor never said', async () => {
    const read = await bestOffersOnSweep();
    expect(read, 'the closed window on the seller sweep').toBeTruthy();
    const lines = read!.best.offers as any[];
    expect(lines.map((l) => [l.amount, l.under_floor])).toEqual([
      [OVER, false],
      [UNDER, true],
    ]);
    expect(lines.map((l) => l.intro_id).sort()).toEqual([intros.ari, intros.bea].sort());
    // The floor is a yes or no on each line, and never a figure anywhere.
    // Ids are random hex and can hold the floor's digits ("…-8317-…"), so they
    // are taken out first, and the floor is looked for as a number on its own.
    const withoutIds = read!.raw.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '');
    expect(withoutIds).not.toMatch(new RegExp(`(^|[^0-9])${FLOOR}([^0-9]|$)`));
    expect(JSON.stringify(read!.best.note)).not.toMatch(/\d{3}/);
  });

  it('the seller accepts one; the other is declined and told it went elsewhere', async () => {
    const read = await bestOffersOnSweep();
    const pick = (read!.best.offers as any[]).find((l) => l.amount === OVER)!;
    const res = await counterFetch(
      seller.jar,
      '/approve',
      form({ action: 'offer-accept', ref_id: pick.offer_id, decision: 'approve', pin: seller.pin }),
    );
    expect(res.status, (await res.text()).slice(0, 300)).toBe(200);
    expect((await offersOn(intros.ari)).map((o) => o.state)).toEqual(['accepted-by-human']);
    expect((await offersOn(intros.bea)).map((o) => o.state)).toEqual(['declined']);
    const [[state, via]] = await dbExec('SELECT state, archived_via FROM matches WHERE id = :id::uuid', [
      { name: 'id', value: intros.bea },
    ]);
    expect([state, via]).toEqual(['archived', 'not-chosen']);
    const sweep = await mcpCall(bea.accessToken, 'check_in', { intent_id: wants.bea });
    const entry = (sweep.result.introductions ?? []).find((e: any) => e.intro_id === intros.bea);
    expect(entry?.note?.text).toContain('The seller went with someone else');
    expect(sweep.raw).not.toContain(String(OVER));
  });
});

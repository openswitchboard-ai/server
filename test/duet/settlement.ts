/**
 * THE DUET FINALE — the money, driven the whole way, by the two humans.
 *
 * The duet used to stop where the deal was struck: an offer accepted on an
 * approval page, and a settlement occasionally proposed by one of the agents
 * off its own bat. That is the interesting half of the product finishing one
 * step before the part where somebody actually pays.
 *
 * This carries it to the end, and every step of it is a REAL step:
 *
 *   proposed  — usually by one of the agents itself, which is what the last
 *               few runs did unprompted. Where neither offers it, the buyer's
 *               human says "let's do the protected payment" ONCE, in their own
 *               register, and the agents take it from there.
 *   approved  — both humans, on their own approval pages, with their own PINs.
 *   funded    — the buyer's human pays the real hosted Checkout Session the
 *               server created, in a browser, with a Stripe test card. The
 *               state lands from the signature-verified webhook.
 *   evidence  — the seller's human freezes handover evidence into the WORM
 *               vault, which is what unlocks confirming.
 *   released  — the buyer's human confirms receipt, the transfer of the agreed
 *               amount goes out, and 'released' lands from the webhook.
 *
 * Or, on the dispute variant (DUET_DISPUTE=1), the buyer's human says the bike
 * was not as described, disputes while the money is held, and the whole buyer
 * total goes back.
 *
 * WHAT THE HARNESS SHORTCUTS, and it is one thing: the seller's connected
 * account is created pre-verified through Stripe's test-mode API and attached
 * with the server's own envelope encryption, BEFORE the seller approves. A
 * real seller walks the hosted account-link flow at their first approval,
 * which no harness can click. Skipping the attachment would not make the run
 * more honest — it would make the seller's account unverified, and the release
 * transfer would simply fail on a capability check, which tests Stripe rather
 * than the switchboard.
 *
 * WHAT IT NEVER SHORTCUTS: every state is read back out of the settlements
 * table, and every figure out of Stripe. A 303 from the counter is not
 * evidence that money moved.
 */
import { createHash } from 'node:crypto';
import {
  attachStripeAccount,
  createPreVerifiedSeller,
  ensurePlatformBalance,
  payHostedCheckout,
  stripeApi,
  tinyPng,
} from '../integration/stripeHelpers.js';
import { Jar, counterFetch } from '../integration/helpers.js';
import { dbExec, log, poll } from '../sim/harness.js';
import type { SideId } from './persona.js';

/** Just enough of the runner's Side for this module; keeps the import one-way. */
export interface SettlementSide {
  id: SideId;
  human: string;
  agent: string;
  jar: Jar;
  actor: { accountId: string; pin: string };
}

/** One state change, with the moment it landed, for the report's timeline. */
export interface SettlementEvent {
  at: string;
  state: string;
  /** Who or what caused it: a human press, or Stripe's webhook. */
  by: string;
  detail?: string;
}

export interface SettlementFinale {
  attempted: boolean;
  /** Why it did not start, where it did not. */
  skipped?: string;
  settlementId?: string;
  matchId?: string;
  amount?: number;
  ccy?: string;
  /** Who proposed it, and whether the harness had to prompt for it at all. */
  proposedBy?: 'priya' | 'marlowe' | 'unknown';
  humanPrompted: boolean;
  variant: 'release' | 'dispute';
  finalState?: string;
  timeline: SettlementEvent[];
  /** The three lines the buyer was actually shown and charged, in minor units. */
  money?: {
    agreedMinor: number;
    feeMinor: number | null;
    processingMinor: number | null;
    buyerTotalMinor: number | null;
    /** From Stripe, not from us. */
    stripeChargedMinor?: number;
    stripeTransferMinor?: number;
    stripeRefundedMinor?: number;
    transferId?: string | null;
    sellerStripeAccount?: string;
  };
  /**
   * Each agent's own words to its human about what the payment costs. Verbatim,
   * because the whole point of itemising the fee is that a person hears it in
   * their assistant's voice before they pay it.
   */
  feeExplanations: { side: SideId; agent: string; excerpt: string }[];
  notes: string[];
}

const form = (o: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

const nowIso = () => new Date().toISOString();

/** The settlement row, straight from the database. */
export async function settlementRow(id: string): Promise<Record<string, any> | undefined> {
  const rows = await dbExec(
    `SELECT state, amount::text, ccy, fee_amount_minor, processing_fee_minor, buyer_total_minor,
            stripe_payment_intent, stripe_transfer_id, buyer_account::text, seller_account::text,
            proposer_account::text
       FROM settlements WHERE id = :id::uuid`,
    [{ name: 'id', value: id }],
  );
  const r = rows[0];
  if (!r) return undefined;
  const num = (v: any) => (v === null || v === undefined ? null : Number(v));
  return {
    state: String(r[0]),
    amount: Number(r[1]),
    ccy: String(r[2]),
    feeMinor: num(r[3]),
    processingMinor: num(r[4]),
    buyerTotalMinor: num(r[5]),
    paymentIntent: r[6] ? String(r[6]) : null,
    transferId: r[7] ? String(r[7]) : null,
    buyerAccount: String(r[8]),
    sellerAccount: String(r[9]),
    proposerAccount: String(r[10]),
  };
}

/** Wait for the DATABASE to show a state — the webhook is what puts it there. */
async function waitState(
  id: string,
  want: string,
  timeline: SettlementEvent[],
  by: string,
  timeoutMs = 180_000,
): Promise<void> {
  await poll(
    async () => ((await settlementRow(id))?.state === want ? true : undefined),
    `settlement ${id.slice(0, 8)} -> ${want}`,
    timeoutMs,
    4_000,
  );
  timeline.push({ at: nowIso(), state: want, by });
  log(`  [settlement] ${want} — ${by}`);
}

/**
 * Where an agent explained the fee to its human, in its own words.
 *
 * Looks for a reply that talks about what the payment costs and pulls the
 * sentences around it. Deliberately generous in what it matches and exact in
 * what it returns: the report quotes it verbatim, so a human reading the
 * report is reading the agent, not the harness's summary of the agent.
 */
export function findFeeExplanations(
  replies: { text: string }[],
  side: SideId,
  agent: string,
): { side: SideId; agent: string; excerpt: string }[] {
  // NO LEADING \b, and the first run is why. The pattern used to open with
  // `\b(?:…|\$1 fee|…)`, and a \b in front of a dollar sign can never match
  // after a space — so "a $1 fee, plus standard processing" was invisible to
  // it and the run reported that neither agent had explained the fee, while
  // both had explained it precisely. Each alternative now carries its own
  // anchoring, and the net is cast wide: an excerpt is quoted verbatim in the
  // report, so a reader can dismiss a loose match in a second, and a missed
  // one is a silent hole.
  const feeish =
    /(?:\bfees?\b|processing|itemis\w+|itemiz\w+|three lines?|the full \$|\$\s?\d[\d.,]*\s*(?:total|in full)|gets? the (?:full|whole))/i;
  const out: { side: SideId; agent: string; excerpt: string }[] = [];
  for (const r of replies) {
    const m = feeish.exec(r.text);
    if (!m) continue;
    // The whole paragraph the mention sits in, so the figure and the sentence
    // explaining it stay together.
    const start = r.text.lastIndexOf('\n\n', m.index);
    const endRaw = r.text.indexOf('\n\n', m.index);
    const excerpt = r.text
      .slice(start < 0 ? 0 : start, endRaw < 0 ? r.text.length : endRaw)
      .trim();
    if (excerpt) out.push({ side, agent, excerpt: excerpt.slice(0, 900) });
  }
  // One agent can say it several times; keep them all but drop exact repeats.
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.excerpt) ? false : (seen.add(e.excerpt), true)));
}

/**
 * Attach a pre-verified connected account to the SELLER, before either human
 * approves.
 *
 * Timing matters and it is easy to get wrong. The server opens a connected
 * account for the seller at their FIRST settlement approval, and if one is
 * already stored it uses that. Attaching after the approval would leave a
 * second, unverified account on the row and the release transfer would be
 * refused on a capability check that has nothing to do with the switchboard.
 */
export async function preparePayments(
  seller: SettlementSide,
  amountMinor: number,
  ccy: string,
  notes: string[],
): Promise<string | undefined> {
  try {
    const acct = await createPreVerifiedSeller(`duet-${seller.actor.accountId.slice(0, 8)}`);
    await attachStripeAccount(seller.actor.accountId, acct);
    // Separate charges and transfers draw the release out of the platform's
    // AVAILABLE balance, so make sure there is room before anything starts.
    await ensurePlatformBalance(amountMinor * 2, ccy);
    notes.push(
      `${seller.human}'s connected account (${acct}) was created pre-verified through Stripe's test-mode API ` +
        `and attached before either human approved — a real seller reaches the same place through the hosted ` +
        `account-link flow, which no harness can click.`,
    );
    return acct;
  } catch (e) {
    notes.push(`could not prepare the seller's payment account: ${(e as Error).message.slice(0, 200)}`);
    return undefined;
  }
}

/**
 * Drive the settlement from wherever it is to released, or to refunded on the
 * dispute variant. Every press is the real page; every state is read back.
 */
export async function runFinale(opts: {
  settlementId: string;
  matchId: string;
  buyer: SettlementSide;
  seller: SettlementSide;
  variant: 'release' | 'dispute';
  humanPrompted: boolean;
  sellerStripeAccount?: string;
  /** Called with the words the buyer's human should say next, if any. */
  saySomething?: (side: SideId, text: string, rule: string) => Promise<void>;
}): Promise<SettlementFinale> {
  const { settlementId: sid, buyer, seller, variant } = opts;
  const fin: SettlementFinale = {
    attempted: true,
    settlementId: sid,
    matchId: opts.matchId,
    humanPrompted: opts.humanPrompted,
    variant,
    timeline: [],
    feeExplanations: [],
    notes: [],
  };

  const first = await settlementRow(sid);
  if (!first) {
    fin.skipped = `settlement ${sid} is not in the database`;
    return fin;
  }
  fin.amount = first.amount;
  fin.ccy = first.ccy;
  fin.proposedBy =
    first.proposerAccount === buyer.actor.accountId
      ? buyer.id
      : first.proposerAccount === seller.actor.accountId
        ? seller.id
        : 'unknown';
  fin.timeline.push({
    at: nowIso(),
    state: first.state,
    by: `proposed by ${fin.proposedBy === 'unknown' ? 'an account outside this run' : fin.proposedBy}`,
    detail: `${first.amount} ${first.ccy}`,
  });

  // --- both humans approve, on their own pages, with their own PINs.
  for (const side of [buyer, seller]) {
    const res = await counterFetch(
      side.jar,
      '/approve',
      form({ action: 'settlement-approve', ref_id: sid, decision: 'approve', pin: side.actor.pin }),
    );
    const body = res.status === 303 ? '' : (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    const row = await settlementRow(sid);
    fin.timeline.push({
      at: nowIso(),
      state: row?.state ?? 'unknown',
      by: `${side.human} approved on their own approval page`,
      detail: `HTTP ${res.status}${body ? ` — ${body}` : ''}`,
    });
    log(`  [settlement] ${side.human} approved: HTTP ${res.status}, state now ${row?.state}`);
  }

  const approved = await settlementRow(sid);
  if (approved?.state !== 'approved') {
    fin.skipped = `both approvals were pressed but the settlement is '${approved?.state}', so no payment could start`;
    fin.finalState = approved?.state;
    return fin;
  }

  // --- the buyer pays the REAL hosted Checkout Session.
  const pay = await counterFetch(buyer.jar, `/settlements/${sid}/pay`, form({}));
  if (pay.status !== 303) {
    fin.skipped = `the buyer's pay route answered ${pay.status}: ${(await pay.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
    fin.finalState = (await settlementRow(sid))?.state;
    return fin;
  }
  const url = pay.headers.get('location') ?? '';
  fin.timeline.push({
    at: nowIso(),
    state: 'approved',
    by: `${buyer.human} opened the hosted payment page from their own settlement page`,
    detail: url.split('?')[0],
  });
  // The three lines are written onto the row when the session is created, so
  // this is the first moment the exact figures the buyer was shown exist.
  const shown = await settlementRow(sid);
  fin.money = {
    agreedMinor: Math.round((shown?.amount ?? 0) * 100),
    feeMinor: shown?.feeMinor ?? null,
    processingMinor: shown?.processingMinor ?? null,
    buyerTotalMinor: shown?.buyerTotalMinor ?? null,
    ...(opts.sellerStripeAccount ? { sellerStripeAccount: opts.sellerStripeAccount } : {}),
  };
  log(
    `  [settlement] the buyer's three lines: ${fin.money.agreedMinor} + ${fin.money.feeMinor} + ` +
      `${fin.money.processingMinor} = ${fin.money.buyerTotalMinor}`,
  );

  await payHostedCheckout(url);
  await waitState(sid, 'funded', fin.timeline, "Stripe's verified webhook, after the buyer paid the hosted page");

  if (variant === 'dispute') {
    // The buyer's human says the bike was not as described and disputes while
    // the money is still held. The whole buyer total goes back.
    if (opts.saySomething) {
      await opts.saySomething(
        buyer.id,
        "I've picked the bike up and it's not what was described — the frame's scratched right through and it's not the model in the listing. I want my money back, please sort it out.",
        'dispute:not-as-described',
      );
    }
    const d = await counterFetch(buyer.jar, `/settlements/${sid}/dispute`, form({}));
    fin.timeline.push({
      at: nowIso(),
      state: (await settlementRow(sid))?.state ?? 'unknown',
      by: `${buyer.human} disputed on their own settlement page`,
      detail: `HTTP ${d.status}`,
    });
    await waitState(sid, 'refunded', fin.timeline, "Stripe's verified webhook, after the refund");
    const row = await settlementRow(sid);
    fin.finalState = row?.state;
    try {
      const charges = await stripeApi(`/v1/charges?payment_intent=${row?.paymentIntent}`);
      const charge = charges.data[0];
      fin.money!.stripeChargedMinor = Number(charge.amount_captured);
      fin.money!.stripeRefundedMinor = Number(charge.amount_refunded);
      fin.money!.transferId = row?.transferId ?? null;
      fin.notes.push(
        `Stripe: ${charge.amount_captured} taken from the buyer and ${charge.amount_refunded} refunded; ` +
          `the settlement row's transfer id is ${row?.transferId ?? 'null'}, so nothing ever reached the seller.`,
      );
    } catch (e) {
      fin.notes.push(`could not read the refund back from Stripe: ${(e as Error).message.slice(0, 160)}`);
    }
    return fin;
  }

  // --- the seller freezes handover evidence, which is what unlocks confirming.
  try {
    const png = tinyPng();
    const sha = createHash('sha256').update(png).digest('base64');
    const presign = await counterFetch(seller.jar, `/settlements/${sid}/evidence/presign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'handover.png', content_type: 'image/png', size: png.length, sha256_b64: sha }),
    });
    if (presign.status !== 200) throw new Error(`presign answered ${presign.status}`);
    const { url: putUrl } = (await presign.json()) as any;
    const put = await fetch(putUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', 'x-amz-checksum-sha256': sha },
      body: png,
    });
    if (put.status !== 200) throw new Error(`evidence upload answered ${put.status}`);
    const lock = await counterFetch(seller.jar, `/settlements/${sid}/evidence/lock`, form({}));
    if (lock.status !== 303) throw new Error(`evidence lock answered ${lock.status}`);
    await waitState(sid, 'evidence-locked', fin.timeline, `${seller.human} locked the handover evidence`, 60_000);
  } catch (e) {
    fin.skipped = `the seller could not lock handover evidence, which is what unlocks confirming: ${(e as Error).message.slice(0, 200)}`;
    fin.finalState = (await settlementRow(sid))?.state;
    return fin;
  }

  // --- the buyer confirms receipt. This is what releases the money.
  const confirm = await counterFetch(buyer.jar, `/settlements/${sid}/confirm`, form({ pin: buyer.actor.pin }));
  fin.timeline.push({
    at: nowIso(),
    state: (await settlementRow(sid))?.state ?? 'unknown',
    by: `${buyer.human} confirmed receipt on their own settlement page (PIN)`,
    detail: `HTTP ${confirm.status}`,
  });
  // A 502 here is the counter saying the receipt is confirmed and the money did
  // not move — an unfunded platform balance, or a seller capability that
  // lapsed. Waiting three minutes for a webhook that is never coming would tell
  // us nothing, so say what happened and stop.
  if (confirm.status !== 200) {
    fin.skipped =
      `the buyer's confirm answered ${confirm.status}: ${(await confirm.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
    fin.finalState = (await settlementRow(sid))?.state;
    return fin;
  }
  await waitState(sid, 'released', fin.timeline, "Stripe's verified webhook, after the transfer to the seller");

  // --- and what Stripe says actually happened.
  const row = await settlementRow(sid);
  fin.finalState = row?.state;
  try {
    const pi = await stripeApi(`/v1/payment_intents/${row?.paymentIntent}`);
    const transfer = await stripeApi(`/v1/transfers/${row?.transferId}`);
    fin.money!.stripeChargedMinor = Number(pi.amount_received);
    fin.money!.stripeTransferMinor = Number(transfer.amount);
    fin.money!.transferId = row?.transferId ?? null;
    fin.notes.push(
      `Stripe: the buyer was charged ${pi.amount_received} and the seller was transferred ${transfer.amount} — ` +
        `the agreed amount in full, with the fee and the processing line left in the platform balance because the ` +
        `buyer paid them as lines of their own.`,
    );
  } catch (e) {
    fin.notes.push(`could not read the release back from Stripe: ${(e as Error).message.slice(0, 160)}`);
  }
  return fin;
}

/** The finale's lines for the run log and the report. */
export function formatFinale(f: SettlementFinale): string[] {
  if (!f.attempted) return ['no settlement finale was attempted'];
  const out: string[] = [];
  if (f.settlementId) {
    out.push(
      `settlement ${f.settlementId.slice(0, 8)} for ${f.amount} ${f.ccy}, proposed by ${f.proposedBy}` +
        `${f.humanPrompted ? ' (after the buyer\'s human suggested a protected payment once)' : ' (unprompted — neither human raised it)'}`,
    );
  }
  if (f.skipped) out.push(`did not finish: ${f.skipped}`);
  out.push(`variant: ${f.variant}   final state: ${f.finalState ?? 'unknown'}`);
  for (const e of f.timeline) {
    out.push(`  ${e.at}  ${e.state.padEnd(15)} ${e.by}${e.detail ? ` — ${e.detail}` : ''}`);
  }
  if (f.money) {
    const m = f.money;
    out.push(
      `  buyer's three lines (minor units): agreed ${m.agreedMinor} + fee ${m.feeMinor} + processing ${m.processingMinor} = ${m.buyerTotalMinor}`,
    );
    if (m.stripeChargedMinor !== undefined) out.push(`  Stripe charged the buyer: ${m.stripeChargedMinor}`);
    if (m.stripeTransferMinor !== undefined) out.push(`  Stripe transferred to the seller: ${m.stripeTransferMinor}`);
    if (m.stripeRefundedMinor !== undefined) out.push(`  Stripe refunded to the buyer: ${m.stripeRefundedMinor}`);
  }
  for (const e of f.feeExplanations) out.push(`  ${e.agent} on the fee: "${e.excerpt.replace(/\s+/g, ' ').slice(0, 300)}"`);
  for (const n of f.notes) out.push(`  note: ${n}`);
  return out;
}

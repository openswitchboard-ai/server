import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from '../aws.js';
import { getPool } from '../db.js';
import { encryptField } from '../crypto.js';
import { getAccount } from './accounts.js';
import { checkPublishQuota } from './quotas.js';
import {
  OsbError,
  SCHEMA_VERSION,
  checkSchemaVersion,
  validatePayload,
} from '../protocol.js';
import { categoryGate } from '../denylist.js';
import { runIntake } from '../intake/pipe.js';
import { canonicaliseAttributes } from './attributeCanon.js';
import { suggestCategories, suggestionSentence } from './categorySuggest.js';
import { recordCategoryMiss } from './categoryMisses.js';
import { NormalisedGeo, normaliseGeo } from '../geo/normalise.js';
import { rejectionInPlainWords } from './screening.js';
import { categoryPhrase, theirThing } from '../email/templates.js';
import type { Config } from '../config.js';

/**
 * What a publish or an amend answers with. `location_resolved` is the
 * switchboard saying out loud where it put the card and how far it reaches —
 * "Canberra, Australian Capital Territory, Australia — matching within 25 km",
 * or "— reaching all of Australia", or "— reaching anywhere". The agent folds
 * that into what it tells its human, and a card that landed somewhere
 * unintended, or that reaches further than its owner meant, is caught by the
 * one person who would know.
 */
export interface PublishResult {
  intent_id: string;
  state: string;
  location_resolved?: { display: string; radius_km: number };
}

function locationEcho(geo: NormalisedGeo): Pick<PublishResult, 'location_resolved'> {
  return geo.resolved
    ? { location_resolved: { display: geo.resolved.display, radius_km: geo.radius_km } }
    : {};
}

export interface CardRow {
  id: string;
  account_id: string;
  schema_version: string;
  type: 'WANT' | 'HAVE';
  category: string;
  /** The poster's own plain words for the thing, where they gave any. */
  kind: string | null;
  geo: any;
  geo_lat: number | null;
  geo_lon: number | null;
  geo_radius_km: number | null;
  geo_country: string | null;
  attributes: any;
  ask: any;
  urgency: string;
  visibility: string;
  protocol_status: 'active' | 'latent';
  lifecycle_state: string;
  price_enc: Buffer | null;
  ttl_days: number;
  expires_at: Date;
  screening: any;
  /** How many live introductions this can hold at once (domain/sequencer.ts). */
  slots?: number;
  /** Haves only: 'straight' or 'best-offer'. */
  sale?: 'straight' | 'best-offer';
}

/**
 * The category gate, identical on every deployment. The catalogue is a DENY
 * LIST (docs/taxonomy-question.md, denylist.ts categoryGate): a want or a have
 * goes up unless somebody deliberately closed the door on it, which means a
 * reserved family or a top level the taxonomy has no name for. A leaf nobody
 * has written down is not a closed door, so it goes up.
 *
 * What it costs is the word for the thing, and that is what `kind` buys back:
 * an unknown leaf has to say in plain words what it is, or none of the
 * sentences the switchboard writes about it can name it. That refusal is a
 * validation refusal rather than CATEGORY_PROHIBITED, because the category was
 * fine and the posting was short of a field.
 *
 * When it does refuse, the switchboard adds up to three of the closest open
 * categories so the agent can correct itself on the next call. Working those
 * out is a courtesy — it never changes the decision, and a refusal stands
 * whether or not the suggestions arrive.
 *
 * Returns whether the taxonomy knew the leaf, because the caller writes the
 * unknown ones down AFTER the posting is up (recordUnknownLeaf below).
 */
export async function assertCategoryOpen(
  cfg: Config,
  category: string,
  accountId: string,
  kind?: unknown,
): Promise<{ known: boolean }> {
  const gate = categoryGate(category);
  if (!gate.ok) {
    const { categories } = await suggestCategories(cfg, category, 3);
    throw new OsbError('CATEGORY_PROHIBITED', {
      human_action: suggestionSentence(gate.refusal ?? 'unknown', categories),
      ...(categories.length ? { suggestions: categories } : {}),
    });
  }
  if (!gate.known) assertKindPresent(kind);
  return { known: gate.known };
}

/**
 * WHAT THE THING IS, IN THE AGENT'S OWN WORDS. Required on a posting the
 * catalogue has no leaf for, welcome on any other.
 *
 * Two checks stand between `kind` and the row, and they answer to different
 * masters. This one is synchronous and cheap, and it is about SHAPE: a noun
 * phrase is words, and words have no digits, no dollar sign, no address and no
 * link in them. It runs here so an agent that sent prose, a price or a contact
 * detail hears about it in the same call rather than finding the posting
 * rejected minutes later.
 *
 * The other one is the model screen, off the queue, at the posting door of the
 * one pipe, where `kind` is handed over beside the rest of the free text
 * (src/intake, docs/trust-and-safety.md). That is the check that reads what it
 * MEANS. Neither stands in for the other.
 */
const KIND_MAX_WORDS = 6;

export function kindComplaint(kind: unknown): string | undefined {
  if (typeof kind !== 'string') return 'say in a few plain words what the thing is';
  const k = kind.trim();
  if (!k) return 'say in a few plain words what the thing is';
  if (k.length > 60) return 'what the thing is has to fit in sixty characters';
  if (/\d/.test(k)) return 'what the thing is takes plain words rather than numbers';
  if (/[$£€¥]/.test(k)) return 'what the thing is carries no price';
  if (/@|https?:\/\/|www\./i.test(k)) {
    return 'what the thing is carries no email address, phone number or link';
  }
  if (k.split(/\s+/).length > KIND_MAX_WORDS) {
    return `what the thing is takes ${KIND_MAX_WORDS} words at most`;
  }
  return undefined;
}

function assertKindPresent(kind: unknown): void {
  const complaint = kindComplaint(kind);
  if (!complaint) return;
  throw Object.assign(
    new Error(
      `this cannot go up as it stands: the catalogue has no leaf for that category, so ${complaint}`,
    ),
    { validation: ['kind'] },
  );
}

/** `kind` as it is stored: trimmed, or null where the posting gave none. */
const kindOf = (card: any): string | null => {
  const k = typeof card?.kind === 'string' ? card.kind.trim() : '';
  return k ? k : null;
};

/**
 * WHAT THE CATALOGUE IS MISSING, written down once the posting is UP.
 *
 * It used to be written on the refusal, because the refusal was the only place
 * the switchboard ever heard of the gap. Now there is no refusal, so the
 * record moves to the posting itself and changes meaning with it: this is a
 * growth list, not a complaints book. Every row is a person, through their
 * agent, saying "this is the errand I actually have", and the thing went up.
 *
 * Best-effort in the same strong sense it always was: awaited so the row is
 * really there, unable to throw, and invisible to the agent either way.
 */
async function recordUnknownLeaf(
  cfg: Config,
  accountId: string,
  category: string,
  kind: string | null,
): Promise<void> {
  let categories: string[] = [];
  try {
    categories = (await suggestCategories(cfg, category, 3)).categories;
  } catch {
    /* the suggester is a courtesy; the record is the point */
  }
  await recordCategoryMiss(accountId, category, categories, kind);
}

/**
 * How many people this want or have can take at once. The wire bounds it 1-10
 * and the column checks the same, so this is only the default: one, which is
 * what "introduce me to someone" means when nobody has said otherwise.
 */
const slotsOf = (card: any): number => {
  const n = Number(card?.slots);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 1;
};

/** How the asking price works. A want has no asking price, so it is always the
 *  straight one — the schema forbids `sale` there in any case. */
const saleOf = (card: any): 'straight' | 'best-offer' =>
  card?.type === 'offering' && card?.sale === 'best-offer' ? 'best-offer' : 'straight';

/**
 * Publish an intent card.
 * Order of gates: schema validation -> schema_version -> taxonomy/deny-list
 * (CATEGORY_PROHIBITED) -> quota (QUOTA_EXCEEDED) -> stored PENDING_SCREENING
 * with the price band envelope-encrypted -> screening queue. The card is NOT
 * matchable until the screening pipeline passes it.
 */
export async function publishIntent(
  cfg: Config,
  accountId: string,
  card: any,
): Promise<PublishResult> {
  const v = validatePayload('intent-card', card);
  if (!v.valid) {
    // In words, because this sentence has been seen in a chat window: the
    // validator's own account reads like a fault the person at the keyboard
    // caused, and they only said what they were after.
    throw Object.assign(new Error(`this cannot go up as it stands: ${v.plain.join('; ')}`), {
      validation: v.reasons,
    });
  }
  checkSchemaVersion(card.schema_version);

  const { known } = await assertCategoryOpen(cfg, card.category, accountId, card.kind);
  const kind = kindOf(card);
  // Everything a person hands over goes through the one pipe (src/intake,
  // docs/trust-and-safety.md). At the posting door, synchronously, that is the
  // deny-list path check and the figure check over `kind`: the only two things
  // that can refuse here, which is why a category refusal is still
  // CATEGORY_PROHIBITED and still word for word what it was. The rest of the
  // words on the card are screened afterwards, off the queue, by the screening
  // worker through the same pipe — so none are handed over here.
  const intake = await runIntake(cfg, {
    door: 'posting',
    sender_account: accountId,
    fields: { category: card.category, ...(kind ? { kind } : {}) },
  });
  if (intake.outcome === 'refuse') {
    // A figure in `kind` is not a category decision, so it does not wear the
    // category's word. It comes back the way the money check comes back
    // everywhere else: the sentence the check wrote, and the field to fix.
    if (intake.reason_code === 'money-figure-in-words') {
      throw Object.assign(new Error(intake.plain_words ?? 'this cannot go up as it stands'), {
        validation: ['kind'],
      });
    }
    throw new OsbError('CATEGORY_PROHIBITED', { human_action: intake.plain_words });
  }

  // One agreed spelling before the row is written, so two people who meant
  // the same thing embed the same text (domain/attributeCanon.ts). This runs
  // after validation and its output is what is stored, read back, and
  // embedded.
  const attributes = canonicaliseAttributes(card.category, card.attributes ?? {});

  // Location resolution: a named place becomes a centre point and a
  // canonical cell before the card is stored (LOCATION_UNRESOLVED otherwise).
  const geo = normaliseGeo(card.geo);

  await checkPublishQuota(accountId, cfg.quotas);

  const account = await getAccount(accountId);
  if (!account) throw new Error('account not found');

  const ttl = card.ttl_days ?? 60;
  // "Today" means the human's today. With their zone known, a want or have
  // marked today ends at the last second of their day rather than 24 hours
  // after the moment it was posted; without it, the old ttl arithmetic holds.
  let endsAt: Date | null = null;
  if (card.urgency === 'today') {
    const { getTimezone } = await import('./accounts.js');
    const { endOfLocalDay } = await import('./localTime.js');
    const tz = await getTimezone(accountId);
    if (tz) endsAt = endOfLocalDay(new Date(), tz);
  }
  // The price band is a PRIVATE matching input: encrypted before it touches a
  // row, decrypted only inside the matching engine, never serialised outbound.
  const priceEnc = card.price
    ? await encryptField(accountId, account.data_key_enc, JSON.stringify(card.price))
    : null;

  const r = await getPool().query(
    `INSERT INTO cards (account_id, schema_version, type, category, geo, geo_lat, geo_lon,
                        geo_radius_km, geo_country, attributes, ask, urgency, visibility,
                        protocol_status, price_enc, ttl_days, expires_at, slots, sale, kind)
     VALUES ($1,$2,$3,$4,$5,$13,$14,$15,$16,$6,$7,$8,$9,$10,$11,$12::int,
             COALESCE($17::timestamptz, now() + make_interval(days => $12::int)),
             $18::int, $19, $20)
     RETURNING id`,
    [
      accountId,
      card.schema_version,
      // The wire says looking_for/offering; the column keeps WANT/HAVE.
      card.type === 'looking_for' ? 'WANT' : 'HAVE',
      card.category,
      JSON.stringify(geo.geo),
      JSON.stringify(attributes),
      card.ask ? JSON.stringify(card.ask) : null,
      card.urgency ?? 'none',
      'anonymous-until-match',
      card.status ?? 'active',
      priceEnc,
      ttl,
      geo.lat,
      geo.lon,
      geo.radius_km,
      geo.country,
      endsAt,
      // How many people this can take at once, and (on a have) how the asking
      // price works. Both are the human's own word, and both are routing only:
      // see domain/sequencer.ts for the line they drive.
      slotsOf(card),
      saleOf(card),
      kind,
    ],
  );
  const id = r.rows[0].id as string;
  // The catalogue's gaps, counted from what went UP rather than from what was
  // turned away. Nothing about this reaches the agent, and nothing about it can
  // fail the publish.
  if (!known) await recordUnknownLeaf(cfg, accountId, card.category, kind);
  await getPool().query(
    'INSERT INTO publish_events (account_id, card_id) VALUES ($1,$2)',
    [accountId, id],
  );
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: cfg.screeningQueueUrl,
      MessageBody: JSON.stringify({ kind: 'screen-card', card_id: id }),
    }),
  );
  return { intent_id: id, state: 'PENDING_SCREENING', ...locationEcho(geo) };
}

export async function getCard(id: string): Promise<CardRow | undefined> {
  const r = await getPool().query('SELECT * FROM cards WHERE id = $1', [id]);
  return r.rows[0];
}

/**
 * WHO IS THERE, counted once for the whole list.
 *
 * The defect this exists to close (rehearsal, 2026-09-13): a human asked their
 * assistant whether anyone had turned up yet, the assistant read this list,
 * saw the want was published and said no. An introduction had been live on it
 * for thirteen minutes and somebody else was waiting behind that. The list
 * said nothing either way, so the wrong answer was the easy one.
 *
 * One grouped statement for every want and have returned, never one per row:
 * how many people are with each of them right now, and how many are waiting
 * their turn. Only open introductions count — a declined, closed or filed-away
 * one is nobody standing there.
 */
async function peopleOnCards(
  cardIds: string[],
): Promise<Map<string, { here: number; waiting: number }>> {
  const out = new Map<string, { here: number; waiting: number }>();
  if (!cardIds.length) return out;
  const r = await getPool().query(
    `SELECT t.cid,
            count(*) FILTER (WHERE t.live)::int     AS here,
            count(*) FILTER (WHERE NOT t.live)::int AS waiting
       FROM (SELECT unnest(ARRAY[m.card_want, m.card_have]) AS cid, m.live
               FROM matches m
              WHERE m.state = 'open'
                AND (m.card_want = ANY($1::uuid[]) OR m.card_have = ANY($1::uuid[]))) t
      WHERE t.cid = ANY($1::uuid[])
      GROUP BY t.cid`,
    [cardIds],
  );
  for (const row of r.rows as { cid: string; here: number; waiting: number }[]) {
    out.set(row.cid, { here: Number(row.here ?? 0), waiting: Number(row.waiting ?? 0) });
  }
  return out;
}

/** People, counted and conjugated the way a person says it out loud. */
const peopleWord = (n: number, singular: string, plural: string): string =>
  n === 1 ? `One person ${singular}` : `${n} people ${plural}`;

/**
 * The one sentence the agent leads with about something of its human's: who
 * has come forward on it, who is waiting their turn behind them, and where to
 * look next. Plain words only, and the thing is named the way its owner would
 * name it — "your mountain bike" for the person offering it, "the mountain
 * bike you are after" for the person looking, which is the same split every
 * notice uses (email/templates.ts).
 */
function peopleSentence(
  category: string,
  type: 'WANT' | 'HAVE',
  here: number,
  waiting: number,
): string {
  const thing = theirThing(categoryPhrase(category) || 'this', type === 'HAVE' ? 'have' : 'want');
  if (here === 0 && waiting === 0) {
    return `Nothing yet on ${thing}. I'll say the moment somebody comes forward.`;
  }
  if (here === 0) {
    return `${peopleWord(waiting, 'is', 'are')} waiting their turn on ${thing}. Check in for what to do next.`;
  }
  const behind =
    waiting > 0
      ? `, and ${waiting === 1 ? 'one more person is' : `${waiting} more people are`} waiting their turn behind ${here === 1 ? 'them' : 'that'}`
      : '';
  return `${peopleWord(here, 'has', 'have')} come forward about ${thing}${behind}. Check in for what to do next.`;
}

export async function listIntents(accountId: string): Promise<any[]> {
  const r = await getPool().query(
    `SELECT id, schema_version, type, category, kind, geo, attributes, ask, urgency, visibility,
            protocol_status, lifecycle_state, ttl_days, expires_at, created_at, updated_at,
            screening, slots, sale
     FROM cards WHERE account_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [accountId],
  );
  // The expiry as the human would say it, beside the UTC instant, so an agent
  // never has to do the zone sum itself.
  const { getTimezone } = await import('./accounts.js');
  const { localTimeText } = await import('./localTime.js');
  const tz = await getTimezone(accountId);
  // Who is there, for every want and have in one statement (peopleOnCards).
  // Only something still up can have anybody on it, so a withdrawn, expired or
  // screening-rejected one is left alone rather than told "nothing yet".
  const stillUp = r.rows.filter((row) => row.lifecycle_state === 'PUBLISHED');
  const people = await peopleOnCards(stillUp.map((row) => row.id));
  // Own-card view for the owning agent. The private price band is not stored
  // in plaintext and is not echoed back; agents keep their own record of it.
  //
  // A SCREENING_REJECTED card carries WHY, in the same plain words the
  // approval page shows, so the agent can tell its human without a second
  // call. This is an own-card field ONLY: it is read here from the caller's
  // own rows, and no counterparty path ever reads cards.screening (the
  // disclosure payloads are schema-closed — see domain/matches.ts).
  return r.rows.map((row) => {
    const who =
      row.lifecycle_state === 'PUBLISHED'
        ? (people.get(row.id) ?? { here: 0, waiting: 0 })
        : undefined;
    return {
      intent_id: row.id,
      state: row.lifecycle_state,
      // WHO HAS COME FORWARD, and who is behind them. The two counts are for the
      // agent; the sentence is the whole of what its human hears. Anything past
      // the counting of them — whose move it is, a figure, a message — belongs
      // to the sweep and is not here.
      ...(who
        ? {
            people_here: who.here,
            in_line: who.waiting,
            note: {
              text: peopleSentence(row.category, row.type, who.here, who.waiting),
              provenance: 'switchboard-system' as const,
            },
          }
        : {}),
      ...(row.lifecycle_state === 'SCREENING_REJECTED'
        ? (() => {
            const rej = rejectionInPlainWords(row.screening);
            return rej
              ? {
                  screening: {
                    ...(rej.reasonCode ? { reason_code: rej.reasonCode } : {}),
                    reason: rej.plain,
                    ...(rej.at ? { at: rej.at } : {}),
                  },
                }
              : {};
          })()
        : {}),
      listing: {
        schema_version: row.schema_version,
        // The side, in the words the wire uses. WANT/HAVE stay in the column.
        type: row.type === 'WANT' ? 'looking_for' : 'offering',
        category: row.category,
        ...(row.kind ? { kind: row.kind } : {}),
        geo: row.geo,
        ...(row.attributes && Object.keys(row.attributes).length
          ? { attributes: row.attributes }
          : {}),
        ...(row.ask ? { ask: row.ask } : {}),
        urgency: row.urgency,
        visibility: row.visibility,
        status: row.protocol_status,
        ttl_days: row.ttl_days,
        slots: row.slots ?? 1,
        ...(row.type === 'HAVE' ? { sale: row.sale ?? 'straight' } : {}),
      },
      expires_at: row.expires_at,
      ...(tz && row.expires_at ? { expires_local: localTimeText(new Date(row.expires_at), tz) } : {}),
      created_at: row.created_at,
    };
  });
}

function assertOwnUsableCard(card: CardRow | undefined, accountId: string): CardRow {
  if (!card || card.account_id !== accountId) {
    throw Object.assign(new Error('intent not found'), { notFound: true });
  }
  if (card.lifecycle_state === 'EXPIRED') throw new OsbError('INTENT_EXPIRED');
  return card;
}

/** Amend = re-validate + re-screen. Amendable fields only; type/category fixed. */
export async function amendIntent(
  cfg: Config,
  accountId: string,
  intentId: string,
  patch: any,
): Promise<PublishResult> {
  const card = assertOwnUsableCard(await getCard(intentId), accountId);
  if (card.lifecycle_state === 'WITHDRAWN') {
    throw Object.assign(new Error('intent is withdrawn'), { notFound: true });
  }
  const account = await getAccount(accountId);
  if (!account) throw new Error('account not found');

  // Rebuild the full card in the wire's words (the protocol document admits
  // only those), apply the patch, and re-validate as a whole card. Neither
  // type nor visibility is amendable, so nothing translates back on write.
  const current: any = {
    schema_version: card.schema_version,
    type: card.type === 'WANT' ? 'looking_for' : 'offering',
    category: card.category,
    // Not amendable, for the same reason the category is not: what the thing
    // IS is what the posting was, and a different thing is a different posting.
    ...(card.kind ? { kind: card.kind } : {}),
    geo: card.geo,
    ...(card.attributes && Object.keys(card.attributes).length
      ? { attributes: card.attributes }
      : {}),
    ...(card.ask ? { ask: card.ask } : {}),
    urgency: card.urgency,
    visibility:
      card.visibility === 'anonymous-until-match' ? 'anonymous-until-introduced' : card.visibility,
    status: card.protocol_status,
    ttl_days: card.ttl_days,
    slots: card.slots ?? 1,
    ...(card.type === 'HAVE' && card.sale ? { sale: card.sale } : {}),
  };
  const allowed = [
    'geo',
    'attributes',
    'ask',
    'urgency',
    'status',
    'ttl_days',
    'price',
    'slots',
    'sale',
  ];
  for (const k of Object.keys(patch ?? {})) {
    if (!allowed.includes(k)) {
      throw Object.assign(new Error(`field '${k}' cannot be amended`), { validation: [k] });
    }
  }
  // How the asking price works is settled before anyone is introduced. Once a
  // real introduction is live on it, somebody is already acting on the terms
  // they were shown — a buyer about to send one sealed number should not have
  // the rules change under them, and a best offer half-way through is not a
  // thing anyone can reason about. Changing it is refused plainly; taking the
  // want or have down and posting it again is always open to them.
  if ('sale' in (patch ?? {}) && String(patch.sale) !== String(card.sale ?? 'straight')) {
    const live = await getPool().query(
      `SELECT 1 FROM matches
        WHERE (card_want = $1 OR card_have = $1) AND state = 'open' AND live LIMIT 1`,
      [intentId],
    );
    if (live.rowCount) {
      throw new OsbError('NOT_UNLOCKED_YET', {
        human_action:
          'How this one sells can only change before the first person is introduced, and somebody is already talking to your human about it. Take it down and post it again to change that.',
      });
    }
  }
  const next: any = { ...current, ...patch };
  if (next.price === null || next.price === undefined) delete next.price;
  if (next.ask === null || next.ask === undefined) delete next.ask;
  const v = validatePayload('intent-card', next);
  if (!v.valid) {
    throw Object.assign(new Error(`this change cannot be made as it stands: ${v.plain.join('; ')}`), {
      validation: v.reasons,
    });
  }
  // An amend is a re-publish, so the category faces the same gate. A card
  // whose category left the taxonomy since it was posted cannot be renewed
  // under it; the error names where to go instead.
  await assertCategoryOpen(cfg, next.category, accountId, next.kind);
  // Same canonicalisation as publish, on the same terms: an amend is a
  // re-publish, and the re-screen that follows re-embeds from this row, so
  // the amended card's vector is built from the canonical form as well.
  // Canonicalisation is idempotent, so rebuilding `current` from attributes
  // that already went through it changes nothing.
  const attributes = canonicaliseAttributes(next.category, next.attributes ?? {});
  const geo = normaliseGeo(next.geo);

  await checkPublishQuota(accountId, cfg.quotas);

  const priceEnc =
    'price' in (patch ?? {})
      ? patch.price
        ? await encryptField(accountId, account.data_key_enc, JSON.stringify(patch.price))
        : null
      : card.price_enc;

  await getPool().query(
    `UPDATE cards SET geo=$2, geo_lat=$9, geo_lon=$10, geo_radius_km=$11, geo_country=$12,
        attributes=$3, ask=$4, urgency=$5, protocol_status=$6,
        ttl_days=$7::int, expires_at = created_at + make_interval(days => $7::int),
        renewal_notified_at = NULL, slots=$13::int, sale=$14,
        price_enc=$8, lifecycle_state='PENDING_SCREENING', screening=NULL, updated_at=now()
     WHERE id=$1`,
    [
      intentId,
      JSON.stringify(geo.geo),
      JSON.stringify(attributes),
      next.ask ? JSON.stringify(next.ask) : null,
      next.urgency ?? 'none',
      next.status ?? 'active',
      next.ttl_days ?? 60,
      priceEnc,
      geo.lat,
      geo.lon,
      geo.radius_km,
      geo.country,
      slotsOf(next),
      saleOf(next),
    ],
  );
  await getPool().query('INSERT INTO publish_events (account_id, card_id) VALUES ($1,$2)', [
    accountId,
    intentId,
  ]);
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: cfg.screeningQueueUrl,
      MessageBody: JSON.stringify({ kind: 'screen-card', card_id: intentId }),
    }),
  );
  // The echo rides on an amend that moved the card, which is also the call an
  // agent makes when its human says the place is wrong.
  return {
    intent_id: intentId,
    state: 'PENDING_SCREENING',
    ...('geo' in (patch ?? {}) ? locationEcho(geo) : {}),
  };
}

/**
 * Take a want or a have down. The thing is gone — sold, filled, no longer
 * wanted — so nobody new is introduced to it, and every open introduction that
 * never reached a conversation is filed away in the same breath: one must not
 * keep advancing on something the other person can no longer have. A
 * conversation already open is left open: the two people may still be
 * arranging the handover in it, and closing it is a separate act (archive),
 * on the human's word, once they are done.
 */
export async function withdrawIntent(
  accountId: string,
  intentId: string,
  cfg?: Config,
): Promise<{
  intent_id: string;
  state: string;
  introductions_archived: number;
  conversations_kept: number;
}> {
  const card = await getCard(intentId);
  if (!card || card.account_id !== accountId) {
    throw Object.assign(new Error('intent not found'), { notFound: true });
  }
  await getPool().query(
    `UPDATE cards SET lifecycle_state='WITHDRAWN', updated_at=now() WHERE id=$1`,
    [intentId],
  );
  // Dynamic import: matches.ts reads cards, so a static import here would
  // close a cycle between the two modules.
  const { archiveOpenIntroductionsOnCard } = await import('./matches.js');
  const introductions_archived = await archiveOpenIntroductionsOnCard(
    intentId,
    accountId,
    'withdrawn',
    cfg,
  );
  const kept = await getPool().query(
    `SELECT count(*)::int AS n FROM matches
      WHERE (card_want = $1 OR card_have = $1) AND state = 'open'`,
    [intentId],
  );
  const conversations_kept = Number(kept.rows[0]?.n ?? 0);
  return { intent_id: intentId, state: 'WITHDRAWN', introductions_archived, conversations_kept };
}

/** TTL expiry sweep (EventBridge schedule -> ops queue -> here). */
export async function expireDueCards(): Promise<number> {
  const r = await getPool().query(
    `UPDATE cards SET lifecycle_state='EXPIRED', updated_at=now()
     WHERE expires_at < now() AND lifecycle_state IN ('PENDING_SCREENING','PUBLISHED')
     RETURNING id`,
  );
  return r.rowCount ?? 0;
}

void SCHEMA_VERSION;

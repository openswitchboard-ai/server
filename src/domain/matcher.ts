/**
 * The matching engine (0.F). Consumes 'card-published' messages, retrieves
 * candidates by pgvector cosine similarity over opposite-type cards, applies
 * the hard rules (matchRules.ts documents the full rule set and weights),
 * and creates matches / near-misses.
 *
 * Price bands are decrypted HERE and only here, per pair, with a WORM audit
 * line per decrypt operation - and nothing derived from a band ever leaves
 * this module except the boolean outcome folded into score/decision.
 */
import { getPool } from '../db.js';
import { decryptFields } from '../crypto.js';
import { embedCard } from './embeddings.js';
import {
  collectWindowMinutes,
  decide,
  evaluatePair,
  type PriceBand,
} from './matchRules.js';
import type { CardRow } from './cards.js';
import type { Config } from '../config.js';

const CANDIDATE_LIMIT = 50;

interface CandidateRow extends CardRow {
  account_is_business: boolean;
  data_key_enc: Buffer;
  similarity: number;
  threshold_bump: number;
  agent_seen_recently: boolean;
}

async function loadSourceCard(cardId: string): Promise<(CardRow & {
  data_key_enc: Buffer;
  account_is_business: boolean;
  agent_seen_recently: boolean;
  threshold_bump: number;
  embedding_text: string | null;
}) | undefined> {
  const r = await getPool().query(
    `SELECT c.*, c.embedding::text AS embedding_text, a.data_key_enc, a.is_business AS account_is_business,
            COALESCE(rep.threshold_bump, 0) AS threshold_bump,
            EXISTS (SELECT 1 FROM oauth_tokens t
                    WHERE t.account_id = c.account_id AND t.kind IN ('access','api-key')
                      AND NOT t.revoked AND NOT t.suspended AND t.expires_at > now()
                      AND t.last_used_at > now() - interval '1 hour') AS agent_seen_recently
     FROM cards c
     JOIN accounts a ON a.id = c.account_id
     LEFT JOIN reputation rep ON rep.account_id = c.account_id
     WHERE c.id = $1`,
    [cardId],
  );
  return r.rows[0];
}

/**
 * Candidate retrieval: nearest opposite-type PUBLISHED cards by cosine
 * distance. Latent cards ARE candidates ("back pocket" intent surfaces when a
 * real match appears); cards paused by a kill switch are NOT. Muted account
 * pairs are excluded in SQL so a muted counterparty never even reaches
 * scoring. There is exactly ONE ordering input: vector similarity - no
 * account attribute can move a card up this list (no paid ranking).
 */
async function retrieveCandidates(source: {
  id: string;
  account_id: string;
  type: string;
  embedding_text: string;
}): Promise<CandidateRow[]> {
  const opposite = source.type === 'WANT' ? 'HAVE' : 'WANT';
  const r = await getPool().query(
    `SELECT c.*, a.data_key_enc, a.is_business AS account_is_business,
            COALESCE(rep.threshold_bump, 0) AS threshold_bump,
            1 - (c.embedding <=> $1::vector) AS similarity,
            EXISTS (SELECT 1 FROM oauth_tokens t
                    WHERE t.account_id = c.account_id AND t.kind IN ('access','api-key')
                      AND NOT t.revoked AND NOT t.suspended AND t.expires_at > now()
                      AND t.last_used_at > now() - interval '1 hour') AS agent_seen_recently
     FROM cards c
     JOIN accounts a ON a.id = c.account_id
     LEFT JOIN reputation rep ON rep.account_id = c.account_id
     WHERE c.type = $2
       AND c.lifecycle_state = 'PUBLISHED'
       AND c.expires_at > now()
       AND NOT c.paused_by_kill_switch
       AND c.embedding IS NOT NULL
       AND c.account_id <> $3
       AND a.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM match_mutes mm
                       WHERE (mm.account_id = c.account_id AND mm.muted_account = $3)
                          OR (mm.account_id = $3 AND mm.muted_account = c.account_id))
     ORDER BY c.embedding <=> $1::vector
     LIMIT ${CANDIDATE_LIMIT}`,
    [source.embedding_text, opposite, source.account_id],
  );
  return r.rows;
}

async function decryptBand(
  card: { id: string; account_id: string; price_enc: Buffer | null },
  dataKeyEnc: Buffer,
  counterCardId: string,
): Promise<PriceBand | undefined> {
  if (!card.price_enc) return undefined;
  const f = await decryptFields(
    card.account_id,
    dataKeyEnc,
    { price: card.price_enc },
    {
      purpose: 'matching-price-band',
      actor: 'system',
      refs: { card_id: card.id, evaluated_against: counterCardId },
    },
  );
  return JSON.parse(f.price) as PriceBand;
}

/** urgency='today' only matches counterparties fast enough to matter. */
function urgencyRouted(
  a: { urgency: string },
  counterpart: { account_is_business: boolean; agent_seen_recently: boolean },
): boolean {
  if (a.urgency !== 'today') return true;
  return counterpart.account_is_business || counterpart.agent_seen_recently;
}

export interface MatchingOutcome {
  matchesCreated: string[];
  nearMisses: number;
  evaluated: number;
}

export async function runMatchingForCard(
  cfg: Config,
  cardId: string,
  log: (msg: string, extra?: any) => void,
): Promise<MatchingOutcome | undefined> {
  const source = await loadSourceCard(cardId);
  if (!source) {
    log('matcher: card vanished', { card_id: cardId });
    return undefined;
  }
  if (
    source.lifecycle_state !== 'PUBLISHED' ||
    new Date(source.expires_at) < new Date() ||
    (source as any).paused_by_kill_switch
  ) {
    log('matcher: card not matchable', { card_id: cardId, state: source.lifecycle_state });
    return undefined;
  }
  // A published card without an embedding (backfill race) is embedded here -
  // same code path, same projection. If Bedrock fails the message redelivers.
  if (!source.embedding_text) {
    await embedCard(cfg, source);
    const reloaded = await loadSourceCard(cardId);
    if (!reloaded?.embedding_text) throw new Error(`embedding write failed for ${cardId}`);
    source.embedding_text = reloaded.embedding_text;
  }

  const candidates = await retrieveCandidates(source as any);
  const sourceIsWant = source.type === 'WANT';

  // Source band decrypted at most once per run.
  let sourceBand: PriceBand | undefined | 'unloaded' = 'unloaded';

  const outcome: MatchingOutcome = { matchesCreated: [], nearMisses: 0, evaluated: 0 };
  const touchedCards = new Set<string>();

  for (const cand of candidates) {
    outcome.evaluated++;
    // Cheap hard rules first; price bands are only decrypted for survivors.
    if (!urgencyRouted(source, cand) || !urgencyRouted(cand, source)) continue;

    const want = sourceIsWant ? source : cand;
    const have = sourceIsWant ? cand : source;

    const pre = evaluatePair({
      semantic: Number(cand.similarity),
      categoryA: source.category,
      categoryB: cand.category,
      geoA: source.geo,
      geoB: cand.geo,
      // bands withheld: category/geo hard rules run without any decrypt
    });
    if (!pre.hardRulesPass) continue;

    if (sourceBand === 'unloaded') {
      sourceBand = await decryptBand(source, source.data_key_enc, cand.id);
    }
    const candBand = await decryptBand(cand, cand.data_key_enc, source.id);
    const wantBand = sourceIsWant ? (sourceBand as PriceBand | undefined) : candBand;
    const haveBand = sourceIsWant ? candBand : (sourceBand as PriceBand | undefined);

    const evaled = evaluatePair({
      semantic: Number(cand.similarity),
      categoryA: source.category,
      categoryB: cand.category,
      geoA: source.geo,
      geoB: cand.geo,
      wantBand,
      haveBand,
    });
    if (!evaled.hardRulesPass) continue;

    const bumpWant = Number(sourceIsWant ? source.threshold_bump : cand.threshold_bump);
    const bumpHave = Number(sourceIsWant ? cand.threshold_bump : source.threshold_bump);
    const decision = decide(evaled.score, bumpWant, bumpHave);

    if (decision === 'match') {
      const ins = await getPool().query(
        `INSERT INTO matches (card_want, card_have, account_want, account_have, score, category)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (card_want, card_have) DO NOTHING
         RETURNING id`,
        [want.id, have.id, want.account_id, have.account_id, evaled.score, want.category],
      );
      if (ins.rows[0]) {
        outcome.matchesCreated.push(ins.rows[0].id as string);
        touchedCards.add(want.id);
        touchedCards.add(have.id);
        log('matcher: match created', {
          match_id: ins.rows[0].id,
          score: Number(evaled.score.toFixed(4)),
          category: want.category,
        });
      }
    } else if (decision === 'near-miss') {
      await getPool().query(
        `INSERT INTO near_misses (card_want, card_have, score, category)
         VALUES ($1,$2,$3,$4) ON CONFLICT (card_want, card_have) DO NOTHING`,
        [want.id, have.id, evaled.score, want.category],
      );
      outcome.nearMisses++;
    }
  }

  if (touchedCards.size) await stampContestedWindows([...touchedCards]);
  return outcome;
}

/**
 * Contested matches -> collection window. A card that now has >= 2
 * concurrently-open matches becomes the CONTESTED (holder) side: its
 * collection window opens once (collect_until stamped) and never reopens
 * after it closes. Window length: 15 min for urgency='today', else 6h,
 * further shortened by the card's own collect_window_minutes override.
 * The stamp is a single conditional UPDATE, so concurrent workers cannot
 * double-open or re-open a window.
 */
export async function stampContestedWindows(cardIds: string[]): Promise<void> {
  await getPool().query(
    `UPDATE cards c SET
        collect_until = now() + make_interval(mins => LEAST(
          COALESCE(c.collect_window_minutes, 100000),
          CASE WHEN c.urgency = 'today' THEN 15 ELSE 360 END)),
        updated_at = now()
     WHERE c.id = ANY($1::uuid[])
       AND c.collect_until IS NULL
       AND c.collect_closed_at IS NULL
       AND (SELECT count(*) FROM matches m
            WHERE (m.card_want = c.id OR m.card_have = c.id) AND m.state = 'open') >= 2`,
    [cardIds],
  );
}

// Re-export so the window constants live in one place for callers.
export { collectWindowMinutes };

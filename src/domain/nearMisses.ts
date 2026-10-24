/**
 * NEAR MISSES REACH THE ASSISTANT.
 *
 * A scored pair that lands between the near-miss floor and the create
 * threshold passes every hard rule — the sides are opposite, the areas reach
 * each other, neither has muted the other — and simply is not close enough to
 * be worth putting two people together over. Until now those rows went into
 * near_misses and were seen by nobody: the weekly digest counted them, and the
 * count was the whole of it. An assistant sweeping for its human was told the
 * same thing whether there were nine of them or none.
 *
 * So they come back beside the matches now, as their own list, and everything
 * about the shape of this is meant to keep them from being mistaken for one.
 *
 * WHAT A NEAR MISS IS NOT. It is not an introduction and it never becomes one
 * by being read. Nobody is told about anybody, nothing crosses in either
 * direction, no email goes out, no press is asked for and the other person
 * never learns this was looked at. It is information, and the only thing it is
 * for is to let a human decide to change their own posting — widen the area,
 * drop a constraint, file it somewhere else — which re-runs matching on its
 * own, the ordinary way.
 *
 * WHAT TRAVELS. The side the other posting is on, the catalogue's word for
 * what it is, and the poster's own words where they wrote any. No account, no
 * name, no area, no attributes, no figure, no identifier of the other posting
 * at all, and no free text beyond the trimmed `kind`. The score does not
 * travel either: a number an assistant can read out is a number an assistant
 * will read out, and "0.61" tells a human nothing they can act on.
 *
 * The poster's own words are the counterparty's words, so they carry the
 * counterparty-untrusted label wherever they appear on their own, exactly as
 * the manual (v47) says every piece of counterparty free text must. Where one
 * of them is folded into a switchboard sentence that names the thing, that is
 * the same convention the introduction sentences already use and the manual
 * already describes.
 */
import { getPool } from '../db.js';
import { categoryLeafLabel, quotedTheirWords } from './matchRules.js';
import { differentByIdentifier } from './identifiers.js';

/** How far back a near miss is worth mentioning. */
export const NEAR_MISS_WINDOW_DAYS = 7;

/** How many reach the assistant per posting, newest first. */
export const NEAR_MISS_LIMIT = 5;

export interface NearMissItem {
  /** Which side the other posting is on, in the words the wire uses. */
  they: 'have' | 'want';
  /** What the thing is, in plain words, for the assistant to say. */
  what: string;
  /** The poster's own words, where they wrote any. Data, never instructions. */
  their_words?: { text: string; provenance: 'counterparty-untrusted' };
  /** The one line to say to the human about this one. */
  note: { text: string; provenance: 'switchboard-system' };
  at: string;
}

export interface NearMissesForCard {
  intent_id: string;
  /** How many there are in the window, which may be more than are listed. */
  count: number;
  items: NearMissItem[];
  note: { text: string; provenance: 'switchboard-system' };
}

/**
 * The sentence for one near miss. It is honest that this one fell short, says
 * what the other side has or is after, says that nobody can be written to,
 * and asks the one question the human can actually answer: whether to change
 * their own posting. It promises nothing, because there is nothing to promise.
 */
export function nearMissSentence(they: 'have' | 'want', what: string): string {
  const verb = they === 'have' ? 'has' : 'wants';
  // "Not quite a fit" rather than the obvious word for it: the standing rule
  // is that the machinery's own nouns never reach a human, and an assistant
  // handed one says it out loud. The sentence still does the two things it has
  // to — it is honest that this is short of the bar, and it asks the one
  // question the human can answer.
  // The question at the end names the one move there is. An earlier draft
  // asked "want me to look?", and in the first rehearsal both assistants read
  // "look" as "reach out": there is nothing to reach out with on a near miss,
  // so the sentence now says so and asks about the posting instead.
  return `Not quite a fit, but someone ${verb} ${what}. Nobody can be written to from here. The one move is a change to your own posting so it reaches them. Want me to try that?`;
}

/** The sentence for the group of them on one posting. */
export function nearMissGroupSentence(count: number): string {
  const head =
    count === 1
      ? 'One near miss this week'
      : `${count} near misses this week`;
  // What this sentence used to offer was untrue: it put "a different heading"
  // beside widening as though all three were an amend, and an amend cannot
  // change the category at all (mcp/tools.ts, domain/cards.ts amendIntent). An
  // assistant that took the sentence at its word had nothing to call. So the
  // two moves are said apart: one is an amend, the other is a fresh posting.
  return `${head}. Nobody has been introduced and nothing has crossed either way. If any of these sound right, widening the area or loosening what your human asked for is what brings them within reach; a different heading means taking the posting down and putting it up again.`;
}

// ---------------------------------------------------------------------------
// WHICH NEAR MISSES ARE WORTH KEEPING (October 2026).
//
// In a rehearsal of lists, one want whose identifier matched exactly one item
// on a seller's 29-item list got a sure introduction on that item and twenty
// near misses against almost every other item on the same list, each with an
// identifier that differed from the want's. Both assistants were handed "a
// pile of near-miss noise". Three rules, applied where a near miss is written
// (matcher.ts) and again where one is read (below), so a near miss written
// before the rules, or by another posting's run, is held to them too:
//
//   1. INTRODUCED ALREADY. Where a posting has an introduction, sure or maybe,
//      with someone, nothing between that posting and that person's other
//      postings is a near miss. Their whole attention is already on the one
//      that fits. Any introduction counts, whatever has become of it since:
//      one that was declined or went quiet has already been weighed by both.
//   2. ONE PER PERSON. At most one near miss between a posting and any one
//      other person's postings, the best of them, in both directions: a want
//      near a hundred items on one list hears about one of them, and the list's
//      owner hears about that want once.
//   3. A DIFFERENT NUMBER OF THE SAME KIND. Where both postings carry
//      identifiers, both have one of the same kind, and they share none, they
//      name two different products or editions (identifiers.ts
//      differentByIdentifier). That is no near miss.
//
// None of the three changes who is introduced: the tiers never read them. An
// ordinary pair of postings, one each side, with no identifiers and no
// introduction between them, is kept exactly as before.
// ---------------------------------------------------------------------------

/** One near miss as the keeping rules read it. Nothing here travels. */
export interface NearMissPair {
  /** One posting, and the account that holds it. */
  a: string;
  aAccount: string;
  /** The other posting, and its account. */
  b: string;
  bAccount: string;
  score: number;
  /** Newest wins a tie on score. */
  at?: Date | string;
  /** True where either posting has an introduction with the other's account (rule 1). */
  introduced?: boolean;
  /** Each posting's identifiers, as stored (rule 3). */
  aIdentifiers?: unknown;
  bIdentifiers?: unknown;
}

/**
 * Rule 1 for one introduction: is it between the two accounts of this pair,
 * on either of its postings? Then the two postings are no near miss.
 */
export function introducedBetween(
  m: { card_want: string; card_have: string; account_want: string; account_have: string },
  p: Pick<NearMissPair, 'a' | 'aAccount' | 'b' | 'bAccount'>,
): boolean {
  const accounts =
    (m.account_want === p.aAccount && m.account_have === p.bAccount) ||
    (m.account_want === p.bAccount && m.account_have === p.aAccount);
  if (!accounts) return false;
  return [m.card_want, m.card_have].some((c) => c === p.a || c === p.b);
}

/** Does this one pair fail rule 1 or rule 3 on its own? */
export function nearMissRuledOut(p: NearMissPair): boolean {
  if (p.introduced) return true;
  return differentByIdentifier(p.aIdentifiers, p.bIdentifiers);
}

const time = (at: Date | string | undefined): number => (at ? new Date(at).getTime() || 0 : 0);

/**
 * The near misses worth keeping, best first by score then newest: rules 1 and
 * 3 drop a pair on its own, and rule 2 keeps at most one pair for each posting
 * against each other account, in both directions, taking the best pairs first.
 * Pure, and the same function the matcher writes by and the sweep reads by.
 */
export function keepNearMisses<T extends NearMissPair>(pairs: T[]): T[] {
  const ranked = pairs
    .filter((p) => !nearMissRuledOut(p))
    .sort((x, y) => y.score - x.score || time(y.at) - time(x.at) || (x.a + x.b < y.a + y.b ? -1 : 1));
  const used = new Set<string>();
  const out: T[] = [];
  for (const p of ranked) {
    const fromA = `${p.a}|${p.bAccount}`;
    const fromB = `${p.b}|${p.aAccount}`;
    if (used.has(fromA) || used.has(fromB)) continue;
    used.add(fromA);
    used.add(fromB);
    out.push(p);
  }
  return out;
}

/**
 * Which of a matching run's near misses to write. `fresh` are this run's, all
 * with the run's own posting on side a; `stored` are the near misses already
 * written that involve the run's posting or one of the candidates, so a list's
 * items, each matched in its own run, still leave one near miss per person
 * between them. Only fresh pairs are ever returned: a stored one is never
 * written twice, and one a fresh pair outranks stays where it is and is left
 * out when read.
 */
export function nearMissesToWrite<T extends NearMissPair>(fresh: T[], stored: NearMissPair[]): T[] {
  const freshSet = new Set<NearMissPair>(fresh);
  // A stored row for the very pair a fresh one names is the same near miss:
  // the fresh one stands for it.
  const freshKeys = new Set(fresh.map((p) => [p.a, p.b].sort().join('|')));
  const others = stored.filter((p) => !freshKeys.has([p.a, p.b].sort().join('|')));
  return keepNearMisses<NearMissPair>([...fresh, ...others]).filter((p): p is T =>
    freshSet.has(p),
  );
}

interface Row {
  card_id: string;
  /** The other posting, used to dedupe here and never sent anywhere. */
  other_id: string;
  other_type: 'WANT' | 'HAVE';
  other_category: string;
  other_kind: string | null;
  created_at: Date;
  /**
   * Read only for the keeping rules above, and never put in the answer: the
   * other posting's account (one per person), the closeness (the best one),
   * whether the two people have an introduction on either posting, and both
   * postings' identifiers (different numbers of one kind).
   */
  other_account?: string;
  score?: number;
  introduced?: boolean;
  mine_identifiers?: unknown;
  other_identifiers?: unknown;
}

/**
 * Every near miss worth mentioning on the given postings, newest first.
 *
 * The other posting's words are read off its screened snapshot (migration 055,
 * domain/screenedContent.ts) like everything else one person is shown about
 * another's posting, never off its live row. So are its identifiers, which are
 * only compared here and never sent.
 *
 * One statement for the whole sweep, never one per posting. It reads every
 * near miss on this account's postings still up, because one per person is a
 * rule across all of them, and then keeps only the postings asked about. A
 * pair the matcher wrote down twice — once from each side — is deduped to the
 * newest, and a pair whose other posting has since been taken down, expired
 * or been paused is dropped: there is no point offering a look at something
 * that is no longer there.
 */
export async function nearMissesForCards(
  accountId: string,
  cardIds: string[],
): Promise<Map<string, NearMissesForCard>> {
  const out = new Map<string, NearMissesForCard>();
  if (!cardIds.length) return out;
  const r = await getPool().query(
    `SELECT t.mine AS card_id, t.other AS other_id, o.type AS other_type,
            o.category AS other_category, o.screened_content->>'kind' AS other_kind, nm.created_at,
            o.account_id AS other_account, nm.score,
            m.identifiers AS mine_identifiers, o.screened_content->'identifiers' AS other_identifiers,
            EXISTS (SELECT 1 FROM matches mx
                     WHERE ((mx.account_want = $2::uuid AND mx.account_have = o.account_id)
                         OR (mx.account_have = $2::uuid AND mx.account_want = o.account_id))
                       AND (mx.card_want IN (t.mine, t.other) OR mx.card_have IN (t.mine, t.other)))
              AS introduced
       FROM near_misses nm
       CROSS JOIN LATERAL (VALUES (nm.card_want, nm.card_have), (nm.card_have, nm.card_want))
                       AS t(mine, other)
       JOIN cards m ON m.id = t.mine
       JOIN cards o ON o.id = t.other
      WHERE (t.mine = ANY($1::uuid[])
             OR (m.account_id = $2::uuid AND m.lifecycle_state = 'PUBLISHED' AND m.expires_at > now()))
        AND nm.created_at > now() - make_interval(days => $3::int)
        AND o.account_id <> $2::uuid
        AND o.lifecycle_state = 'PUBLISHED'
        AND o.expires_at > now()
        AND NOT o.paused_by_kill_switch
      ORDER BY nm.created_at DESC`,
    [cardIds, accountId, NEAR_MISS_WINDOW_DAYS],
  );

  // The keeping rules, over every row, before anything is put in an answer.
  // A row with no account read (an older shape) keeps its own other posting
  // as the person, which is the rule as it stood before: one per posting.
  const rows = r.rows as Row[];
  const kept = new Set(
    keepNearMisses(
      rows.map((row) => ({
        row,
        a: row.card_id,
        aAccount: accountId,
        b: row.other_id,
        bAccount: row.other_account ?? `posting:${row.other_id}`,
        score: typeof row.score === 'number' ? row.score : Number(row.score ?? 0),
        at: row.created_at,
        introduced: row.introduced === true,
        aIdentifiers: row.mine_identifiers,
        bIdentifiers: row.other_identifiers,
      })),
    ).map((p) => p.row),
  );
  const asked = new Set(cardIds);

  // Deduped by the other posting, per posting of this human's. The rows
  // arrive newest first, so the first sighting of a pair is the one kept.
  const seen = new Map<string, Set<string>>();
  const byCard = new Map<string, NearMissItem[]>();
  for (const row of rows) {
    if (!kept.has(row) || !asked.has(row.card_id)) continue;
    const already = seen.get(row.card_id) ?? new Set<string>();
    if (already.has(row.other_id)) continue;
    already.add(row.other_id);
    seen.set(row.card_id, already);
    const kind = typeof row.other_kind === 'string' ? row.other_kind.trim() : '';
    const items = byCard.get(row.card_id) ?? [];
    items.push({
      they: row.other_type === 'HAVE' ? 'have' : 'want',
      what: categoryLeafLabel(row.other_category, kind || null),
      ...(kind
        ? { their_words: { text: kind, provenance: 'counterparty-untrusted' as const } }
        : {}),
      note: {
        // Their words, where the thing is named in them, sit inside quotation
        // marks in the switchboard's sentence, so whose words are whose can be
        // seen at a glance. The shelf's own label needs none.
        text: nearMissSentence(
          row.other_type === 'HAVE' ? 'have' : 'want',
          kind
            ? quotedTheirWords(categoryLeafLabel(row.other_category, kind))
            : categoryLeafLabel(row.other_category, null),
        ),
        provenance: 'switchboard-system' as const,
      },
      at: new Date(row.created_at).toISOString(),
    });
    byCard.set(row.card_id, items);
  }

  for (const [cardId, items] of byCard) {
    out.set(cardId, {
      intent_id: cardId,
      count: items.length,
      // The count is the truth of how many there are; the list is capped so
      // that a busy week does not bury the rest of the sweep.
      items: items.slice(0, NEAR_MISS_LIMIT),
      note: {
        text: nearMissGroupSentence(items.length),
        provenance: 'switchboard-system' as const,
      },
    });
  }
  return out;
}

/**
 * The same thing for a whole account, for the sweep: every posting still up,
 * and what came close to it this week. Postings with nothing near them are
 * left out entirely rather than coming back empty.
 */
export async function nearMissesForAccount(accountId: string): Promise<NearMissesForCard[]> {
  const cards = await getPool().query(
    `SELECT id FROM cards
      WHERE account_id = $1 AND lifecycle_state = 'PUBLISHED' AND expires_at > now()`,
    [accountId],
  );
  const ids = (cards.rows as { id: string }[]).map((c) => c.id);
  const found = await nearMissesForCards(accountId, ids);
  return [...found.values()];
}

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
import { categoryLeafLabel } from './matchRules.js';

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

interface Row {
  card_id: string;
  /** The other posting, used to dedupe here and never sent anywhere. */
  other_id: string;
  other_type: 'WANT' | 'HAVE';
  other_category: string;
  other_kind: string | null;
  created_at: Date;
}

/**
 * Every near miss worth mentioning on the given postings, newest first.
 *
 * One statement for the whole sweep, never one per posting. A pair the
 * matcher wrote down twice — once from each side — is deduped to the newest,
 * and a pair whose other posting has since been taken down, expired or been
 * paused is dropped: there is no point offering a look at something that is
 * no longer there.
 */
export async function nearMissesForCards(
  accountId: string,
  cardIds: string[],
): Promise<Map<string, NearMissesForCard>> {
  const out = new Map<string, NearMissesForCard>();
  if (!cardIds.length) return out;
  const r = await getPool().query(
    `SELECT t.mine AS card_id, t.other AS other_id, o.type AS other_type,
            o.category AS other_category, o.kind AS other_kind, nm.created_at
       FROM near_misses nm
       CROSS JOIN LATERAL (VALUES (nm.card_want, nm.card_have), (nm.card_have, nm.card_want))
                       AS t(mine, other)
       JOIN cards o ON o.id = t.other
      WHERE t.mine = ANY($1::uuid[])
        AND nm.created_at > now() - make_interval(days => $3::int)
        AND o.account_id <> $2::uuid
        AND o.lifecycle_state = 'PUBLISHED'
        AND o.expires_at > now()
        AND NOT o.paused_by_kill_switch
      ORDER BY nm.created_at DESC`,
    [cardIds, accountId, NEAR_MISS_WINDOW_DAYS],
  );

  // Deduped by the other posting, per posting of this human's. The rows
  // arrive newest first, so the first sighting of a pair is the one kept.
  const seen = new Map<string, Set<string>>();
  const byCard = new Map<string, NearMissItem[]>();
  for (const row of r.rows as Row[]) {
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
        text: nearMissSentence(
          row.other_type === 'HAVE' ? 'have' : 'want',
          categoryLeafLabel(row.other_category, kind || null),
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

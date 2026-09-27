/**
 * THE LEAN SWEEP: the same check_in, with what it repeated taken out.
 *
 * On 27 September 2026 a small local model (a 27B in LM Studio) took up to
 * three minutes to read one sweep, and most of what it was reading was the
 * same thing twice: every nested block carried its own schema_version, kind
 * and intro_id; a maybe's sentence rode on the entry and again inside the
 * details; a figure's note rode on `offer` and again as `offer_message`; an
 * introduction the other side had taken down weeks ago, with nothing on the
 * table and nobody writing, came back with every detail of their thing on
 * every call; and the whole answer was pretty-printed, which is indentation a
 * model reads token by token.
 *
 * WHAT THIS NEVER DOES: change the words of a sentence, or take away a field
 * that agent-facing text names. The check_in description promises that every
 * field which changes what an agent should say has a sentence beside it
 * (`note`, `offer_note`, `taken_down_note`, `hears_via_note`,
 * `runs_on_its_own_note`, `time_note`, `area_note`, `arrangement_note`), so
 * each of those keeps its own sentence even where it says what `note` says.
 * The account-level notes ride every sweep as they always have: one token is
 * shared by contexts that never see each other's transcripts (see
 * manualUpdateFor in mcp/tools.ts), so "already told" is not a thing the
 * switchboard can know.
 *
 * Behind `cfg.leanSweep` (LEAN_SWEEP; on in dev, off in prod by default) so
 * the rehearsal ladder can run it before it reaches anyone real.
 */
import { getPool } from '../db.js';

/** How long an introduction has to have been quiet before the sweep carries
 *  it without the other side's details. The go-ahead window is seven days by
 *  default (conversationWindow.ts); this matches it. */
export const LEAN_SWEEP_QUIET_DAYS = 7;

/** The envelope a nested block repeats from the entry around it. */
const ENVELOPE = ['schema_version', 'kind', 'intro_id'] as const;

function withoutEnvelope(block: unknown, introId: unknown): unknown {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return block;
  const b = block as Record<string, unknown>;
  // Only a block that is the same introduction's is trimmed: a nested block
  // naming some other id is not a repeat of anything.
  if (b.intro_id !== undefined && b.intro_id !== introId) return block;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if ((ENVELOPE as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out;
}

const sameNote = (a: unknown, b: unknown): boolean =>
  !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

/**
 * One entry, without the repeats inside it. Pure, and it never touches a
 * sentence: every text that leaves here is a text that arrived, and every one
 * that is dropped is an exact copy of one that stays in the same entry.
 */
export function leanEntry(entry: any): any {
  if (!entry || typeof entry !== 'object') return entry;
  const e: any = { ...entry };
  for (const k of ['signal', 'attributes', 'mutual'] as const) {
    if (e[k] !== undefined) e[k] = withoutEnvelope(e[k], e.intro_id);
  }
  // A maybe's sentence rides on the entry as `possible_note`, which is the
  // field the manual names. The copy inside the details' notes is the same
  // object said a second time; the other notes there (whose words the
  // attributes are, the other side's own words, which specifics agree) stay.
  if (e.possible_note && Array.isArray(e.attributes?.notes)) {
    const notes = (e.attributes.notes as unknown[]).filter((n) => !sameNote(n, e.possible_note));
    if (notes.length !== e.attributes.notes.length) e.attributes = { ...e.attributes, notes };
  }
  // The other side's words with their figure ride as `offer_message` (the
  // field the manual names) and on each line of `offers`. `offer` repeated
  // them a third time; its amount and currency stay.
  if (e.offer && typeof e.offer === 'object' && sameNote(e.offer.message, e.offer_message)) {
    const { message: _m, ...rest } = e.offer;
    e.offer = rest;
  }
  return e;
}

/** Offer states that are still somebody's to answer. */
const LIVE_OFFER = new Set(['proposed', 'awaiting-human']);

/**
 * Could this introduction be carried without the other side's details, on
 * what the entry itself says? Everything that could need this human is a
 * reason to say no: a message waiting, a figure still open from either side,
 * a payment, a names step blocked, a line, a price note, a best-offer result.
 * Only the other side having taken theirs down qualifies — the human's own
 * taken-down thing is theirs to finish — and only once the two are talking,
 * which is the only place taken_down is set.
 */
export function compactCandidate(e: any): boolean {
  if (!e || e.state !== 'open' || e.taken_down !== 'theirs') return false;
  if (e.next !== 'ready_to_talk' && e.next !== 'deal_agreed') return false;
  if (!e.conversation || e.conversation.messages_waiting !== 0) return false;
  if (e.offer || e.settlement || e.mutual_blocked || e.line || e.price_note || e.best_offers) return false;
  if (Array.isArray(e.offers) && e.offers.some((l: any) => LIVE_OFFER.has(l?.state))) return false;
  return true;
}

/**
 * The compact form: the entry without the other side's details (`attributes`)
 * and the first look (`signal`). Everything else stays — intro_id, state,
 * next, note, taken_down and its sentence, the conversation, the figures and
 * their sentence, the names, what_to_do — so every field agent-facing text
 * names is still there with its sentence. The details are one call away, on
 * check_in with this intro_id.
 */
export function compactEntry(e: any): any {
  const { signal: _s, attributes: _a, ...rest } = e;
  return rest;
}

/**
 * When each candidate last moved: the other side taking theirs down, a
 * go-ahead window starting or restarting, any figure in any state, any message
 * still held, the conversation opening. One read for the whole sweep, and a
 * failed read compacts nothing.
 */
export async function lastActivity(introIds: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (!introIds.length) return out;
  try {
    const r = await getPool().query(
      `SELECT m.id,
              GREATEST(
                m.opened_at,
                (SELECT max(c.updated_at) FROM cards c
                  WHERE c.id IN (m.card_want, m.card_have)),
                (SELECT max(w.started_at) FROM conversation_windows w WHERE w.match_id = m.id),
                (SELECT max(o.created_at) FROM offers o WHERE o.match_id = m.id),
                (SELECT max(cm.created_at) FROM channel_messages cm WHERE cm.match_id = m.id)
              ) AS last_activity
         FROM matches m
        WHERE m.id = ANY($1::uuid[])`,
      [introIds],
    );
    for (const row of r.rows as { id: string; last_activity: Date | string | null }[]) {
      if (row.last_activity) out.set(row.id, new Date(row.last_activity));
    }
  } catch {
    return new Map();
  }
  return out;
}

/**
 * The whole sweep, lean. `full` is true when the agent asked for one
 * introduction by id: that one comes back with everything, because asking
 * for it is exactly how the details of a compacted one are fetched.
 */
export async function leanSweep(
  entries: any[],
  opts: { full?: boolean; now?: Date } = {},
): Promise<any[]> {
  const lean = entries.map(leanEntry);
  if (opts.full) return lean;
  const candidates = lean.filter(compactCandidate).map((e) => e.intro_id as string);
  if (!candidates.length) return lean;
  const last = await lastActivity(candidates);
  const cutoff = (opts.now ?? new Date()).getTime() - LEAN_SWEEP_QUIET_DAYS * 24 * 60 * 60 * 1000;
  return lean.map((e) => {
    if (!compactCandidate(e)) return e;
    const at = last.get(e.intro_id);
    return at && at.getTime() < cutoff ? compactEntry(e) : e;
  });
}

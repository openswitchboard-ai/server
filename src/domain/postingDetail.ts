/**
 * DOES THE POSTING SAY ENOUGH TO DESCRIBE THE THING TO A STRANGER?
 *
 * The rehearsal that bought this (19 September 2026). A human said they had an
 * upgraded Fanatec pedal spring going spare. Their assistant put up "upgraded
 * Fanatec pedal spring" with NO attributes at all — it never asked which pedal
 * set the spring came off, which model, what condition it was in or what came
 * with it — invented the path 'goods.sim-racing.pedal-parts', and left. The
 * founder's words: "we need the user's AI to ask questions until it understands
 * everything fully, something it is failing to do at present."
 *
 * We cannot make an assistant curious. What we can do is decline to go along
 * with a posting that says nothing, and hand back the questions it should have
 * asked — which is exactly what the switchboard already does with a place name
 * several towns answer to (LOCATION_AMBIGUOUS in geo/normalise.ts: "'X' names
 * more than one place. Ask your human which…"). This is that pattern applied to
 * the thing itself.
 *
 * THE RULE IS DELIBERATELY DETERMINISTIC. No model reads the posting here. A
 * model would have to be right about what "enough" means for every errand
 * anybody ever has, and it would be wrong quietly. Counting stated facts is a
 * rule an author can read, reproduce and argue with:
 *
 *   goods, offering     kind, AND two identifying facts, AND the condition.
 *   goods, looking_for  kind, AND one identifying fact. Lighter on purpose:
 *                       somebody looking for a thing may not know its model,
 *                       and that is what they are asking other people for.
 *   services / social   kind, AND one fact about what, when or how. Lighter
 *                       still: an errand is mostly words, and the words are
 *                       in `kind`.
 *   anything else       untouched.
 *
 * The keys are real ones. `attributes` is an open bag at the schema level
 * (lower_snake_case, identity and sensitive keys forbidden), so "identifying"
 * cannot be read off the schema; it is read off the taxonomy instead — the
 * common_attributes every node inherits plus every per-node attribute in
 * taxonomy.v2.json — with a short list of the plain words posting assistants
 * actually write for the same facts (make, fits, quantity, variant).
 *
 * AMEND NEVER COMES HERE. An amend only ever adds to a posting that is already
 * up, and refusing one would take a thing off the board for being what it
 * already was.
 */
import { getPool } from '../db.js';

/**
 * The facts that say WHICH ONE it is. Ordered by how often a posting has one,
 * which only matters for the questions below.
 *
 * `condition` is deliberately NOT here: on something offered it is asked for in
 * its own right, and letting it count towards the two would let "good, and
 * nothing else" through.
 */
export const IDENTIFYING_KEYS: readonly string[] = [
  // common_attributes, which every node inherits.
  'brand',
  'model',
  'colour',
  'year',
  // The plain words assistants write for the same facts. None of these is in
  // the taxonomy; all four turn up in real postings.
  'make',
  'type',
  'variant',
  'material',
  'quantity',
  'compatible_with',
  'fits',
  'size',
  // Per-node attributes in taxonomy.v2.json, which are all measurements of
  // which-one-is-it.
  'frame_size',
  'clothing_size',
  'shoe_size',
  'bed_size',
  'wheel_size_in',
  'screen_in',
  'storage_gb',
  'ram_gb',
  'battery_wh',
  'width_cm',
  'height_cm',
  'depth_cm',
  'seats',
  'suspension',
  'lens_mount',
  'shutter_count',
  'handedness',
  'unlocked',
  'expiry_year',
];

/**
 * The facts that say WHAT, WHEN or HOW on an errand or something social. Every
 * one of them is a taxonomy key: common_attributes has the first seven, and
 * `level` is services.tutoring's own.
 */
export const CONTEXT_KEYS: readonly string[] = [
  'format',
  'frequency',
  'day_part',
  'duration_min',
  'group_size',
  'language',
  'proficiency',
  'experience',
  'level',
];

/** The word for the condition of a thing, as the taxonomy spells it. */
export const CONDITION_KEY = 'condition';

/** How many identifying facts something offered has to state. */
export const OFFERING_IDENTIFYING_MIN = 2;
/** And something wanted. Lighter, because they are asking rather than telling. */
export const WANT_IDENTIFYING_MIN = 1;

/** The most questions one refusal carries. Past four it is a form to fill in. */
export const MAX_QUESTIONS = 4;

/**
 * How long the escape hatch stays open after a posting has been asked about.
 * Long enough for an assistant to put the questions to its human and hear
 * "I honestly don't know", short enough that it is never the ordinary road.
 */
export const DETAIL_UNKNOWN_WINDOW_MINUTES = 10;

/** A stated fact: a scalar with something in it. Same reading as projectionText. */
function stated(attributes: unknown, key: string): boolean {
  if (!attributes || typeof attributes !== 'object') return false;
  const v = (attributes as Record<string, unknown>)[key];
  if (typeof v === 'number' || typeof v === 'boolean') return true;
  return typeof v === 'string' && v.trim().length > 0;
}

function statedKeys(attributes: unknown, keys: readonly string[]): string[] {
  return keys.filter((k) => stated(attributes, k));
}

/** The poster's own words, where they gave any, for echoing back in a question. */
function thingWords(kind: unknown): string | undefined {
  const k = typeof kind === 'string' ? kind.trim() : '';
  return k ? k : undefined;
}

/**
 * The thing, as a question can name it: the poster's own words where they gave
 * any, and "it" otherwise. NEVER a guess at what the thing is — echoing what
 * they wrote is the whole of what this may do.
 */
const naming = (kind: unknown): string => {
  const words = thingWords(kind);
  return words ? `the ${words}` : 'it';
};

export interface DetailShortfall {
  /** What to ask the human, in plain words, at most MAX_QUESTIONS of them. */
  questions: string[];
}

/**
 * What a posting is short of, or undefined where it says enough.
 *
 * `category` is the path as the assistant wrote it, because the top level is
 * what decides which rule applies and the top level of an invented path is
 * still the assistant's own word for the kind of thing it is.
 */
export function detailShortfall(card: {
  category?: unknown;
  type?: unknown;
  kind?: unknown;
  attributes?: unknown;
}): DetailShortfall | undefined {
  const top = String(card.category ?? '').split('.')[0];
  const offering = card.type === 'offering';
  const kind = thingWords(card.kind);
  const thing = naming(card.kind);

  if (top === 'goods') {
    const identifying = statedKeys(card.attributes, IDENTIFYING_KEYS);
    const hasCondition = stated(card.attributes, CONDITION_KEY);
    const need = offering ? OFFERING_IDENTIFYING_MIN : WANT_IDENTIFYING_MIN;
    const enough = kind && identifying.length >= need && (!offering || hasCondition);
    if (enough) return undefined;

    // One question per thing that is missing, in the order a person would ask
    // them. Each one is generic to the field; the only thing taken from the
    // posting is the poster's own words for the thing.
    const questions: string[] = [];
    if (!kind) questions.push('What is it, in a few plain words?');
    const named = statedKeys(card.attributes, ['brand', 'make', 'model']).length > 0;
    if (!named) questions.push(`What make and model is ${thing}?`);
    if (identifying.length < need) {
      questions.push(
        `Which one is ${thing} exactly — the size, the type, or what it fits?`,
      );
    }
    if (offering && !hasCondition) questions.push(`What condition is ${thing} in?`);
    if (offering && identifying.length === 0) questions.push('What comes with it?');
    return { questions: questions.slice(0, MAX_QUESTIONS) };
  }

  if (top === 'services' || top === 'social') {
    const context = statedKeys(card.attributes, CONTEXT_KEYS);
    if (kind && context.length >= 1) return undefined;
    const questions: string[] = [];
    if (!kind) questions.push('What is it, in a few plain words?');
    if (context.length === 0) {
      questions.push('Is this in person or online?');
      questions.push('How often, and when would suit?');
    }
    return { questions: questions.slice(0, MAX_QUESTIONS) };
  }

  return undefined;
}

/** The one line telling the assistant what to do with the questions. */
export const DETAIL_HUMAN_ACTION =
  'Ask your human these, then post it again with their answers in `attributes`. If they truly do not know, say so with detail_unknown and post it again as it stands.';

// ---------------------------------------------------------------------------
// THE ESCAPE HATCH, AND WHY IT IS A ROW RATHER THAN A FLAG.
//
// Somebody really may not know. A spring came off a pedal set they no longer
// own; a box of cables came out of a cupboard. Refusing that posting for ever
// would be the switchboard deciding it knows better than the person whose thing
// it is, so `detail_unknown` takes it as it stands.
//
// What the flag alone must not do is let an assistant skip the asking. So it
// only works on a SECOND attempt: the same account, the same words for the
// thing, inside ten minutes of being asked. That is the shape of an assistant
// that put the questions to its human and was told nobody knows.
//
// It is a row rather than a number in this process because the process is one
// of several, and an agent that reaches a different replica on its second call
// would otherwise be trapped by a rule meant to stop nobody.
// ---------------------------------------------------------------------------

/** The key a shortfall is remembered under: the account and the thing's words. */
export const detailKey = (kind: unknown): string =>
  String(kind ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 60);

/** Write down that this posting was asked about. Never fails a publish. */
export async function recordDetailAsked(accountId: string, kind: unknown): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO posting_detail_asks (account_id, kind_key, asked_at)
       VALUES ($1, $2, now())
       ON CONFLICT (account_id, kind_key) DO UPDATE SET asked_at = now()`,
      [accountId, detailKey(kind)],
    );
  } catch {
    /* the record is a courtesy to the next call; the refusal is the point */
  }
}

/** Whether this account was asked about this same thing a moment ago. */
export async function detailAskedRecently(accountId: string, kind: unknown): Promise<boolean> {
  try {
    const r = await getPool().query(
      `SELECT 1 FROM posting_detail_asks
        WHERE account_id = $1 AND kind_key = $2
          AND asked_at > now() - make_interval(mins => $3::int)`,
      [accountId, detailKey(kind), DETAIL_UNKNOWN_WINDOW_MINUTES],
    );
    return (r.rowCount ?? 0) > 0;
  } catch {
    // The table is unreachable. Believing the agent is the kinder failure: the
    // alternative is trapping a human behind a question nobody can answer.
    return true;
  }
}

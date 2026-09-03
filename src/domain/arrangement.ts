/**
 * The standing arrangement: how a human wants their agents to behave, settled
 * once with them and then remembered by the network.
 *
 * The problem it solves is forgetting. An agent that can act unattended has to
 * agree a cadence with its human — how often to check, what is worth waking
 * them for, when to stay quiet, how bold to be with suggestions — and every
 * restart, model change, new session and new client used to lose that
 * agreement. Held here, it comes back on every check_matches sweep, so an
 * agent that has never met this human before still arrives knowing what they
 * asked for.
 *
 * Three rules hold this file together.
 *
 *  1. It is preferences and never identity. Cadence and etiquette go in;
 *     names, addresses, ways to reach someone and card content stay out. The
 *     validation below is what makes that true rather than hoped for, which is
 *     what earns the plaintext column (see migrations/009_arrangement.sql).
 *  2. Small on purpose. Short fields, a handful of them, 2000 characters for
 *     the lot. An arrangement is a note to an agent rather than a document.
 *  3. Every change writes a WORM consent event naming the fields that moved
 *     and nothing of what they say.
 *
 * Setting it is on the agent surface because that is where the conversation
 * happens: the human says "check twice a day and leave me alone after nine"
 * mid-sentence, and their agent writes it down. Anyone holding this account's
 * bearer token can therefore write one, which is acceptable because the human
 * sees the whole thing in plain words on their own approval page and can edit
 * or clear it there. What an arrangement can never do is stand in for consent:
 * the gates (stage-3 sharing, accepting an offer, approving a settlement) are
 * enforced elsewhere and read nothing from here.
 */
import { getPool } from '../db.js';
import { writeConsentEvent } from '../crypto.js';

export type SuggestionAppetite = 'keen' | 'occasional' | 'big-things-only' | 'never';

export interface Arrangement {
  /** How often the agent should check the switchboard, in minutes. Minutes are
   *  only the wire format: the human and their agent agree it in words
   *  ("twice a day") and the agent writes the number (720). Absent means
   *  check when asked and no more. */
  check_every_minutes?: number;
  /** What earns an interruption there and then. */
  interrupt_for?: string[];
  /** What waits for a summary, and when that summary comes. */
  summarize?: string;
  /** How bold to be about surfacing new wants and haves. */
  suggestion_appetite?: SuggestionAppetite;
  /** When to stay quiet. */
  quiet_hours?: string;
  /** Anything else standing. */
  notes?: string;
}

export const SUGGESTION_APPETITES: SuggestionAppetite[] = [
  'keen',
  'occasional',
  'big-things-only',
  'never',
];

/** Field caps. Short on purpose: this is a note to an agent. */
export const ARRANGEMENT_TOTAL_MAX = 2000;
export const SHORT_FIELD_MAX = 120;
export const INTERRUPT_ITEM_MAX = 80;
export const INTERRUPT_MAX_ITEMS = 12;
export const NOTES_MAX = 600;

/** The cadence floor and ceiling, in minutes: no oftener than every half hour,
 *  no rarer than once a week. */
export const CHECK_EVERY_MINUTES_MIN = 30;
export const CHECK_EVERY_MINUTES_MAX = 10080;
/** One sentence, said the same way on the page and in the refusal. */
export const CHECK_EVERY_MINUTES_HELP =
  'No more often than every 30 minutes — a few times a day is plenty.';

export const ARRANGEMENT_FIELDS = [
  'check_every_minutes',
  'interrupt_for',
  'summarize',
  'suggestion_appetite',
  'quiet_hours',
  'notes',
] as const;
export type ArrangementField = (typeof ARRANGEMENT_FIELDS)[number];

// ---------------------------------------------------------------------------
// Validation. The plaintext column is only safe while this holds, so it is
// deliberately stricter than it needs to be for the honest case.
//
// The contact-shaped test here is a cousin of the one in profile.ts rather
// than the same function: an arrangement has to be able to say "quiet after
// 22:00 until 07:00", and profile.ts turns away any string carrying six digits
// because a suburb never needs them. So digits are counted in RUNS, with a
// colon treated as a hard separator, which lets clock times through and still
// catches +61 400 000 000 and 0412345678.
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u001f\u007f<>]/;
const WEB_ADDRESS = /(https?:\/\/|\bwww\.)/i;
const DOMAIN_TAIL = /\.(com|net|org|io|ai|co|uk|au|nz|de|fr|it|es|info|biz|xyz)\b/i;
/** Seven or more digits in one run, allowing the separators phone numbers use. */
const PHONE_RUN = /(?:\d[\s().+-]{0,2}){7,}/;

export function looksLikeContactDetail(s: string): boolean {
  if (s.includes('@')) return true;
  if (WEB_ADDRESS.test(s) || DOMAIN_TAIL.test(s)) return true;
  if (/^\s*\+\s*\d/.test(s)) return true;
  // A colon ends a run, so "22:00 to 07:00" is four short runs rather than one
  // long one, while "+61 400 000 000" and "0412 345 678" stay caught.
  return s.split(':').some((part) => PHONE_RUN.test(part));
}

export type ArrangementValidation =
  | { ok: true; value: Arrangement }
  | { ok: false; error: string };

function checkText(
  label: string,
  raw: unknown,
  max: number,
): { ok: true; value?: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== 'string') return { ok: false, error: `${label} should be a short line of text.` };
  const value = raw.trim();
  if (!value) return { ok: true };
  if (CONTROL_CHARS.test(value)) return { ok: false, error: `Plain text only in ${label}.` };
  if (value.length > max) {
    return { ok: false, error: `${label} runs past ${max} characters. A short line is enough.` };
  }
  if (looksLikeContactDetail(value)) {
    return {
      ok: false,
      error: `${label} holds an email, phone number or web address. This is about how your agents behave, so keep ways of reaching you out of it.`,
    };
  }
  return { ok: true, value };
}

/**
 * Validate a whole arrangement. A `set` always replaces the previous object,
 * so what comes back here is the complete new one; empty and missing fields
 * are the same thing and both drop out.
 */
export function validateArrangement(input: unknown): ArrangementValidation {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'An arrangement is an object of settings.' };
  }
  const src = input as Record<string, unknown>;
  const unknownKey = Object.keys(src).find(
    (k) => !(ARRANGEMENT_FIELDS as readonly string[]).includes(k),
  );
  if (unknownKey) {
    return {
      ok: false,
      error: `'${unknownKey}' is not part of an arrangement. The settings are ${ARRANGEMENT_FIELDS.join(', ')}.`,
    };
  }

  const out: Arrangement = {};

  for (const [field, max, label] of [
    ['summarize', SHORT_FIELD_MAX, 'What waits for a summary'],
    ['quiet_hours', SHORT_FIELD_MAX, 'Quiet hours'],
    ['notes', NOTES_MAX, 'Notes'],
  ] as const) {
    const r = checkText(label, src[field], max);
    if (!r.ok) return r;
    if (r.value) (out as Record<string, unknown>)[field] = r.value;
  }

  if (
    src.check_every_minutes !== undefined &&
    src.check_every_minutes !== null &&
    src.check_every_minutes !== ''
  ) {
    const m = Number(src.check_every_minutes);
    if (!Number.isInteger(m)) {
      return {
        ok: false,
        error: `How often to check is a whole number of minutes. ${CHECK_EVERY_MINUTES_HELP}`,
      };
    }
    if (m < CHECK_EVERY_MINUTES_MIN) {
      return {
        ok: false,
        error: `How often to check is a number of minutes. ${CHECK_EVERY_MINUTES_HELP}`,
      };
    }
    if (m > CHECK_EVERY_MINUTES_MAX) {
      return {
        ok: false,
        error: `How often to check runs past ${CHECK_EVERY_MINUTES_MAX} minutes, which is a week. Give a smaller number.`,
      };
    }
    out.check_every_minutes = m;
  }

  if (src.interrupt_for !== undefined && src.interrupt_for !== null) {
    if (!Array.isArray(src.interrupt_for)) {
      return { ok: false, error: 'What to interrupt for is a list of short lines.' };
    }
    if (src.interrupt_for.length > INTERRUPT_MAX_ITEMS) {
      return {
        ok: false,
        error: `That is more than ${INTERRUPT_MAX_ITEMS} things to interrupt for. Keep the list to what really cannot wait.`,
      };
    }
    const items: string[] = [];
    for (const item of src.interrupt_for) {
      const r = checkText('What to interrupt for', item, INTERRUPT_ITEM_MAX);
      if (!r.ok) return r;
      if (r.value) items.push(r.value);
    }
    if (items.length) out.interrupt_for = items;
  }

  if (src.suggestion_appetite !== undefined && src.suggestion_appetite !== null) {
    const a = String(src.suggestion_appetite).trim();
    if (a) {
      if (!SUGGESTION_APPETITES.includes(a as SuggestionAppetite)) {
        return {
          ok: false,
          error: `How bold to be with suggestions is one of: ${SUGGESTION_APPETITES.join(', ')}.`,
        };
      }
      out.suggestion_appetite = a as SuggestionAppetite;
    }
  }

  if (JSON.stringify(out).length > ARRANGEMENT_TOTAL_MAX) {
    return {
      ok: false,
      error: `The whole arrangement runs past ${ARRANGEMENT_TOTAL_MAX} characters. Trim it to the standing instructions.`,
    };
  }
  return { ok: true, value: out };
}

/** Which fields this object actually carries — the only thing the log records. */
export function fieldsSet(a: Arrangement): ArrangementField[] {
  return ARRANGEMENT_FIELDS.filter((f) => a[f] !== undefined);
}

export function isEmpty(a: Arrangement): boolean {
  return fieldsSet(a).length === 0;
}

// ---------------------------------------------------------------------------
// Storage. Plaintext jsonb, read on every sweep, written only through the
// validator above.
// ---------------------------------------------------------------------------

export async function readArrangement(accountId: string): Promise<Arrangement> {
  const r = await getPool().query(
    'SELECT arrangement FROM accounts WHERE id = $1',
    [accountId],
  );
  if (!r.rows[0]) throw Object.assign(new Error('account not found'), { notFound: true });
  const stored = r.rows[0].arrangement;
  if (!stored || typeof stored !== 'object') return {};
  // Anything that predates a tightening of the rules is filtered on the way
  // out, so a reader never sees a field the current validator would refuse.
  const checked = validateArrangement(stored);
  return checked.ok ? checked.value : {};
}

export async function readArrangementUpdatedAt(accountId: string): Promise<Date | undefined> {
  const r = await getPool().query(
    'SELECT arrangement_updated_at FROM accounts WHERE id = $1',
    [accountId],
  );
  return r.rows[0]?.arrangement_updated_at ?? undefined;
}

/**
 * Replace the whole arrangement. WORM event first, carrying the field names
 * that the new object holds and nothing of their contents.
 */
export async function saveArrangement(
  accountId: string,
  value: Arrangement,
  recordedVia: string,
): Promise<void> {
  await writeConsentEvent({
    event: 'arrangement-updated',
    account_id: accountId,
    fields: fieldsSet(value),
    cleared: isEmpty(value),
    recorded_via: recordedVia,
  });
  await getPool().query(
    `UPDATE accounts SET arrangement = $2::jsonb, arrangement_updated_at = now() WHERE id = $1`,
    [accountId, JSON.stringify(value)],
  );
}

// ---------------------------------------------------------------------------
// Saying it back in plain words — used by the approval page and by the note
// an agent gets alongside the object.
// ---------------------------------------------------------------------------

const APPETITE_WORDS: Record<SuggestionAppetite, string> = {
  keen: 'Bring me anything you spot.',
  occasional: 'Mention something now and then.',
  'big-things-only': 'Only bring me the big ones.',
  never: 'Never suggest anything on your own.',
};

/**
 * A number of minutes said the way a person would say it. The stored value is
 * always minutes; this is only how it reads back.
 */
export function cadenceInPlainWords(minutes: number): string {
  if (minutes === 10080) return 'once a week';
  if (minutes === 1440) return 'once a day';
  if (minutes % 1440 === 0) return `every ${minutes / 1440} days`;
  if (minutes === 60) return 'every hour';
  if (minutes % 60 === 0 && minutes < 1440) return `every ${minutes / 60} hours`;
  return `every ${minutes} minutes`;
}

/** One line per setting, in the plain words the human's page shows. */
export function arrangementInPlainWords(a: Arrangement): { k: string; v: string }[] {
  const lines: { k: string; v: string }[] = [];
  if (a.check_every_minutes !== undefined) {
    lines.push({
      k: 'How often your agents check',
      v: cadenceInPlainWords(a.check_every_minutes),
    });
  }
  if (a.interrupt_for?.length) {
    lines.push({ k: 'Worth interrupting you for', v: a.interrupt_for.join('; ') });
  }
  if (a.summarize) lines.push({ k: 'Everything else waits for', v: a.summarize });
  if (a.quiet_hours) lines.push({ k: 'Quiet hours', v: a.quiet_hours });
  // The page renders a rejected submission back to the human, so an appetite
  // that never passed the validator can reach here; it says nothing rather
  // than saying "undefined".
  if (a.suggestion_appetite && APPETITE_WORDS[a.suggestion_appetite]) {
    lines.push({ k: 'Suggestions', v: APPETITE_WORDS[a.suggestion_appetite] });
  }
  if (a.notes) lines.push({ k: 'Also standing', v: a.notes });
  return lines;
}

/**
 * The sentence that rides beside the object on every sweep. Switchboard
 * authored. Phrased as the human's own saved preferences reflected back,
 * not as a command from the system — so a defensive agent reads it as data
 * about its human, not an instruction from a stranger.
 */
export function arrangementNote(a: Arrangement): { text: string; provenance: string } {
  return {
    text: isEmpty(a)
      ? `Your human has not saved any standing preferences yet — nothing is on file about how they like to be treated here. When they tell you (how often to check, what is worth interrupting them for, when to stay quiet, how bold to be with suggestions), you can save it with standing_arrangement so it carries past this session. Cadence is a number of minutes: ${CHECK_EVERY_MINUTES_HELP}`
      : a.check_every_minutes === undefined
        ? "Your human's saved preferences, which they can see and change any time on their own page: they have set no checking cadence, so check when they ask you to and no oftener. Save any change they mention with standing_arrangement."
        : `Your human's saved preferences, which they can see and change any time on their own page: they asked you to check ${cadenceInPlainWords(a.check_every_minutes)}. Save any change they mention with standing_arrangement.`,
    provenance: 'switchboard-system',
  };
}

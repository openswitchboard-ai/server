/**
 * IS THE MONEY ON THIS POSTING THE HUMAN'S OWN NUMBER?
 *
 * The rehearsal that bought this (19 September 2026). A human said "not sure
 * what my budget is, what do these usually go for?" — which is a question back,
 * and the whole of what they said about money. Their assistant went to the web,
 * read what such things sell for, and posted a private price band of "up to $45
 * AUD" as though the human had given it. Nobody outside can ever see that band,
 * so nobody could ever have corrected it, and it silently decided which people
 * their human would be shown at all.
 *
 * The manual has said the rule for a long time, in rule (c) of the numbers
 * section: "Before anything leaves, read back what you are about to send and
 * ask yourself which words of theirs that exact number came from. If you cannot
 * point at them, you invented it." An assistant that has read that can still
 * fail to do it, so the door does it instead: a posting carrying a figure comes
 * back once, unposted, with the figure said out loud in plain words and a
 * question to put to the human. Post again with the same figure and it goes up
 * untouched, because by then somebody has been asked.
 *
 * This is the same shape as the thin-posting rule next door
 * (domain/postingDetail.ts), and it remembers what it asked in two parts: the
 * attempt's own reference number (domain/postingRef.ts), which says WHICH
 * posting is being talked about, and the figures themselves (figureAmountsKey
 * below), which say what was confirmed on it. Same reference and same figures,
 * and nobody is asked twice. Same reference, different figure, and the question
 * is put again.
 *
 * THE POSTER'S WORDS FOR THE THING USED TO BE IN THAT KEY, and they are what
 * made the question unanswerable: the detail gate next door asks an assistant
 * to say more exactly what the thing is, so "upgraded Fanatec pedal spring"
 * became "Fanatec ClubSport V3 brake performance spring" between one attempt
 * and the next, and the same question came back four times with nothing posted
 * at the end of it (21 September 2026). The reference is what replaced them.
 * The amounts stayed, because nothing in the flow ever asks an assistant to
 * change the price.
 *
 * THE AMOUNTS ARE NEVER LOGGED. What somebody will pay for a thing is theirs;
 * the band is encrypted on the row for exactly that reason, and a refusal on
 * the way to that row is no place to write it into a log line.
 */

/** One figure a posting carries, in the plain words for what it is. */
export interface PostingFigure {
  /** 'asking price', 'the least they will take', 'the most they will pay'. */
  what: string;
  amount: number;
  currency: string;
}

/**
 * The words for each figure, twice: once for the assistant, about its human,
 * and once for the question the human themselves is asked. A private band is
 * a floor on something offered and a ceiling on something wanted (the schema
 * says so in as many words), so which bound is read is which side it is on.
 */
const LEAST = 'the least they will take';
const MOST = 'the most they will pay';
/** The words for the one figure that is deliberate and disclosable. */
const ASKING = 'asking price';

/** The same three, said to the human whose figure it is. */
const TO_THE_HUMAN: Record<string, string> = {
  [ASKING]: 'your asking price',
  [LEAST]: 'the least you would take',
  [MOST]: 'the most you would pay',
};

const money = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const ccyOf = (v: unknown): string => {
  const c = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return c || 'AUD';
};

/**
 * Every money figure a posting states, from the two fields that can carry one:
 * `ask`, the disclosable asking price on something offered, and `price`, the
 * private band the matcher reads and nobody else ever sees.
 *
 * The band's own bound is read off the side: a floor on something offered, a
 * ceiling on something wanted, which is what the two mean. Where the posting
 * gave only the other bound, that one is read instead, because a figure the
 * matcher will use is a figure somebody should have said.
 */
export function figuresOnPosting(card: {
  type?: unknown;
  ask?: unknown;
  price?: unknown;
}): PostingFigure[] {
  const out: PostingFigure[] = [];
  const ask = card.ask as { amount?: unknown; ccy?: unknown } | undefined | null;
  const askAmount = money(ask?.amount);
  if (askAmount !== undefined) {
    out.push({ what: ASKING, amount: askAmount, currency: ccyOf(ask?.ccy) });
  }
  const price = card.price as
    | { band?: { min?: unknown; max?: unknown }; ccy?: unknown }
    | undefined
    | null;
  const min = money(price?.band?.min);
  const max = money(price?.band?.max);
  const offering = card.type === 'offering';
  const band = offering ? (min ?? max) : (max ?? min);
  if (band !== undefined) {
    out.push({ what: offering ? LEAST : MOST, amount: band, currency: ccyOf(price?.ccy) });
  }
  // The same number said twice is one question. A band whose floor and ceiling
  // are the same figure is the ordinary way to write "exactly this".
  const seen = new Set<string>();
  return out.filter((f) => {
    const k = `${f.what}|${f.amount}|${f.currency}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A figure as a person says it out loud: "$45 AUD". */
export const figureWords = (f: PostingFigure): string => `$${f.amount} ${f.currency}`;

/**
 * THE FIGURES AS THEY WERE READ BACK, in one line, to sit beside the reference.
 *
 * The reference says WHICH ATTEMPT this is. This says WHAT WAS CONFIRMED on it,
 * and the two together are the figure gate's memory: the same reference and the
 * same figures means somebody has already been asked and is not asked twice;
 * the same reference carrying a DIFFERENT figure is asked again, because a
 * changed number is precisely what this read-back exists to catch.
 *
 * THE THING'S OWN WORDS ARE NOT IN HERE, and that distinction is the whole of
 * the 21 September 2026 fix. The name had to leave the key because the other
 * questions in the same flow explicitly ask an assistant to change it — reword
 * the thing and the question came back for ever. Nothing in the flow ever asks
 * an assistant to change the price, so the amount never had to leave, and
 * taking it out would have thrown away what the question was checking.
 *
 * Each figure is written exactly as it was said to the human: which figure it
 * is, the amount, the money. Sorted, so the order two figures arrive in is not
 * a difference, and capped, because four figures of plain digits cannot
 * honestly need more room than this.
 */
export const figureAmountsKey = (figures: PostingFigure[]): string =>
  [...figures]
    .map((f) => `${f.what}|${f.amount}|${f.currency}`)
    .sort()
    .join(';')
    .slice(0, 200);

/** The most questions one refusal carries, the same as the detail gate's. */
export const MAX_FIGURE_QUESTIONS = 4;

/** What to put to the human, one question per figure, in their own plain words. */
export function figureQuestions(figures: PostingFigure[]): string[] {
  return figures
    .slice(0, MAX_FIGURE_QUESTIONS)
    .map(
      (f) =>
        `Is ${figureWords(f)} the figure you gave as ${TO_THE_HUMAN[f.what] ?? f.what}, or is it one I put there myself?`,
    );
}

/** The one line telling the assistant what to do with them. */
export const FIGURE_HUMAN_ACTION =
  'Nothing has gone up yet. Say each figure here to your human exactly as it stands, and post again only if those were their own words. If they gave you no figure, post again with none on it.';

/**
 * TWO SHELVES WITH A RULE OF THEIR OWN (Lachlan, 26 September 2026).
 *
 * The catalogue is a deny list (schema SPEC §2): a path decides whether a
 * family is open, and the model screen decides whether the thing itself is one
 * the switchboard carries. Two decisions made today fit neither, because each
 * is about WHAT KIND of thing sits on an open shelf, and the answer is in the
 * poster's own words rather than in the path.
 *
 * FOOD IS SHOP-BOUGHT ONLY. goods.food opened today with fresh produce, sealed
 * pantry food, coffee and tea, bulk-buy shares and a shop's, café's or
 * bakery's unsold stock. Food made, cooked or baked at home is NOT open while
 * the legal position is checked, and neither is cooking or catering to order
 * (services.food stays reserved). A home-baked cake and a bakery's leftover
 * cake file under the same leaf, so the leaf cannot say which is which; the
 * words can. A goods.food posting whose kind or attribute values say it is
 * home-made is refused before it goes up, with one plain sentence (schema SPEC
 * §10, "Food: shop-bought only"). Home-GROWN is left alone on purpose: a bag of
 * lemons off the tree is produce, and nobody cooked it.
 *
 * LOST AND FOUND PETS ARE THE ONE PLACE A LIVE ANIMAL MAY APPEAR. Live animals
 * stay off the switchboard everywhere it runs (the deny list's goods.animals
 * glob, and the model screen's live-animals code). Today one shelf opens,
 * social.community.lost-pet, where a lost pet is a want and a found one is a
 * have, so an owner and a finder can meet. It is under social rather than goods
 * so that the goods-wide stolen-goods screen, which reads "found" as a marker,
 * never reads a found dog as stolen property. What makes it safe is that
 * nothing on it is a sale: so a posting there carrying a price band, an asking
 * price, a best-offer sale or a reward is refused, and a posting there that
 * reads as selling, rehoming, adopting or breeding an animal is refused as
 * live-animals, word for word the sentence it would get anywhere else. On the
 * introduction itself every figure door refuses (matches.ts, assertNoMoney).
 *
 * DETERMINISTIC, as the other cheap refusals at the door are. It reads words,
 * it can be argued with, and it runs at publish (on the path as sent and again
 * on the shelf the door files it under) and at amend (on the posting as it will
 * stand). The model screen still reads the words afterwards, as it reads every
 * posting's.
 */

/** The one shelf a live animal may appear on. */
export const LOST_PET_SHELF = 'social.community.lost-pet';

/** Is this the lost and found pets shelf (or anything filed beneath it)? */
export function onLostPetShelf(category: string | null | undefined): boolean {
  if (!category) return false;
  return category === LOST_PET_SHELF || category.startsWith(`${LOST_PET_SHELF}.`);
}

/** Is this the food shelf? */
export function onFoodShelf(category: string | null | undefined): boolean {
  if (!category) return false;
  return category === 'goods.food' || category.startsWith('goods.food.');
}

/** What the rules read: the path, the poster's words, and the money fields. */
export interface ShelfRuleCard {
  category?: unknown;
  kind?: unknown;
  also_called?: unknown;
  attributes?: unknown;
  ask?: unknown;
  price?: unknown;
  sale?: unknown;
}

export interface ShelfRuleRefusal {
  /** The reason code, for the row and the ledger. Never said aloud. */
  reason_code: 'home-made-food' | 'live-animals' | 'no-money-on-lost-pets';
  /** The sentence the human hears. */
  human_action: string;
  /** The field to fix, where the refusal is about one. */
  field?: string;
}

export const HOME_MADE_FOOD_SENTENCE =
  "Home-made food isn't open on the switchboard yet. Shop-bought food, fresh produce and a shop's or café's leftovers can go up; food made, cooked or baked at home has to wait for now.";

export const LOST_PET_NO_MONEY_SENTENCE =
  'Lost and found pets carry no money on the switchboard: no price, no reward and no offer. Take that off and it can go up.';

export const LOST_PET_NOT_A_SALE_SENTENCE =
  'Live animals stay off the switchboard everywhere it runs. Lost and found pets is only for getting a pet back home, so selling, rehoming or adopting one cannot go up there either.';

/** Every word the poster wrote about the thing: kind, other names, values. */
function postersWords(card: ShelfRuleCard): string {
  const out: string[] = [];
  if (typeof card.kind === 'string') out.push(card.kind);
  if (Array.isArray(card.also_called)) {
    for (const p of card.also_called) if (typeof p === 'string') out.push(p);
  }
  const a = card.attributes;
  if (a && typeof a === 'object') {
    for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
      out.push(k.replace(/_/g, ' '));
      if (typeof v === 'string') out.push(v);
      else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') out.push(x);
    }
  }
  return out.join(' \n ').toLowerCase();
}

/**
 * Food made at home, in the words people write it in: home-made and its
 * spellings, home-cooked, home-baked, home-brewed, made/cooked/baked at home or
 * in my kitchen, and a first-person "I baked". Home-grown is NOT here, and
 * neither is a bare "I made": "a share of a bulk order I made" is shop food.
 */
const HOME_MADE =
  /\b(?:home[\s-]?(?:made|cooked|baked|brewed|cooking|baking)|homecooked|homebaked|(?:made|cooked|baked|brewed)\s+(?:it\s+|them\s+)?(?:at\s+home|in\s+my\s+(?:own\s+)?kitchen|by\s+me|myself)|my\s+own\s+(?:baking|cooking)|i\s+(?:baked|cooked|brewed))\b/;

/** Is this food posting home-made, by its own words? */
export function saysHomeMade(card: ShelfRuleCard): boolean {
  return HOME_MADE.test(postersWords(card));
}

/**
 * A lost or found pet being sold, rehomed, adopted or bred. NOT a bare
 * "breed": that is what a kelpie IS, and a probe on 26 September 2026 had a
 * lost brown kelpie refused as breeding stock because its attributes said
 * `breed: kelpie`. Breeding is "breeder", "breeding", "to breed", "for breeding".
 */
const ANIMAL_TRADE =
  /\b(?:for\s+sale|sell(?:ing)?|sold|buy(?:ing)?|re-?hom(?:e|es|ed|ing)|adopt(?:ion|ing|ed)?|breed(?:er|ers|ing)|(?:to|for)\s+breed|stud|litter|free\s+to\s+(?:a\s+)?good\s+home)\b/;

/** Money words on a lost or found pet, figure or none. */
const MONEY_WORDS = /\b(?:reward|price|paid|payment|fee|cost|cash)\b/;

/**
 * The refusal this posting earns on the shelf it is filed under, or undefined
 * where it may go up. Order: the thing itself first (home-made food, an animal
 * for sale), then the money, because taking a price off a dog for sale would
 * still leave a dog for sale.
 */
export function shelfRuleRefusal(card: ShelfRuleCard): ShelfRuleRefusal | undefined {
  const category = typeof card.category === 'string' ? card.category : '';
  if (onFoodShelf(category) && saysHomeMade(card)) {
    return { reason_code: 'home-made-food', human_action: HOME_MADE_FOOD_SENTENCE };
  }
  if (onLostPetShelf(category)) {
    const words = postersWords(card);
    if (ANIMAL_TRADE.test(words)) {
      return { reason_code: 'live-animals', human_action: LOST_PET_NOT_A_SALE_SENTENCE };
    }
    const field = card.price
      ? 'price'
      : card.ask
        ? 'ask'
        : card.sale === 'best-offer'
          ? 'sale'
          : MONEY_WORDS.test(words)
            ? 'attributes'
            : undefined;
    if (field) {
      return { reason_code: 'no-money-on-lost-pets', human_action: LOST_PET_NO_MONEY_SENTENCE, field };
    }
  }
  return undefined;
}

/**
 * On an introduction: is this a shelf where no figure may ever be put on the
 * table? The lost and found pets shelf, whichever posting the row was filed
 * from. A swap is the other case, and it carries its own flag (swaps.ts).
 */
export function noMoneyOnShelf(category: string | null | undefined): boolean {
  return onLostPetShelf(category);
}

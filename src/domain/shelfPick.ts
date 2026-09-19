/**
 * OPTIONS FIRST, THEN A SEARCHABLE LIST (Lachlan, 20 September 2026).
 *
 * Where the door is unsure which shelf a thing belongs on, SHELF_UNCLEAR puts a
 * few shelves to the human in chat, and that stays the first step: most people
 * recognise their thing in one of four. What changed is the answer "none of
 * these". It used to file the posting under the top level at once, where it
 * sits among everything and is compared with nothing near it. Now it is
 * answered with SHELF_PICK: a one-time link to a page on the human's own
 * approval site with a search box over every open shelf the catalogue has, and
 * "put it under things in general" at the bottom for when nothing fits.
 *
 * The press records the chosen shelf against the question in flight
 * (domain/shelfGaps.ts, shelf_attempts), and the assistant, waiting on
 * wait_for_press as it does with every link, is handed the shelf in `picked`
 * and posts again with it. That is the pattern every link that stands in front
 * of a posting follows: the switchboard holds the answer, the assistant holds
 * the posting. The switchboard never posts on its own here, because it does not
 * hold the posting: nothing about the thing beyond its words was kept, and it
 * is not going to start keeping it for this.
 *
 * NO CEREMONY. Choosing a shelf discloses nothing and spends nothing, so the
 * page asks for no PIN or passkey, in the same way the photo page asks for
 * none: a signed-in session on the right account, and a link that works once.
 */
import { categoryDenied, categoryStatus, openCategories, taxonomyNode } from '../denylist.js';
import { categoryLabelPath } from './matchRules.js';
import { createApprovalLink, signLink, APPROVAL_LINK_TTL_MINUTES } from '../counter/links.js';
import { getPool } from '../db.js';
import type { Config } from '../config.js';

/**
 * The shelf the way a person would say it: "electronics", "mountain bikes",
 * "things in general". The deepest node the catalogue has a label for, in lower
 * case; a bare top level gets plain words of its own.
 */
export function shelfInWords(category: string): string {
  const parts = category.split('.');
  if (parts.length <= 1) {
    return (
      { goods: 'things in general', services: 'everyday help in general', social: 'people to do things with' }[
        parts[0]
      ] ?? parts[0]
    );
  }
  const path = categoryLabelPath(category).split(' > ');
  const leaf = path[path.length - 1] ?? category;
  return leaf.replace(/\s*&\s*/g, ' and ').toLowerCase();
}

/** One shelf on the page. */
export interface ShelfOption {
  category: string;
  /** The node's own label, as the row's headline: "Mountain bikes". */
  label: string;
  /** The branch above it in plain words: "Bicycles". Empty directly under a top level. */
  under: string;
  /** Everything a search is run over, folded: label path, phrase, the path's own words. */
  haystack: string;
}

/** Folded for searching: lower case, "&" as "and", punctuation to spaces. */
export function foldForSearch(s: string): string {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A node may be offered only where it is open and nothing has closed it. */
export const offerableShelf = (category: string): boolean =>
  categoryStatus(category).status === 'open' && !categoryDenied(category);

let cached: ShelfOption[] | undefined;

/**
 * Every open leaf of the catalogue, in the catalogue's own order. A leaf is a
 * node with no child of its own; a reserved node, anything under one, and
 * anything the deny list names never appear.
 */
export function openLeaves(): ShelfOption[] {
  if (cached) return cached;
  const open = openCategories();
  const all = new Set(open);
  const leaves = open.filter(
    (c) => c.includes('.') && ![...all].some((o) => o.startsWith(`${c}.`)) && offerableShelf(c),
  );
  cached = leaves.map((category) => {
    const labels = categoryLabelPath(category).split(' > ');
    const label = labels[labels.length - 1] ?? category;
    const under = labels.slice(1, -1).join(', ');
    const phrase = (taxonomyNode(category) as { phrase?: string } | undefined)?.phrase ?? '';
    const pathWords = category.split('.').slice(1).join(' ').replace(/-/g, ' ');
    return {
      category,
      label,
      under,
      haystack: foldForSearch([labels.slice(1).join(' '), phrase, pathWords].join(' ')),
    };
  });
  return cached;
}

/** The words of a search, folded, with a plural s dropped so "pedals" finds "pedal". */
export function searchWords(q: string): string[] {
  return foldForSearch(q)
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/**
 * The rows a search keeps: every word of it somewhere in the row. The page's
 * inline script runs the same rule letter for letter (SHELF_FILTER_SCRIPT in
 * counter/pages.ts), so a page with scripts off shows exactly what a page with
 * scripts on shows for the same words. An empty search keeps nothing: the list
 * is five hundred rows long, and it is a search box first.
 */
export function searchShelves(q: string, shelves: ShelfOption[] = openLeaves()): ShelfOption[] {
  const words = searchWords(q);
  if (!words.length) return [];
  return shelves.filter((s) => words.every((w) => s.haystack.includes(w)));
}

/** The one top-level shelf the page offers at the bottom: the posting's own. */
export function generalShelf(asPosted: string): string {
  const top = String(asPosted ?? '').split('.')[0];
  return offerableShelf(top) ? top : 'goods';
}

/** Whether `category` is a shelf this page may record: an open leaf, or the posting's own top level. */
export function pickable(category: string, asPosted: string): boolean {
  if (category === generalShelf(asPosted)) return true;
  return openLeaves().some((s) => s.category === category);
}

/** The sentence and link SHELF_PICK carries. */
export interface ShelfPickLink {
  link: string;
  press_id: string;
  expires_in_minutes: number;
}

/**
 * The page for this question: a live one already minted is handed back again
 * rather than a second minted beside it, so an assistant that asks twice does
 * not leave two pages about one question in the human's chat.
 */
export async function shelfPickLink(
  cfg: Config,
  accountId: string,
  attempt: string,
): Promise<ShelfPickLink> {
  const existing = await getPool().query(
    `SELECT * FROM approval_links
      WHERE account_id = $1 AND action = 'shelf-pick' AND ref_id = $2
        AND used_at IS NULL AND expires_at > now() + interval '1 minute'
      ORDER BY created_at DESC LIMIT 1`,
    [accountId, attempt],
  );
  const minted = existing.rows[0]
    ? { token: signLink(existing.rows[0]), id: existing.rows[0].id as string }
    : await createApprovalLink({
        accountId,
        action: 'shelf-pick',
        refId: attempt,
        // No other side: a shelf is this human's own business.
        counterpartyAccount: accountId,
      });
  return {
    link: `${cfg.counterOrigin}/a/${encodeURIComponent(minted.token)}`,
    press_id: minted.id,
    expires_in_minutes: APPROVAL_LINK_TTL_MINUTES,
  };
}

/**
 * The one line on SHELF_PICK. The error schema caps human_action at 300
 * characters and the link rides at the end of it, so the sentence is kept
 * short; the manual's categories section says the rest.
 */
export const SHELF_PICK_ACTION =
  'None of those fit, so your human picks the shelf. Hand them this page, say it lets them search every shelf, then wait_for_press and post again with the shelf in picked:';

/** The sentence for the human, on the press, and what the assistant does next. */
export function shelfPickedNote(category: string): { say: string; what_to_do: string } {
  return {
    say: `Got it: ${shelfInWords(category)}. I will put it up there now.`,
    what_to_do: `Post it again now with category ${category} and everything else as it was.`,
  };
}

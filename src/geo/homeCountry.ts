/**
 * Which country a human is probably in, for the one job of breaking a tie
 * between places that share a name.
 *
 * The defect (rehearsal, 19 September 2026): a human in Franklin, ACT typed
 * "Franklin" and the switchboard offered five Franklins, every one of them in
 * the United States. The gazetteer holds their Franklin — it is the largest of
 * the two Australian ones — but the candidate list is ranked on population
 * alone, and five American towns are bigger than both. The assistant told its
 * human, truthfully, that the name only resolved to US cities.
 *
 * Nothing about that ranking is wrong in general. What was missing is the one
 * thing the switchboard already knew about the person asking: roughly where in
 * the world they are. A hint from here reorders the candidates so their own
 * country comes first. It NEVER picks for them — a name several real towns
 * answer to is still put to the human — and it never changes what a name
 * resolves to. It is an ordering, not an answer.
 *
 * Two sources, in this order:
 *   1. the area already on their own page, when it settles to one place;
 *   2. the IANA zone their browser reported at onboarding.
 *
 * The area is the better evidence of the two: a person who has told the
 * switchboard they live in Canberra has said something about where they are,
 * while a zone is a clock setting and travels with a laptop. Neither is
 * treated as fact, because neither has to be — the worst a wrong hint can do
 * is put the likely answer second.
 */
import { ambiguousPlaces, resolvePlace } from './gazetteer.js';

/**
 * IANA zone -> ISO 3166-1 alpha-2, for the zones the switchboard's people
 * actually carry. `Intl` knows a great deal about zones and nothing at all
 * about which country one sits in, so this is a table; it is deliberately
 * small, because a hint is worth having only where it is right, and an
 * unknown zone costs nothing but the ordering that was there before.
 *
 * Whole regions that belong to one country are handled by prefix below, so
 * this holds only the zones whose region is shared.
 */
const ZONE_COUNTRY: Record<string, string> = {
  // New Zealand.
  'Pacific/Auckland': 'NZ',
  'Pacific/Chatham': 'NZ',
  NZ: 'NZ',
  'NZ-CHAT': 'NZ',
  // Britain and Ireland, which share a region with everyone else in Europe.
  'Europe/London': 'GB',
  'Europe/Belfast': 'GB',
  'Europe/Guernsey': 'GB',
  'Europe/Isle_of_Man': 'GB',
  'Europe/Jersey': 'GB',
  GB: 'GB',
  'GB-Eire': 'GB',
  'Europe/Dublin': 'IE',
  Eire: 'IE',
  // The United States, mainland and out.
  'America/New_York': 'US',
  'America/Detroit': 'US',
  'America/Chicago': 'US',
  'America/Menominee': 'US',
  'America/Denver': 'US',
  'America/Boise': 'US',
  'America/Phoenix': 'US',
  'America/Los_Angeles': 'US',
  'America/Anchorage': 'US',
  'America/Juneau': 'US',
  'America/Metlakatla': 'US',
  'America/Nome': 'US',
  'America/Sitka': 'US',
  'America/Yakutat': 'US',
  'America/Adak': 'US',
  'Pacific/Honolulu': 'US',
  // Canada.
  'America/Toronto': 'CA',
  'America/Montreal': 'CA',
  'America/Vancouver': 'CA',
  'America/Edmonton': 'CA',
  'America/Winnipeg': 'CA',
  'America/Halifax': 'CA',
  'America/Moncton': 'CA',
  'America/Regina': 'CA',
  'America/Swift_Current': 'CA',
  'America/St_Johns': 'CA',
  'America/Goose_Bay': 'CA',
  'America/Glace_Bay': 'CA',
  'America/Whitehorse': 'CA',
  'America/Dawson': 'CA',
  'America/Dawson_Creek': 'CA',
  'America/Fort_Nelson': 'CA',
  'America/Yellowknife': 'CA',
  'America/Inuvik': 'CA',
  'America/Iqaluit': 'CA',
  'America/Rankin_Inlet': 'CA',
  'America/Resolute': 'CA',
  'America/Cambridge_Bay': 'CA',
  'America/Atikokan': 'CA',
  'America/Blanc-Sablon': 'CA',
  'America/Nipigon': 'CA',
  'America/Rainy_River': 'CA',
  'America/Thunder_Bay': 'CA',
  'America/Creston': 'CA',
};

/** Regions and legacy prefixes that belong to exactly one country. */
const ZONE_PREFIX_COUNTRY: [string, string][] = [
  ['Australia/', 'AU'],
  ['Antarctica/Macquarie', 'AU'],
  ['US/', 'US'],
  ['Canada/', 'CA'],
];

/**
 * The country an IANA zone sits in, or undefined when the table has nothing
 * to say. Pure, and deliberately quiet: a zone nobody listed is not a guess
 * worth making, and the caller carries on exactly as it did before hints.
 */
export function countryOfTimeZone(tz: string | null | undefined): string | undefined {
  const name = (tz ?? '').trim();
  if (!name) return undefined;
  const exact = ZONE_COUNTRY[name];
  if (exact) return exact;
  for (const [prefix, cc] of ZONE_PREFIX_COUNTRY) {
    if (name.startsWith(prefix)) return cc;
  }
  return undefined;
}

/**
 * The country an area on file sits in, when the area settles to one place on
 * its own. A name several cities answer to says nothing about which country
 * the person is in — it is the very question a hint is meant to help with —
 * so an ambiguous area yields no hint rather than the biggest namesake's flag.
 */
export function countryOfArea(area: string | null | undefined): string | undefined {
  const raw = (area ?? '').trim();
  if (!raw) return undefined;
  if (ambiguousPlaces(raw)) return undefined;
  return resolvePlace(raw)?.country;
}

/** What is known about where this human is, as the two facts on the account. */
export interface HomeFacts {
  /** Exactly what they typed as their area, if anything. */
  area?: string | null;
  /** Their IANA zone, if it was ever captured. */
  timezone?: string | null;
}

/**
 * The country hint for a human, area first and zone second, or undefined when
 * neither says anything.
 */
export function homeCountry(facts: HomeFacts): string | undefined {
  return countryOfArea(facts.area) ?? countryOfTimeZone(facts.timezone);
}

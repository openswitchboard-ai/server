/**
 * Which country a human's clock says they are in.
 *
 * The defect that started this (rehearsal, 19 September 2026): a human in
 * Franklin, ACT typed "Franklin" and the switchboard offered five Franklins,
 * every one of them in the United States. For a week the country read here
 * reordered that list, then settled a shared name outright where the human's
 * country held exactly one place of it.
 *
 * SINCE 26 SEPTEMBER 2026 IT PLACES NO POSTING. A posting's place is written in
 * full, town, state and country, and the switchboard never guesses which town
 * was meant (geo/normalise.ts), so what country a human is probably in has no
 * say in where anything they post goes. It is kept for two courtesies on the
 * human's own side, where the person who typed a name is the person who hears
 * it back:
 *   - ordering the area box's suggestions, their own country first
 *     (geo/suggest.ts);
 *   - writing their own area out in full where their country holds exactly
 *     one town of the name they typed (gazetteer.ts resolveOwnArea).
 *
 * The area-first reading this file used to offer, and the account read that
 * went with it, had only the posting path to serve and went with it.
 */
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

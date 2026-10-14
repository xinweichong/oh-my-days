/**
 * Choosing a timezone without typing an IANA name: a short common list, and
 * city names matched against the runtime's zone list. A city maps to a zone
 * only when exactly one zone has that city name; otherwise the user chooses.
 */

/** Offered as buttons after the user's recent zones. */
export const COMMON_ZONES = [
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Hong_Kong",
  "Australia/Sydney",
  "Europe/London",
  "Europe/Paris",
  "America/New_York",
  "America/Los_Angeles",
] as const;

/** Partial-name matches beyond this many are too vague to offer. */
const MAX_CHOICES = 4;

export type CityMatch = { zone: string } | { choose: string[] };

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, " ");
}

/** "America/Argentina/Buenos_Aires" → "buenos aires". */
function cityOf(zone: string): string {
  return normalize(zone.slice(zone.lastIndexOf("/") + 1));
}

/**
 * "London" → Europe/London; "new york" → America/New_York. An exact city name
 * shared by several zones, or a unique-enough start of a name ("Kuala"), is a
 * choice; anything else is null.
 */
export function matchCity(input: string, zones: readonly string[]): CityMatch | null {
  const wanted = normalize(input);
  if (wanted.length < 3 || /[^\p{L}\s.'-]/u.test(wanted)) return null;
  const exact = zones.filter((z) => z.includes("/") && cityOf(z) === wanted);
  const [only] = exact;
  if (exact.length === 1 && only) return { zone: only };
  if (exact.length > 1) return { choose: exact.slice(0, MAX_CHOICES) };
  const partial = zones.filter((z) => z.includes("/") && cityOf(z).startsWith(wanted));
  if (partial.length >= 1 && partial.length <= MAX_CHOICES) return { choose: partial };
  return null;
}

/** "Europe/London" → "London", for button labels. */
export function zoneLabel(zone: string): string {
  return zone.includes("/") ? zone.slice(zone.lastIndexOf("/") + 1).replace(/_/g, " ") : zone;
}

/** The new recent list after switching away from `previous`: newest first, at most three. */
export function nextRecentZones(
  previous: string,
  recent: readonly string[],
  now: string,
): string[] {
  return [previous, ...recent].filter((z, i, all) => z !== now && all.indexOf(z) === i).slice(0, 3);
}

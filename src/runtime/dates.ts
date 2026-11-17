// Date wording shared by the card, the copied brief and the toolbar badge.

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * A date without a time: "Aug 12", or "Aug 12, 2025" when it is not this
 * year. An unreadable timestamp gives null, never a made-up date.
 */
export function formatDay(iso: string, now: number = Date.now(), locale?: string): string | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString(locale, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/**
 * How old a scan is, in at most four characters, for the toolbar badge:
 * "<1h", "5h", "3d", "999+". An unreadable timestamp is "?", never "0d".
 * A timestamp in the future (a clock that is off) reads as "<1h".
 */
export function scanAgeBadge(iso: string | null, now: number = Date.now()): string {
  const at = iso === null ? Number.NaN : Date.parse(iso);
  if (Number.isNaN(at)) return "?";
  const age = Math.max(0, now - at);
  if (age < HOUR_MS) return "<1h";
  if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)}h`;
  const days = Math.floor(age / DAY_MS);
  return days > 999 ? "999+" : `${days}d`;
}

/** The same age in words, for the badge's tooltip: "3 days ago". */
export function scanAgeWords(iso: string | null, now: number = Date.now()): string {
  const at = iso === null ? Number.NaN : Date.parse(iso);
  if (Number.isNaN(at)) return "unknown";
  const age = Math.max(0, now - at);
  if (age < HOUR_MS) return "less than an hour ago";
  if (age < DAY_MS) return plural(Math.floor(age / HOUR_MS), "hour");
  return plural(Math.floor(age / DAY_MS), "day");
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

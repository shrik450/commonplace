import { parseIso } from "../../contracts/clock";

export function hostOf(url: string): string | null {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function readableDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(parseIso(iso));
}

// A short date for a card's corner: the day and month, plus the year when it
// isn't the current one.
export function cardDate(iso: string, locale: string, today: Date): string {
  const date = parseIso(iso);
  const sameYear = date.getUTCFullYear() === today.getUTCFullYear();
  return new Intl.DateTimeFormat(locale, sameYear
    ? { day: "numeric", month: "short", timeZone: "UTC" }
    : { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

export function monthOf(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(parseIso(iso));
}

// About 1,300 characters of prose per minute: 230 words of six characters.
const CHARACTERS_PER_MINUTE = 1_300;

export function readingMinutes(contentLength: number): number {
  return Math.max(1, Math.round(contentLength / CHARACTERS_PER_MINUTE));
}

export function counted(count: number, one: string, many: string): string {
  return `${new Intl.NumberFormat("en").format(count)} ${count === 1 ? one : many}`;
}

// Picks one of `variants` looks for a value, the same every time.
export function variantOf(key: string, variants: number): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 16_777_619);
  }
  return (hash >>> 0) % variants;
}

// How many clippings and page notes, naming page notes only when there are
// some. `noted` says the clippings are those with a note.
export function entryCount(clippings: number, pageNotes: number, noted = false): string {
  const parts: string[] = [];
  if (clippings > 0 || pageNotes === 0) parts.push(`${counted(clippings, "clipping", "clippings")}${noted ? " with notes" : ""}`);
  if (pageNotes > 0) parts.push(counted(pageNotes, "page note", "page notes"));
  return parts.join(" and ");
}

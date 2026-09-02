export type StoredAnchor = { start: number; end: number; quote: string };
export type Anchored = { start: number; end: number; moved: boolean };

// Places a quote in a transcript. An annotation stores both its offsets and
// its text, so a transcript that changed under it can still be placed by the
// text alone. A highlight arriving from an ereader carries only text, and it
// enters the system through the same door.
export function anchorQuote(
  transcript: string,
  quote: string,
  near = 0,
): Anchored | null {
  if (quote === "") return null;

  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (
    let index = transcript.indexOf(quote);
    index !== -1;
    index = transcript.indexOf(quote, index + 1)
  ) {
    const distance = Math.abs(index - near);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  if (best === -1) return null;
  return { start: best, end: best + quote.length, moved: true };
}

// Checks a stored range against its quote and moves it when the two disagree.
// A quote the transcript no longer holds returns null rather than a guess: a
// highlight in the wrong place is worse than a highlight the reader cannot see.
export function reanchor(
  transcript: string,
  anchor: StoredAnchor,
): Anchored | null {
  if (anchor.quote === "") return null;
  if (transcript.slice(anchor.start, anchor.end) === anchor.quote) {
    return { start: anchor.start, end: anchor.end, moved: false };
  }
  return anchorQuote(transcript, anchor.quote, anchor.start);
}

export type StoredAnchor = { start: number; end: number; quote: string };
export type Anchored = { start: number; end: number; moved: boolean };

// Finds the quote occurrence nearest `near`. This supports stored annotations
// with stale offsets and imported highlights that contain only quoted text.
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

// Keeps a matching stored range or finds the nearest matching quote. Returns
// `null` when the transcript no longer contains the quote.
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

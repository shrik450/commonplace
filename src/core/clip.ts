import { runAt, type TranscriptMap } from "../contracts/transcript";

export type TextRange = { start: number; end: number };

// Long enough for several paragraphs, short enough that a clipping stays a
// clipping rather than a copy of the page.
export const MAX_CLIP_LENGTH = 10_000;

const SPACE = /\s/;

// Turns a reader's selection into the range a clipping stores, or returns
// `null` when the selection can't be a clipping. A clipping starts and ends on
// article text, never covers text outside the article, and doesn't begin or
// end with whitespace. It may span the gaps between paragraphs.
export function clipRange(
  transcript: string,
  map: TranscriptMap,
  selection: TextRange,
): TextRange | null {
  let { start, end } = selection;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end > transcript.length || start >= end) return null;

  while (start < end && SPACE.test(transcript[start]!)) start += 1;
  while (end > start && SPACE.test(transcript[end - 1]!)) end -= 1;
  if (start === end || end - start > MAX_CLIP_LENGTH) return null;

  if (runAt(map, start)?.is_content !== true) return null;
  if (runAt(map, end - 1)?.is_content !== true) return null;
  for (const run of map.runs) {
    if (!run.is_content && run.start < end && run.end > start) return null;
  }
  return { start, end };
}

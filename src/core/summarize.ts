import type { ItemSummary } from "../contracts/item";
import { blocksOf, type TranscriptMap } from "../contracts/transcript";

// Store migration 6 applies this same rule in SQL to the indexed blocks, so an
// item saved before summaries existed gets exactly what a new ingest gets.
// Change both together.
export const EXCERPT_MIN_LENGTH = 80;
export const EXCERPT_MAX_LENGTH = 400;

// Summarizes the content blocks an item's search index holds: the first block
// long enough to read as prose, and the total length of the content.
export function summarize(transcript: string, map: TranscriptMap): ItemSummary {
  let excerpt = "";
  let contentLength = 0;
  for (const block of blocksOf(map)) {
    const first = block.runs[0]!;
    if (!first.is_content) continue;
    const text = transcript.slice(first.start, block.runs.at(-1)!.end);
    if (text.trim() === "") continue;
    contentLength += text.length;
    if (excerpt === "" && text.length >= EXCERPT_MIN_LENGTH) {
      excerpt = text.slice(0, EXCERPT_MAX_LENGTH);
    }
  }
  return { excerpt, content_length: contentLength };
}

import { AppError } from "./errors";

export type Run = {
  start: number; // Inclusive offset in UTF-16 code units.
  end: number; // Exclusive offset in UTF-16 code units.
  doc_index: number; // Zero for an article, or the spine index for a book.
  node_path: string; // Slash-separated child indices, such as `1/0/3`.
  block_index: number; // Groups runs into paragraph-sized blocks.
  is_content: boolean;
};

export type TranscriptMap = { runs: Run[] };

export type Transcript = { text: string; map: TranscriptMap };

function malformed(message: string, index?: number): AppError {
  return new AppError(
    "WALK_MAP_MALFORMED",
    message,
    index === undefined ? {} : { index },
  );
}

export function validateMap(map: TranscriptMap, textLength: number): void {
  if (map.runs.length === 0) {
    if (textLength > 0) {
      throw malformed("a map with no runs can't cover nonempty text");
    }
    return;
  }

  let cursor = 0;
  let blockIndex = 0;
  for (let i = 0; i < map.runs.length; i += 1) {
    const run = map.runs[i]!;
    if (!Number.isInteger(run.doc_index) || run.doc_index < 0) {
      throw malformed(
        `run ${i} has doc_index ${String(run.doc_index)}; expected a non-negative integer`,
        i,
      );
    }
    if (!Number.isInteger(run.block_index) || run.block_index < 0) {
      throw malformed(
        `run ${i} has block_index ${String(run.block_index)}; expected a non-negative integer`,
        i,
      );
    }
    if (run.block_index < blockIndex) {
      throw malformed(
        `run ${i} has block_index ${run.block_index} after ${blockIndex}; it must never decrease`,
        i,
      );
    }
    blockIndex = run.block_index;
    if (typeof run.node_path !== "string") {
      throw malformed(
        `run ${i} has a ${typeof run.node_path} node_path; expected a string`,
        i,
      );
    }
    if (run.end <= run.start) {
      throw malformed(
        `run ${i} spans ${run.start}..${run.end}; end must exceed start`,
        i,
      );
    }
    if (run.start !== cursor) {
      throw malformed(
        `run ${i} starts at ${run.start} but the text up to ${cursor} is tiled`,
        i,
      );
    }
    cursor = run.end;
  }

  if (cursor !== textLength) {
    throw malformed(
      `runs end at ${cursor} but the text length is ${textLength}`,
      map.runs.length - 1,
    );
  }
}

export function runAt(map: TranscriptMap, offset: number): Run | undefined {
  const runs = map.runs;
  if (offset < 0) return undefined;

  let low = 0;
  let high = runs.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const run = runs[mid]!;
    if (offset < run.start) {
      high = mid - 1;
    } else if (offset >= run.end) {
      low = mid + 1;
    } else {
      return run;
    }
  }
  return undefined;
}

export function runsInRange(
  map: TranscriptMap,
  start: number,
  end: number,
): Run[] {
  if (start >= end) return [];

  const first = runAt(map, start);
  if (!first) return [];

  const found: Run[] = [first];
  let cursor = first.end;
  while (cursor < end) {
    const run = runAt(map, cursor);
    if (!run) break;
    found.push(run);
    cursor = run.end;
  }
  return found;
}

export function contentRanges(
  map: TranscriptMap,
  start: number,
  end: number,
): Array<{ start: number; end: number }> {
  if (start >= end) return [];

  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = start;
  while (cursor < end) {
    const run = runAt(map, cursor);
    if (!run) break;

    const clippedEnd = Math.min(run.end, end);
    if (run.is_content) {
      const last = ranges[ranges.length - 1];
      if (last && last.end === cursor) {
        last.end = clippedEnd;
      } else {
        ranges.push({ start: cursor, end: clippedEnd });
      }
    }
    cursor = run.end;
  }
  return ranges;
}

export function sliceText(t: Transcript, start: number, end: number): string {
  return t.text.slice(start, end);
}

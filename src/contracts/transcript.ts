import { AppError } from "./errors";

export type Run = {
  start: number; // Inclusive offset in UTF-16 code units.
  end: number; // Exclusive offset in UTF-16 code units.
  doc_index: number; // Zero for a web item.
  node_path: string; // Slash-separated child indices, such as `1/0/3`.
  block_index: number; // Groups runs into paragraph-sized blocks.
  is_content: boolean;
};

export type TranscriptMap = { runs: Run[] };

export type Transcript = { text: string; map: TranscriptMap };

export type TranscriptBlock = { index: number; runs: Run[] };

export function blocksOf(map: TranscriptMap): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const run of map.runs) {
    const last = blocks.at(-1);
    if (last?.index === run.block_index) last.runs.push(run);
    else blocks.push({ index: run.block_index, runs: [run] });
  }
  return blocks;
}

type MapObject = { readonly runs?: unknown };
type RunObject = {
  readonly start?: unknown;
  readonly end?: unknown;
  readonly doc_index?: unknown;
  readonly node_path?: unknown;
  readonly block_index?: unknown;
  readonly is_content?: unknown;
};

function malformed(message: string, index?: number): AppError {
  return new AppError(
    "WALK_MAP_MALFORMED",
    message,
    index === undefined ? {} : { index },
  );
}

function isMapObject(value: unknown): value is MapObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRunObject(value: unknown): value is RunObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

export function validateMap(
  value: unknown,
  textLength: number,
): asserts value is TranscriptMap {
  if (!isMapObject(value)) {
    throw malformed("map must be an object");
  }
  const runs = value.runs;
  if (!Array.isArray(runs)) {
    throw malformed("map must contain a runs array");
  }
  if (!Number.isInteger(textLength) || textLength < 0) {
    throw malformed("text length must be a non-negative integer");
  }
  if (runs.length === 0) {
    if (textLength > 0) {
      throw malformed("a map with no runs can't cover nonempty text");
    }
    return;
  }

  let cursor = 0;
  let blockIndex = 0;
  for (let i = 0; i < runs.length; i += 1) {
    const candidate = runs[i];
    if (!isRunObject(candidate)) {
      throw malformed(`run ${i} must be an object`, i);
    }
    const start = candidate.start;
    if (!isNonNegativeInteger(start)) {
      throw malformed(`run ${i} has an invalid start`, i);
    }
    const end = candidate.end;
    if (!isNonNegativeInteger(end)) {
      throw malformed(`run ${i} has an invalid end`, i);
    }
    const docIndex = candidate.doc_index;
    if (!isNonNegativeInteger(docIndex)) {
      throw malformed(
        `run ${i} has doc_index ${String(docIndex)}; expected a non-negative integer`,
        i,
      );
    }
    const currentBlockIndex = candidate.block_index;
    if (!isNonNegativeInteger(currentBlockIndex)) {
      throw malformed(
        `run ${i} has block_index ${String(currentBlockIndex)}; expected a non-negative integer`,
        i,
      );
    }
    if (currentBlockIndex < blockIndex) {
      throw malformed(
        `run ${i} has block_index ${currentBlockIndex} after ${blockIndex}; it must never decrease`,
        i,
      );
    }
    blockIndex = currentBlockIndex;
    const nodePath = candidate.node_path;
    if (typeof nodePath !== "string") {
      throw malformed(
        `run ${i} has a ${nodePath === null ? "null" : typeof nodePath} node_path; expected a string`,
        i,
      );
    }
    if (typeof candidate.is_content !== "boolean") {
      throw malformed(`run ${i} has an invalid is_content`, i);
    }
    if (end <= start) {
      throw malformed(
        `run ${i} spans ${start}..${end}; end must exceed start`,
        i,
      );
    }
    if (start !== cursor) {
      throw malformed(
        `run ${i} starts at ${start} but the text up to ${cursor} is tiled`,
        i,
      );
    }
    cursor = end;
  }

  if (cursor !== textLength) {
    throw malformed(
      `runs end at ${cursor} but the text length is ${textLength}`,
      runs.length - 1,
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

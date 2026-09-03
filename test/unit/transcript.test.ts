import { describe, expect, test } from "bun:test";
import { AppError, isAppError } from "../../src/contracts/errors";
import { isNumberValue, type JsonValue } from "../../src/contracts/item";
import {
  contentRanges,
  runAt,
  runsInRange,
  sliceText,
  validateMap,
  type TranscriptMap,
} from "../../src/contracts/transcript";

function makeRun(
  start: number,
  end: number,
  isContent = true,
  documentIndex = 0,
  nodePath = "1/0",
  blockIndex = 0,
) {
  return {
    start,
    end,
    doc_index: documentIndex,
    node_path: nodePath,
    block_index: blockIndex,
    is_content: isContent,
  };
}

type MalformedResult = number | "malformed" | "no throw" | "unexpected error";

function malformedIndex(map: JsonValue, textLength: number): MalformedResult {
  try {
    validateMap(map, textLength);
    return "no throw";
  } catch (error) {
    if (!isAppError(error) || error.code !== "WALK_MAP_MALFORMED") {
      return "unexpected error";
    }
    const index = error.context.index;
    return isNumberValue(index) ? index : "malformed";
  }
}

describe("validateMap", () => {
  test("throws with the offending index in context", () => {
    expect(malformedIndex({ runs: [makeRun(0, 3), makeRun(4, 8)] }, 8)).toBe(1);
  });

  test("rejects a doc_index or node_path only by shape, not value", () => {
    const map: TranscriptMap = {
      runs: [makeRun(0, 3, true, 2, "0/1/2")],
    };
    expect(() => validateMap(map, 3)).not.toThrow();
  });

  test("accepts an empty node_path", () => {
    const map: TranscriptMap = {
      runs: [makeRun(0, 3, true, 0, "")],
    };
    expect(() => validateMap(map, 3)).not.toThrow();
  });

  test("rejects a non-integer doc_index", () => {
    const run = makeRun(0, 3, true, Number.NaN);
    expect(malformedIndex({ runs: [run] }, 3)).toBe(0);
  });

  test("rejects a negative doc_index", () => {
    const run = makeRun(0, 3, true, -1);
    expect(malformedIndex({ runs: [run] }, 3)).toBe(0);
  });

  test("rejects a missing node_path", () => {
    const run = makeRun(0, 3);
    Reflect.deleteProperty(run, "node_path");
    const map = { runs: [run] };
    expect(malformedIndex(map, 3)).toBe(0);
  });

  test("rejects every non-string node_path", () => {
    for (const nodePath of [null, 42, {}, []]) {
      expect(malformedIndex({ runs: [{ ...makeRun(0, 3), node_path: nodePath }] }, 3)).toBe(0);
    }
  });

  test("rejects every malformed map shape with WALK_MAP_MALFORMED", () => {
    const malformedMaps: JsonValue[] = [
      null,
      [],
      {},
      { runs: null },
      { runs: [null] },
      { runs: [{ ...makeRun(0, 3), start: "0" }] },
      { runs: [{ ...makeRun(0, 3), end: "3" }] },
      { runs: [{ ...makeRun(0, 3), block_index: false }] },
      { runs: [{ ...makeRun(0, 3), is_content: "yes" }] },
    ];
    for (const map of malformedMaps) {
      expect([0, "malformed"]).toContain(malformedIndex(map, 3));
    }
  });

  test("reports the last run when the tail does not reach textLength", () => {
    expect(malformedIndex({ runs: [makeRun(0, 3)] }, 10)).toBe(0);
  });
});

describe("runAt", () => {
  const map: TranscriptMap = {
    runs: [makeRun(0, 3), makeRun(3, 9), makeRun(9, 12)],
  };

  test("lands on the first and last runs", () => {
    expect(runAt(map, 0)?.end).toBe(3);
    expect(runAt(map, 11)?.start).toBe(9);
  });

  test("gives the middle run for an interior offset", () => {
    expect(runAt(map, 5)?.start).toBe(3);
  });
});

describe("runsInRange", () => {
  const map: TranscriptMap = {
    runs: [makeRun(0, 3), makeRun(3, 6), makeRun(6, 9)],
  };

  test("walks every overlapping run", () => {
    expect(runsInRange(map, 1, 8).map((run) => run.start)).toEqual([0, 3, 6]);
    expect(runsInRange(map, 0, 9).map((run) => run.start)).toEqual([0, 3, 6]);
    expect(runsInRange(map, 0, 0)).toEqual([]);
  });
});

describe("contentRanges", () => {
  const map: TranscriptMap = {
    runs: [makeRun(0, 3), makeRun(3, 6, false), makeRun(6, 9)],
  };

  test("keeps non-content spans out of the ranges", () => {
    expect(contentRanges(map, 0, 9)).toEqual([
      { start: 0, end: 3 },
      { start: 6, end: 9 },
    ]);
  });

  test("returns an empty list for an empty request", () => {
    expect(contentRanges(map, 4, 4)).toEqual([]);
  });
});

describe("sliceText", () => {
  const t = {
    text: "abcdef",
    map: { runs: [makeRun(0, 3), makeRun(3, 6)] },
  };

  test("reads through the map, not the DOM", () => {
    expect(sliceText(t, 0, 3)).toBe("abc");
    expect(sliceText(t, 3, 6)).toBe("def");
  });

  test("follows String.prototype.slice for out-of-range offsets", () => {
    expect(sliceText(t, 4, 100)).toBe("ef");
    expect(sliceText(t, 10, 20)).toBe("");
    expect(sliceText(t, -2, 6)).toBe("ef");
  });
});

describe("AppError context", () => {
  test("carries the map index as a number", () => {
    const error = new AppError("WALK_MAP_MALFORMED", "bad", { index: 7 });
    expect(error.context.index).toBe(7);
  });
});

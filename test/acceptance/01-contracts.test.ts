// Acceptance test for milestone 1. It is the specification for that work.
// Change it only when the design changes, and say what changed and why.
//
// What the implementer must create
// --------------------------------
// 1. `src/contracts/transcript.ts`, `src/contracts/item.ts`, and
//    `src/services/acquire.ts`, with the exact API in
// 2. `test/support/goldens.ts`, with the four functions in that brief.
// 3. Eight HTML files under `test/fixtures/synthetic/`: `blocks.html`,
//    `inline.html`, `pre.html`, `entities.html`, `astral.html`, `rtl.html`,
//    `table.html`, and `void.html`.
//
// Contract details this file pins down
// ------------------------------------
// The brief leaves these open. This file settles them, so build them this way.
//
// - `validateMap` puts the offending run index in `context.index`. The value is
//   a number.
// - An empty run list is valid when `textLength` is 0, and malformed when
//   `textLength` is greater than 0. See the comment on those two tests.
// - `buildArgs` always emits every pattern in `BLOCKED_URL_PATTERNS`. The
//   caller does not pass patterns.
// - `buildArgs` returns arguments only. It does not return the binary name.
//   The url and the output path are the two positional arguments, in that
//   order, and the output path comes directly after the url.
// - `capture` resolves the tool by the name `single-file` through `PATH`. The
//   test below empties `PATH` to prove the missing-binary path works.
// - `writeGolden` creates the parent directory when it does not exist.
// - `assertGolden` reads `process.env.UPDATE_GOLDENS` on every call, not once
//   at import time.
// - `assertGolden` fails with a message that holds the text `line <n>`, where
//   `<n>` is the 1-based number of the first differing line. It also names the
//   golden path.
//
// What the 02f consolidation pass added
// --------------------------------------
// - `Run` carries `block_index`. It is a non-negative integer that never
//   decreases from one run to the next, and `validateMap` checks that shape.
// - `src/contracts/ids.ts` exports the five branded id types with their
//   `new*` and `as*` constructors. Each `as*` throws `STORE_INVALID_PATH` for
//   a value that is not a lowercase UUID.
// - `src/contracts/clock.ts` is exactly `now`, `addMs`, `toIso`, `parseIso`,
//   and `isBefore`. `parseIso` throws `CONFIG_INVALID_VALUE`.
// - Every id field in `src/contracts/item.ts` carries its brand, so the
//   record tests below build ids through the `as*` constructors.
//
// Fixture rules the tests depend on
// ---------------------------------
// Each of the eight fixtures must be a complete HTML document with an explicit
// `<body>` element, and that body must hold some text. The tests below check
// only that. They never check fixture content, because the walker does not
// exist until milestone 3.
//
// Golden files
// ------------
// `goldenPath` takes a fixture name and a golden name and has no root
// argument, so the tests cannot redirect goldens to a temporary directory.
// They write under `test/fixtures/synthetic/scratch-golden-*` instead, and
// delete those directories when the file finishes. No real fixture is touched.
//
// Why `capture` is not run for real
// ---------------------------------
// A real capture starts Chromium and fetches a page. That needs a browser and
// the network, and it takes seconds. This file tests only the missing-binary
// path, which needs neither.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppError, ERROR_CODES, isAppError } from "../../src/contracts/errors";
import { addMs, isBefore, now, parseIso, toIso } from "../../src/contracts/clock";
import type {
  AnnotationId,
  ItemId,
  RequestId,
  TokenId,
  UserId,
} from "../../src/contracts/ids";
import {
  asAnnotationId,
  asItemId,
  asRequestId,
  asTokenId,
  asUserId,
  newAnnotationId,
  newItemId,
  newRequestId,
  newTokenId,
  newUserId,
} from "../../src/contracts/ids";
import type {
  Run,
  Transcript,
  TranscriptMap,
} from "../../src/contracts/transcript";
import {
  contentRanges,
  runAt,
  runsInRange,
  sliceText,
  validateMap,
} from "../../src/contracts/transcript";
import type {
  Annotation,
  ApiToken,
  FetchRequest,
  FetchState,
  Item,
  User,
} from "../../src/contracts/item";
import { BLOCKED_URL_PATTERNS, buildArgs, capture } from "../../src/services/acquire";
import {
  assertGolden,
  goldenPath,
  readGolden,
  writeGolden,
} from "../support/goldens";

const repoRoot = join(import.meta.dir, "..", "..");
const syntheticDir = join(repoRoot, "test", "fixtures", "synthetic");

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

async function caughtAsync(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

function makeRun(
  start: number,
  end: number,
  isContent = true,
  documentIndex = 0,
  nodePath = "1/0",
  blockIndex = 0,
): Run {
  return {
    start,
    end,
    doc_index: documentIndex,
    node_path: nodePath,
    block_index: blockIndex,
    is_content: isContent,
  };
}

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ANNOTATION_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const TOKEN_ID = "dddddddd-0000-4000-8000-000000000001";
const REQUEST_ID = "cccccccc-0000-4000-8000-000000000001";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("src/contracts/errors ERROR_CODES", () => {
  test("holds the four codes this milestone adds", () => {
    const codes = ERROR_CODES as readonly string[];
    expect(codes).toContain("WALK_MAP_MALFORMED");
    expect(codes).toContain("ACQUIRE_TOOL_MISSING");
    expect(codes).toContain("ACQUIRE_TIMEOUT");
    expect(codes).toContain("ACQUIRE_FAILED");
  });
});

describe("src/contracts/transcript validateMap", () => {
  function malformed(map: TranscriptMap, textLength: number): AppError {
    const error = caught(() => validateMap(map, textLength));
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe("WALK_MAP_MALFORMED");
    return error as AppError;
  }

  test("accepts a map whose runs tile the text exactly", () => {
    const map: TranscriptMap = {
      runs: [makeRun(0, 5), makeRun(5, 9, false), makeRun(9, 15)],
    };
    expect(() => validateMap(map, 15)).not.toThrow();
  });

  test("accepts a map with one run", () => {
    expect(() => validateMap({ runs: [makeRun(0, 4)] }, 4)).not.toThrow();
  });

  test("throws when the first run does not start at 0", () => {
    const error = malformed({ runs: [makeRun(2, 5), makeRun(5, 10)] }, 10);
    expect(error.context.index).toBe(0);
  });

  test("throws when a gap sits between two runs", () => {
    const error = malformed({ runs: [makeRun(0, 5), makeRun(6, 10)] }, 10);
    expect(error.context.index).toBe(1);
  });

  test("throws when two runs overlap", () => {
    const error = malformed({ runs: [makeRun(0, 6), makeRun(5, 10)] }, 10);
    expect(error.context.index).toBe(1);
  });

  test("throws when the runs are not sorted by start", () => {
    // Run 1 starts at 10 while run 0 ends at 5, and run 2 goes backwards.
    // A left-to-right contiguity check reports index 1. A sort check may
    // report index 2. Either index names a run that breaks the order.
    const error = malformed(
      { runs: [makeRun(0, 5), makeRun(10, 15), makeRun(5, 10)] },
      15,
    );
    expect(typeof error.context.index).toBe("number");
    expect([1, 2].includes(error.context.index as number)).toBe(true);
  });

  test("throws when a run has end equal to start", () => {
    const error = malformed(
      { runs: [makeRun(0, 5), makeRun(5, 5), makeRun(5, 10)] },
      10,
    );
    expect(error.context.index).toBe(1);
  });

  test("throws when a run has end less than start", () => {
    const error = malformed({ runs: [makeRun(0, 5), makeRun(9, 7)] }, 10);
    expect(typeof error.context.index).toBe("number");
    expect(error.context.index).toBe(1);
  });

  test("throws when the last end does not equal textLength", () => {
    const error = malformed({ runs: [makeRun(0, 5), makeRun(5, 10)] }, 12);
    expect(error.context.index).toBe(1);
  });

  // An empty run list tiles an empty text and nothing else. Rules 1 and 4 of
  // `docs/offset-contract.md` cannot both hold for a non-empty text with no
  // runs, so the empty list is valid at length 0 and malformed above it.
  test("accepts an empty run list for an empty text", () => {
    expect(() => validateMap({ runs: [] }, 0)).not.toThrow();
  });

  test("throws for an empty run list when the text is not empty", () => {
    const error = caught(() => validateMap({ runs: [] }, 5));
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe("WALK_MAP_MALFORMED");
  });

  // block_index groups runs into paragraph-sized blocks. Search indexes
  // blocks, so the walker must hand every run the block it belongs to, and
  // the numbers must run forward in reading order.
  test("accepts a map whose block_index rises across the runs", () => {
    const map: TranscriptMap = {
      runs: [
        makeRun(0, 5, true, 0, "1/0", 0),
        makeRun(5, 9, true, 0, "1/1", 0),
        makeRun(9, 15, true, 0, "1/2", 1),
        makeRun(15, 20, true, 0, "1/3", 7),
      ],
    };
    expect(() => validateMap(map, 20)).not.toThrow();
  });

  test("throws when block_index goes backwards", () => {
    const error = malformed(
      {
        runs: [
          makeRun(0, 5, true, 0, "1/0", 0),
          makeRun(5, 10, true, 0, "1/1", 2),
          makeRun(10, 15, true, 0, "1/2", 1),
        ],
      },
      15,
    );
    expect(error.context.index).toBe(2);
  });

  test("throws when block_index is negative", () => {
    const error = malformed(
      { runs: [makeRun(0, 5, true, 0, "1/0", -1)] },
      5,
    );
    expect(error.context.index).toBe(0);
  });

  test("throws when block_index is not an integer", () => {
    const error = malformed(
      {
        runs: [
          makeRun(0, 5, true, 0, "1/0", 0),
          makeRun(5, 10, true, 0, "1/1", 1.5),
        ],
      },
      10,
    );
    expect(error.context.index).toBe(1);
  });
});

describe("src/contracts/transcript runAt", () => {
  const map: TranscriptMap = {
    runs: [makeRun(0, 5), makeRun(5, 10, false), makeRun(10, 20)],
  };

  test("finds the run at a start boundary", () => {
    expect(runAt(map, 0)?.start).toBe(0);
    expect(runAt(map, 10)?.start).toBe(10);
  });

  test("finds the run in the middle of a run", () => {
    const found = runAt(map, 7);
    expect(found?.start).toBe(5);
    expect(found?.end).toBe(10);
  });

  test("finds the run at end minus one", () => {
    expect(runAt(map, 4)?.start).toBe(0);
    expect(runAt(map, 19)?.start).toBe(10);
  });

  test("treats start as inclusive and end as exclusive", () => {
    // Offset 5 is the end of run 0 and the start of run 1. It belongs to run 1.
    const found = runAt(map, 5);
    expect(found?.start).toBe(5);
    expect(found?.end).toBe(10);
  });

  test("returns undefined past the end of the text", () => {
    expect(runAt(map, 20)).toBeUndefined();
    expect(runAt(map, 21)).toBeUndefined();
    expect(runAt(map, 10_000)).toBeUndefined();
  });

  test("returns undefined for a negative offset", () => {
    expect(runAt(map, -1)).toBeUndefined();
    expect(runAt(map, -100)).toBeUndefined();
  });

  test("returns undefined for an empty map", () => {
    expect(runAt({ runs: [] }, 0)).toBeUndefined();
  });

  test("finds the right run in a map of 2000 runs of uneven length", () => {
    // Uneven lengths matter. With equal lengths a wrong binary search can
    // still land on the right run by accident.
    const runs: Run[] = [];
    let offset = 0;
    for (let index = 0; index < 2000; index += 1) {
      const length = 1 + (index % 7);
      runs.push(makeRun(offset, offset + length, index % 3 !== 0, 0, `1/${index}`));
      offset += length;
    }
    const big: TranscriptMap = { runs };
    const textLength = offset;

    expect(() => validateMap(big, textLength)).not.toThrow();
    expect(runs.length).toBeGreaterThan(1000);

    const mismatches: string[] = [];
    for (const expected of runs) {
      for (let probe = expected.start; probe < expected.end; probe += 1) {
        const found = runAt(big, probe);
        if (found?.start !== expected.start || found?.end !== expected.end) {
          mismatches.push(`offset ${probe} found ${found?.start}..${found?.end}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(runAt(big, textLength)).toBeUndefined();
    expect(runAt(big, textLength - 1)?.end).toBe(textLength);
  });
});

describe("src/contracts/transcript runsInRange", () => {
  const map: TranscriptMap = {
    runs: [makeRun(0, 5), makeRun(5, 10), makeRun(10, 15), makeRun(15, 20)],
  };

  test("returns every run the range overlaps, including partial ends", () => {
    const found = runsInRange(map, 3, 12);
    expect(found.map((run) => run.start)).toEqual([0, 5, 10]);
  });

  test("returns the runs a whole-text range covers", () => {
    expect(runsInRange(map, 0, 20).map((run) => run.start)).toEqual([0, 5, 10, 15]);
  });

  test("returns one run for a range inside a single run", () => {
    const found = runsInRange(map, 6, 7);
    expect(found).toHaveLength(1);
    expect(found[0]?.start).toBe(5);
    expect(found[0]?.end).toBe(10);
  });

  test("returns one run for a range that ends on a run boundary", () => {
    // The end is exclusive, so offset 10 does not pull in the third run.
    expect(runsInRange(map, 5, 10).map((run) => run.start)).toEqual([5]);
  });

  test("returns an empty array for a range past the end of the text", () => {
    expect(runsInRange(map, 20, 25)).toEqual([]);
    expect(runsInRange(map, 100, 110)).toEqual([]);
  });
});

describe("src/contracts/transcript contentRanges", () => {
  // Runs 0 and 1 are content and touch. Run 2 is not content. Run 3 is.
  const map: TranscriptMap = {
    runs: [
      makeRun(0, 5, true),
      makeRun(5, 10, true),
      makeRun(10, 15, false),
      makeRun(15, 20, true),
    ],
  };

  test("merges two adjacent content runs into one range", () => {
    expect(contentRanges(map, 0, 10)).toEqual([{ start: 0, end: 10 }]);
  });

  test("splits a range that straddles a non-content run", () => {
    expect(contentRanges(map, 0, 20)).toEqual([
      { start: 0, end: 10 },
      { start: 15, end: 20 },
    ]);
  });

  test("returns an empty array when the range covers only non-content runs", () => {
    expect(contentRanges(map, 10, 15)).toEqual([]);
    expect(contentRanges(map, 11, 14)).toEqual([]);
  });

  test("clips to the requested start and end", () => {
    expect(contentRanges(map, 3, 17)).toEqual([
      { start: 3, end: 10 },
      { start: 15, end: 17 },
    ]);
  });

  test("clips a range that sits inside one content run", () => {
    expect(contentRanges(map, 6, 8)).toEqual([{ start: 6, end: 8 }]);
  });

  test("returns an empty array for a range past the end of the text", () => {
    expect(contentRanges(map, 20, 25)).toEqual([]);
  });
});

describe("src/contracts/transcript sliceText", () => {
  const plain: Transcript = {
    text: "Hello, world",
    map: { runs: [makeRun(0, 7), makeRun(7, 12)] },
  };

  test("returns the exact substring", () => {
    expect(sliceText(plain, 0, 5)).toBe("Hello");
    expect(sliceText(plain, 7, 12)).toBe("world");
    expect(sliceText(plain, 0, plain.text.length)).toBe("Hello, world");
  });

  test("returns an empty string for an empty range", () => {
    expect(sliceText(plain, 3, 3)).toBe("");
  });

  test("counts an astral character as two UTF-16 code units", () => {
    // The grinning face emoji is U+1F600. In UTF-16 it is the surrogate pair
    // D83D DE00, so it takes offsets 1 and 2 of this text.
    const astral: Transcript = {
      text: "a\u{1F600}b",
      map: { runs: [makeRun(0, 4)] },
    };
    expect(astral.text.length).toBe(4);

    expect(sliceText(astral, 1, 3)).toBe("\u{1F600}");
    expect(sliceText(astral, 0, 1)).toBe("a");
    expect(sliceText(astral, 3, 4)).toBe("b");

    // Cutting between the surrogates returns half the pair, not the emoji.
    const half = sliceText(astral, 0, 2);
    expect(half.length).toBe(2);
    expect(half).not.toBe("a\u{1F600}");
    expect(half.charCodeAt(1)).toBe(0xd83d);
  });
});

// These tests use `satisfies` so the type checker proves the shape. There are
// no runtime assertions about the types beyond reading one field back.
describe("src/contracts/item", () => {
  test("Item accepts a full record", () => {
    const item = {
      id: asItemId(ITEM_ID),
      user_id: asUserId(USER_ID),
          url: "https://example.com/post",
      title: "A post",
      author: null,
      created_at: "2026-01-01T00:00:00.000Z",
      ingested_at: "2026-01-01T00:01:00.000Z",
    } satisfies Item;
  });

  test("Annotation accepts a full record", () => {
    const annotation = {
      id: asAnnotationId(ANNOTATION_ID),
      user_id: asUserId(USER_ID),
      item_id: asItemId(ITEM_ID),
      start_offset: 10,
      end_offset: 24,
      quote: "a quoted span",
      note: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
    } satisfies Annotation;
    expect(annotation.end_offset).toBe(24);
  });

  test("User accepts a full record", () => {
    const user = {
      id: asUserId(USER_ID),
      subject: "oidc-subject",
      email: null,
      created_at: "2026-01-01T00:00:00.000Z",
    } satisfies User;
    expect(user.subject).toBe("oidc-subject");
  });

  test("ApiToken accepts a full record", () => {
    const token = {
      id: asTokenId(TOKEN_ID),
      user_id: asUserId(USER_ID),
      name: "laptop",
      token_hash: "0".repeat(64),
      created_at: "2026-01-01T00:00:00.000Z",
      last_used_at: null,
    } satisfies ApiToken;
    expect(token.name).toBe("laptop");
  });

  test("FetchRequest accepts a full record", () => {
    const request = {
      id: asRequestId(REQUEST_ID),
      user_id: asUserId(USER_ID),
      item_id: null,
      url: "https://example.com/post",
      state: "queued",
      lease_expires_at: null,
      attempts: 0,
      error_code: null,
      created_at: "2026-01-01T00:00:00.000Z",
    } satisfies FetchRequest;
    expect(request.state).toBe("queued");
  });
});

describe("src/contracts/ids", () => {
  // The brand exists only at compile time, so the runtime value is the
  // string itself. The type stops one id being passed where another belongs,
  // which the UUID check cannot do: both values are valid UUIDs.
  test("each as* returns the value it was given", () => {
    // String() strips the brand, which lives only in the type system, so the
    // comparison is between two plain strings.
    expect(String(asUserId(USER_ID))).toBe(USER_ID);
    expect(String(asItemId(ITEM_ID))).toBe(ITEM_ID);
    expect(String(asAnnotationId(ANNOTATION_ID))).toBe(ANNOTATION_ID);
    expect(String(asTokenId(TOKEN_ID))).toBe(TOKEN_ID);
    expect(String(asRequestId(REQUEST_ID))).toBe(REQUEST_ID);
    expect(typeof asUserId(USER_ID)).toBe("string");
  });

  test("each as* throws STORE_INVALID_PATH for a value that is not a UUID", () => {
    const bad = [
      "",
      "alice",
      "..",
      "../../etc/passwd",
      "AAAAAAAA-0000-4000-8000-000000000001",
      "aaaaaaaa-0000-4000-8000-00000000000g",
      `${ITEM_ID}/`,
      ITEM_ID.slice(0, 35),
    ];
    const constructors = [
      asUserId,
      asItemId,
      asAnnotationId,
      asTokenId,
      asRequestId,
    ];
    for (const construct of constructors) {
      for (const value of bad) {
        const error = caught(() => construct(value));
        expect(isAppError(error)).toBe(true);
        expect((error as AppError).code).toBe("STORE_INVALID_PATH");
      }
    }
  });

  test("each new* mints a fresh lowercase UUID", () => {
    const minted = [
      newUserId(),
      newItemId(),
      newAnnotationId(),
      newTokenId(),
      newRequestId(),
    ];
    for (const value of minted) {
      expect(value).toMatch(UUID_PATTERN);
    }
    expect(new Set(minted).size).toBe(minted.length);
    expect(newUserId()).not.toBe(newUserId());
  });

  test("a minted id passes its own as* unchanged", () => {
    const minted = newItemId();
    expect(String(asItemId(minted))).toBe(String(minted));
  });

  // This test fails to compile if the brands go away, which is the point of
  // them. Removing the brand turns the suppressed error into an unused
  // directive, and tsc reports that.
  test("one brand is not another", () => {
    // @ts-expect-error a UserId may not stand in for an ItemId.
    const wrong: ItemId = asUserId(USER_ID);
    expect(String(wrong)).toBe(USER_ID);

    // @ts-expect-error a plain string may not stand in for a UserId.
    const untrusted: UserId = String(USER_ID);
    expect(String(untrusted)).toBe(USER_ID);

    const annotation: AnnotationId = asAnnotationId(ANNOTATION_ID);
    const token: TokenId = asTokenId(TOKEN_ID);
    const request: RequestId = asRequestId(REQUEST_ID);
    expect([annotation, token, request]).toHaveLength(3);
  });
});

describe("src/contracts/clock", () => {
  // The clock is the one place the system may read real time, so these five
  // functions are the whole API. Everything else takes a Date.
  test("now returns the current time as a Date", () => {
    const before = Date.now();
    const value = now();
    const after = Date.now();
    expect(value).toBeInstanceOf(Date);
    expect(value.getTime()).toBeGreaterThanOrEqual(before);
    expect(value.getTime()).toBeLessThanOrEqual(after);
  });

  test("addMs returns a new Date and leaves the base alone", () => {
    const base = new Date("2026-02-01T00:00:00.000Z");
    const later = addMs(base, 90_000);
    expect(later.toISOString()).toBe("2026-02-01T00:01:30.000Z");
    expect(base.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(later).not.toBe(base);
    expect(addMs(base, -1_000).toISOString()).toBe("2026-01-31T23:59:59.000Z");
    expect(addMs(base, 0).getTime()).toBe(base.getTime());
  });

  test("toIso writes UTC with milliseconds", () => {
    expect(toIso(new Date("2026-02-01T00:00:00.000Z"))).toBe(
      "2026-02-01T00:00:00.000Z",
    );
    expect(toIso(new Date(0))).toBe("1970-01-01T00:00:00.000Z");
  });

  test("parseIso round-trips toIso", () => {
    const value = new Date("2026-02-01T12:34:56.789Z");
    expect(parseIso(toIso(value)).getTime()).toBe(value.getTime());
  });

  test("parseIso throws CONFIG_INVALID_VALUE for a string it cannot read", () => {
    for (const value of ["", "yesterday", "2026-13-45T00:00:00.000Z"]) {
      const error = caught(() => parseIso(value));
      expect(isAppError(error)).toBe(true);
      expect((error as AppError).code).toBe("CONFIG_INVALID_VALUE");
    }
  });

  test("isBefore compares two Dates and is false at equality", () => {
    const early = new Date("2026-02-01T00:00:00.000Z");
    const late = new Date("2026-02-01T00:00:00.001Z");
    expect(isBefore(early, late)).toBe(true);
    expect(isBefore(late, early)).toBe(false);
    expect(isBefore(early, new Date(early.getTime()))).toBe(false);
  });
});

describe("src/services/acquire BLOCKED_URL_PATTERNS", () => {
  test("is a non-empty array of strings", () => {
    expect(Array.isArray(BLOCKED_URL_PATTERNS)).toBe(true);
    expect(BLOCKED_URL_PATTERNS.length).toBeGreaterThan(0);
    for (const pattern of BLOCKED_URL_PATTERNS) {
      expect(typeof pattern).toBe("string");
      expect(pattern.length).toBeGreaterThan(0);
    }
  });

  test("every entry compiles as a regular expression", () => {
    for (const pattern of BLOCKED_URL_PATTERNS) {
      expect(() => new RegExp(pattern)).not.toThrow();
    }
  });
});

describe("src/services/acquire buildArgs", () => {
  const url = "https://example.com/article";
  const outputPath = "/tmp/commonplace-test/capture.html";
  const browserPath = "/usr/bin/chromium";

  test("puts the url before the output path", () => {
    const args = buildArgs({ url, outputPath, browserPath });
    expect(args).toContain(url);
    expect(args).toContain(outputPath);
    expect(args.indexOf(url)).toBeLessThan(args.indexOf(outputPath));
  });

  test("passes the output path as a positional argument, not a flag value", () => {
    const args = buildArgs({ url, outputPath, browserPath });
    const outputIndex = args.indexOf(outputPath);
    expect(outputIndex).toBeGreaterThan(0);

    // The tool's usage is `single-file <url> <output>`, so the argument in
    // front of the output path is the url, never a flag.
    const before = args[outputIndex - 1] ?? "";
    expect(before.startsWith("-")).toBe(false);
    expect(before).toBe(url);

    expect(args).not.toContain("--output");
    expect(args).not.toContain("--output-path");
    expect(args).not.toContain("--filename-template");
  });

  test("always passes the configured browser path", () => {
    const args = buildArgs({ url, outputPath, browserPath });
    const flagIndex = args.indexOf("--browser-executable-path");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe(browserPath);
    expect(
      args.filter((arg) => arg === "--browser-executable-path"),
    ).toHaveLength(1);
  });

  test("repeats --blocked-url-pattern once per pattern with its value", () => {
    const args = buildArgs({ url, outputPath, browserPath });
    const flags = args.filter((arg) => arg === "--blocked-url-pattern");
    expect(flags).toHaveLength(BLOCKED_URL_PATTERNS.length);

    for (const pattern of BLOCKED_URL_PATTERNS) {
      const valueIndex = args.indexOf(pattern);
      expect(valueIndex).toBeGreaterThan(0);
      expect(args[valueIndex - 1]).toBe("--blocked-url-pattern");
    }
  });

  test("uses the exact lowercase flag spellings", () => {
    const args = buildArgs({ url, outputPath, browserPath });
    const joined = args.join(" ");

    expect(joined).toContain("--blocked-url-pattern");
    expect(joined).toContain("--browser-executable-path");

    // These spellings are wrong according to the capture tool's interface.
    // read them from the tool's own `options.js` at version 2.1.3.
    expect(joined).not.toContain("--blocked-URL-pattern");
    expect(joined).not.toContain("--blocked-url-patterns");
    expect(joined).not.toContain("--blockedURLPatterns");
    expect(joined).not.toContain("--browser-path");
    expect(joined).not.toContain("--browserExecutablePath");

    // `--browser-executable` is checked as a whole argument, not a substring.
    // The correct flag, `--browser-executable-path`, contains it.
    expect(args).not.toContain("--browser-executable");
  });
});

describe("src/services/acquire capture", () => {
  // Only the missing-binary path runs here. A real capture starts Chromium and
  // fetches a page, which needs a browser and the network. Milestone 1 does not
  // test that, and neither does any later acceptance test in this repo.
  test("throws ACQUIRE_TOOL_MISSING when the binary is not on PATH", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "commonplace-no-binary-"));
    const originalPath = process.env.PATH;
    let error: unknown;
    try {
      process.env.PATH = emptyDir;
      error = await caughtAsync(() =>
        capture({
          url: "https://example.com/article",
          outputPath: join(emptyDir, "capture.html"),
          browserPath: "/usr/bin/chromium",
          timeoutMs: 5_000,
        }),
      );
    } finally {
      process.env.PATH = originalPath;
      await rm(emptyDir, { recursive: true, force: true });
    }

    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe("ACQUIRE_TOOL_MISSING");
  }, 30_000);
});

describe("test/support/goldens", () => {
  const scratchFixtures: string[] = [];
  const letters = "abcdefghijklmnopqrstuvwxyz";
  let originalUpdate: string | undefined;

  function scratchFixture(): string {
    const name = `scratch-golden-${letters[scratchFixtures.length] ?? "z"}`;
    scratchFixtures.push(name);
    return name;
  }

  beforeAll(() => {
    originalUpdate = process.env.UPDATE_GOLDENS;
  });

  beforeEach(() => {
    delete process.env.UPDATE_GOLDENS;
  });

  afterAll(async () => {
    if (originalUpdate === undefined) {
      delete process.env.UPDATE_GOLDENS;
    } else {
      process.env.UPDATE_GOLDENS = originalUpdate;
    }
    for (const fixture of scratchFixtures) {
      await rm(join(syntheticDir, fixture), { recursive: true, force: true });
    }
  });

  test("goldenPath points inside the fixture directory", () => {
    expect(goldenPath("blocks", "transcript.txt")).toBe(
      join(syntheticDir, "blocks", "transcript.txt"),
    );
  });

  test("readGolden returns null when the golden does not exist", async () => {
    expect(await readGolden(scratchFixture(), "transcript.txt")).toBeNull();
  });

  test("writeGolden creates the file and readGolden reads it back", async () => {
    const fixture = scratchFixture();
    await writeGolden(fixture, "transcript.txt", "one\ntwo\n");
    expect(existsSync(goldenPath(fixture, "transcript.txt"))).toBe(true);
    expect(await readGolden(fixture, "transcript.txt")).toBe("one\ntwo\n");
  });

  test("assertGolden passes when the text matches", async () => {
    const fixture = scratchFixture();
    await writeGolden(fixture, "transcript.txt", "one\ntwo\nthree\n");

    await assertGolden(fixture, "transcript.txt", "one\ntwo\nthree\n");
    expect(await readGolden(fixture, "transcript.txt")).toBe("one\ntwo\nthree\n");
  });

  test("assertGolden fails and names the first differing line number", async () => {
    const fixture = scratchFixture();
    await writeGolden(fixture, "transcript.txt", "one\ntwo\nthree\n");

    const error = await caughtAsync(() =>
      assertGolden(fixture, "transcript.txt", "one\nWRONG\nthree\n"),
    );
    const message = error instanceof Error ? error.message : String(error);

    expect(message).toMatch(/line 2\b/);
    expect(message).toContain("two");
    expect(message).toContain("WRONG");
    expect(message).toContain(goldenPath(fixture, "transcript.txt"));
  });

  test("assertGolden fails when the golden is missing", async () => {
    const fixture = scratchFixture();
    const error = await caughtAsync(() =>
      assertGolden(fixture, "transcript.txt", "anything\n"),
    );
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain(goldenPath(fixture, "transcript.txt"));
    expect(existsSync(goldenPath(fixture, "transcript.txt"))).toBe(false);
  });

  test("UPDATE_GOLDENS=1 writes the golden instead of comparing", async () => {
    const fixture = scratchFixture();
    await writeGolden(fixture, "transcript.txt", "old\n");

    process.env.UPDATE_GOLDENS = "1";
    try {
      await assertGolden(fixture, "transcript.txt", "new\ntext\n");
    } finally {
      delete process.env.UPDATE_GOLDENS;
    }

    expect(await readGolden(fixture, "transcript.txt")).toBe("new\ntext\n");
  });

  test("UPDATE_GOLDENS=1 writes a golden that does not exist yet", async () => {
    const fixture = scratchFixture();
    process.env.UPDATE_GOLDENS = "1";
    try {
      await assertGolden(fixture, "transcript.txt", "fresh\n");
    } finally {
      delete process.env.UPDATE_GOLDENS;
    }
    expect(await readGolden(fixture, "transcript.txt")).toBe("fresh\n");
  });
});

describe("test/fixtures/synthetic", () => {
  const fixtures = [
    "blocks.html",
    "inline.html",
    "pre.html",
    "entities.html",
    "astral.html",
    "rtl.html",
    "table.html",
    "void.html",
  ];

  // Fixture content is checked by the walker tests.
  for (const name of fixtures) {
    test(`${name} exists and parses as HTML with a non-empty body`, async () => {
      const path = join(syntheticDir, name);
      expect(existsSync(path)).toBe(true);

      const html = await Bun.file(path).text();
      let sawBody = false;
      let bodyText = "";
      await new HTMLRewriter()
        .on("body", {
          element() {
            sawBody = true;
          },
          text(chunk) {
            bodyText += chunk.text;
          },
        })
        .transform(new Response(html))
        .text();

      expect(sawBody).toBe(true);
      expect(bodyText.trim().length).toBeGreaterThan(0);
    });
  }
});

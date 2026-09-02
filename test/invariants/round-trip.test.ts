import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { newAnnotationId } from "../../src/contracts/ids";
import type { TranscriptMap } from "../../src/contracts/transcript";
import { project } from "../../src/core/project";
import { sanitize } from "../../src/core/sanitize";
import { walk } from "../../src/core/walk";
import { checkRoundTrip } from "./lib";

const syntheticDir = join(import.meta.dir, "..", "fixtures", "synthetic");

const FIXTURES = [
  "blocks",
  "inline",
  "pre",
  "entities",
  "astral",
  "rtl",
  "table",
  "void",
  "boilerplate",
  "hostile",
];

const MARK = newAnnotationId();

// One range per content run, plus a few partial ones, plus the whole
// document. The partials matter most: a projection that splits a run at a
// highlight edge is where an off-by-one hides.
function rangesOf(
  map: TranscriptMap,
  length: number,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [
    { start: 0, end: length },
  ];
  for (const run of map.runs) {
    if (!run.is_content) continue;
    const middle = Math.floor((run.start + run.end) / 2);
    ranges.push(
      { start: run.start, end: run.end },
      { start: run.start, end: run.start + 1 },
      { start: run.start + 1, end: run.end },
      { start: middle, end: run.end },
      { start: run.start, end: run.end + 3 },
    );
  }
  return ranges.filter((range) => range.end > range.start);
}

describe("round-trip invariant", () => {
  for (const name of FIXTURES) {
    test(`${name} projects every range back to its transcript slice`, () => {
      const sanitized = sanitize(
        readFileSync(join(syntheticDir, `${name}.html`), "utf8"),
      );
      const { text, map } = walk(sanitized);

      const violations = checkRoundTrip(
        name,
        text,
        map,
        rangesOf(map, text.length),
        (range) =>
          project({
            sanitizedHtml: sanitized,
            transcript: text,
            map,
            highlights: [{ id: MARK, start: range.start, end: range.end }],
          }),
      );
      expect(violations).toEqual([]);
    });
  }

  test("checkRoundTrip catches a projection that drops a character", () => {
    const transcript = "one two three";
    const map: TranscriptMap = {
      runs: [
        {
          start: 0,
          end: transcript.length,
          doc_index: 0,
          node_path: "1/0/0",
          block_index: 0,
          is_content: true,
        },
      ],
    };

    const violations = checkRoundTrip(
      "truncating",
      transcript,
      map,
      [{ start: 0, end: 7 }],
      (range) =>
        `<p><mark data-cp-annotation="${MARK}">${transcript.slice(
          range.start,
          range.end - 1,
        )}</mark></p>`,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]!.expected).toBe("one two");
    expect(violations[0]!.got).toBe("one tw");
  });

  test("checkRoundTrip catches a projection that renders non-content text", () => {
    const transcript = "body nav";
    const map: TranscriptMap = {
      runs: [
        {
          start: 0,
          end: 5,
          doc_index: 0,
          node_path: "1/0/0",
          block_index: 0,
          is_content: true,
        },
        {
          start: 5,
          end: 8,
          doc_index: 0,
          node_path: "1/1/0",
          block_index: 1,
          is_content: false,
        },
      ],
    };

    const violations = checkRoundTrip(
      "leaking",
      transcript,
      map,
      [{ start: 0, end: 8 }],
      () => `<p><mark data-cp-annotation="${MARK}">body nav</mark></p>`,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]!.expected).toBe("body ");
    expect(violations[0]!.got).toBe("body nav");
  });
});

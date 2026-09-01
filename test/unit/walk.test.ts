import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { TranscriptMap } from "../../src/contracts/transcript";
import { ALLOWED_TAGS, sanitize } from "../../src/core/sanitize";
import { BLOCK_ELEMENTS, walk } from "../../src/core/walk";
import { assertGolden } from "../support/goldens";

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

function serializeMap(map: TranscriptMap): string {
  return map.runs
    .map((run) =>
      JSON.stringify({
        start: run.start,
        end: run.end,
        doc_index: run.doc_index,
        block_index: run.block_index,
        node_path: run.node_path,
        is_content: run.is_content,
      }),
    )
    .join("\n");
}

describe("block list agreement", () => {
  test("every block element is in the sanitizer allow-list", () => {
    for (const tag of BLOCK_ELEMENTS) {
      expect(ALLOWED_TAGS).toContain(tag);
    }
  });
});

describe("break resets to line start", () => {
  test("whitespace after a break is dropped", () => {
    const transcript = walk(sanitize("<p>a<br> b</p>"));
    expect(transcript.text).toBe("a\nb");
  });

  test("a leading break drops the whitespace before the first word", () => {
    const transcript = walk(sanitize("<p><br> b</p>"));
    expect(transcript.text).toBe("b");
  });

  test("two adjacent breaks produce two newlines", () => {
    const transcript = walk(sanitize("<p>a<br><br>b</p>"));
    expect(transcript.text).toBe("a\n\nb");
  });

  test("a break with no adjacent whitespace still separates lines", () => {
    const transcript = walk(sanitize("<p>a<br>b</p>"));
    expect(transcript.text).toBe("a\nb");
  });
});

describe("walk goldens", () => {
  for (const name of FIXTURES) {
    test(`${name} matches its transcript and map goldens`, async () => {
      const source = readFileSync(join(syntheticDir, `${name}.html`), "utf8");
      const transcript = walk(sanitize(source));
      await assertGolden(name, "transcript.txt", transcript.text);
      await assertGolden(name, "map.json", serializeMap(transcript.map));
    });
  }
});

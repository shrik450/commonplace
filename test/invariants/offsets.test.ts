import { describe, expect, test } from "bun:test";
import type { Run } from "../../src/contracts/transcript";
import { checkOffsets } from "./lib";
import { readGolden } from "../support/goldens";

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

async function parsedGolden(name: string): Promise<{ text: string; runs: Run[] }> {
  const text = await readGolden(name, "transcript.txt");
  const raw = await readGolden(name, "map.json");
  if (text === null || raw === null) {
    throw new Error(`goldens for ${name} are missing; write them first`);
  }
  const runs = raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Run);
  return { text, runs };
}

describe("offsets invariant", () => {
  test("the real goldens tile their transcripts exactly", async () => {
    for (const name of FIXTURES) {
      const { text, runs } = await parsedGolden(name);
      expect(checkOffsets(text, runs)).toEqual([]);
    }
  });

  test("checkOffsets flags maps that do not tile the transcript", () => {
    const cases: Array<{
      name: string;
      transcript: string;
      runs: Array<{ start: number; end: number }>;
    }> = [
      {
        name: "runs leave a gap",
        transcript: "abcd",
        runs: [
          { start: 0, end: 1 },
          { start: 2, end: 4 },
        ],
      },
      {
        name: "runs overlap",
        transcript: "abcd",
        runs: [
          { start: 0, end: 3 },
          { start: 2, end: 4 },
        ],
      },
      {
        name: "runs do not start at zero",
        transcript: "abcd",
        runs: [{ start: 1, end: 4 }],
      },
      {
        name: "runs end short of the transcript",
        transcript: "abcd",
        runs: [{ start: 0, end: 3 }],
      },
      {
        name: "a run is degenerate",
        transcript: "abcd",
        runs: [
          { start: 0, end: 2 },
          { start: 2, end: 2 },
          { start: 2, end: 4 },
        ],
      },
      {
        name: "an empty map covers a non-empty transcript",
        transcript: "abcd",
        runs: [],
      },
    ];
    for (const { name, transcript, runs } of cases) {
      const violations = checkOffsets(transcript, runs);
      expect(violations.length, name).toBeGreaterThan(0);
      for (const violation of violations) {
        expect(violation.rule).toBe("offsets");
      }
    }
  });
});

import { describe, expect, test } from "bun:test";
import {
  parseOxlintOutput,
  parseTscOutput,
  reconcileCount,
  reconcileTest,
} from "../../scripts/verify";

describe("reconcileCount", () => {
  test("reports 1 error when the tool crashes with unrecognized output", () => {
    const output = "Internal compiler error: out of memory";
    const parsed = parseTscOutput(output);
    expect(parsed).toEqual({ errors: 0 });
    expect(reconcileCount(parsed, 2, output)).toEqual({ errors: 1 });
  });

  test("keeps the parsed count when the parser recognized errors", () => {
    const output = [
      "src/x.ts(1,1): error TS2322: nope.",
      "Found 1 error in src/x.ts:1",
      "",
    ].join("\n");
    expect(reconcileCount(parseTscOutput(output), 2, output)).toEqual({
      errors: 1,
    });
  });

  test("trusts zero errors when a recognized summary line explains the non-zero exit", () => {
    // oxlint exits non-zero when it reports warnings with zero errors, and
    // its summary line is present in that case.
    const output = "Found 3 warnings and 0 errors.\nFinished in 24ms on 42 files.\n";
    expect(reconcileCount(parseOxlintOutput(output), 1, output)).toEqual({
      errors: 0,
    });
  });

  test("passes a clean run through unchanged", () => {
    expect(reconcileCount({ errors: 0 }, 0, "")).toEqual({ errors: 0 });
  });

  test("counts diagnostic lines when oxlint prints no summary line", () => {
    // oxlint 1.79.0 in a pipe prints only diagnostic lines and exits 1.
    const output = [
      "src/web/server.ts:9:3: error eslint(no-debugger): `debugger` statement is not allowed.",
      "src/cli/main.ts:20:5: error eslint(no-dupe-keys): Duplicate key 'ok'.",
    ].join("\n");
    expect(parseOxlintOutput(output)).toEqual({ errors: 2 });
    expect(reconcileCount(parseOxlintOutput(output), 1, output)).toEqual({
      errors: 2,
    });
  });
});

describe("reconcileTest", () => {
  test("reports a failure when bun test crashes with unrecognized output", () => {
    const result = reconcileTest({ pass: 0, fail: 0, failures: [] }, 2);
    expect(result.fail).toBe(1);
    expect(result.pass).toBe(0);
    expect(result.failures[0]).toContain("bun test exited 2");
  });

  test("keeps parsed failures", () => {
    const parsed = { pass: 1, fail: 2, failures: ["a > b", "c > d"] };
    expect(reconcileTest(parsed, 1)).toEqual(parsed);
  });

  test("passes a clean run through unchanged", () => {
    expect(reconcileTest({ pass: 5, fail: 0, failures: [] }, 0)).toEqual({
      pass: 5,
      fail: 0,
      failures: [],
    });
  });
});

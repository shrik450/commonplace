import { existsSync } from "node:fs";
import { join } from "node:path";

export type VerifySummary = {
  ok: boolean;
  typecheck: { errors: number };
  lint: { errors: number };
  test: { pass: number; fail: number; failures: string[] };
};

export function buildSummary(parts: Omit<VerifySummary, "ok">): VerifySummary {
  const ok =
    parts.typecheck.errors === 0 &&
    parts.lint.errors === 0 &&
    parts.test.fail === 0;
  return { ok, ...parts };
}

export function parseTscOutput(text: string): { errors: number } {
  return { errors: (text.match(/:\s+error TS\d+:/g) ?? []).length };
}

const RECOGNIZED_SUMMARY =
  /Found\s+\d+\s+warnings?\s+and\s+(\d+)\s+errors?/;

export function parseOxlintOutput(text: string): { errors: number } {
  const match = text.match(RECOGNIZED_SUMMARY);
  if (match) return { errors: Number(match[1]) };
  // oxlint 1.79.0 omits its summary when output goes through a pipe. Count its
  // per-diagnostic lines instead.
  return {
    errors: (text.match(/^\S+:\d+:\d+: error /gm) ?? []).length,
  };
}

// Require both a successful exit and zero parsed errors. oxlint is the only
// exception because warnings produce a nonzero exit with a valid summary. If
// another nonzero result contains no parsed errors, report one error because
// the tool might have crashed or changed its output format.
export function reconcileCount(
  parsed: { errors: number },
  exitCode: number,
  output: string,
): { errors: number } {
  if (exitCode === 0 || parsed.errors > 0) return parsed;
  if (RECOGNIZED_SUMMARY.test(output)) return parsed;
  return { errors: 1 };
}

// Require a parsed failure for every nonzero `bun test` exit. Otherwise,
// report one failure because the runner might have stopped early or changed
// its output format.
export function reconcileTest(
  parsed: { pass: number; fail: number; failures: string[] },
  exitCode: number,
): { pass: number; fail: number; failures: string[] } {
  if (exitCode === 0 || parsed.fail > 0) return parsed;
  return {
    pass: parsed.pass,
    fail: 1,
    failures: [`bun test exited ${exitCode} with unrecognized output`],
  };
}

export function parseBunTestOutput(text: string): {
  pass: number;
  fail: number;
  failures: string[];
} {
  const pass = Number(text.match(/^\s*(\d+)\s+pass\s*$/m)?.[1] ?? 0);
  const fail = Number(text.match(/^\s*(\d+)\s+fail\s*$/m)?.[1] ?? 0);
  const failures: string[] = [];
  for (const match of text.matchAll(
    /^\s*\(fail\)\s+(.*?)\s+\[\d+(?:\.\d+)?ms\]\s*$/gm,
  )) {
    failures.push(match[1]!);
  }
  return { pass, fail, failures };
}

const repoRoot = join(import.meta.dir, "..");
const bin = (name: string) => join(repoRoot, "node_modules", ".bin", name);

type Run = { code: number; stdout: string; stderr: string };

async function run(cmd: string[]): Promise<Run> {
  try {
    const proc = Bun.spawn({
      cmd,
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  } catch (error) {
    // Represent spawn failures as exit code 127 so the reconciliation step
    // reports a failed check instead of an unhandled rejection.
    const message = error instanceof Error ? error.message : String(error);
    return { code: 127, stdout: "", stderr: message };
  }
}

type CountStep = { errors: number; raw?: string };
type TestStep = {
  pass: number;
  fail: number;
  failures: string[];
  raw?: string;
};

const TEST_TARGETS = ["test/acceptance", "test/invariants", "test/unit"];

async function typecheck(): Promise<CountStep> {
  const result = await run([bin("tsc"), "--noEmit"]);
  const output = `${result.stdout}\n${result.stderr}`;
  const value = reconcileCount(parseTscOutput(output), result.code, output);
  return { errors: value.errors, raw: value.errors > 0 ? output : undefined };
}

async function lint(): Promise<CountStep> {
  const result = await run([bin("oxlint")]);
  const output = `${result.stdout}\n${result.stderr}`;
  const value = reconcileCount(parseOxlintOutput(output), result.code, output);
  return { errors: value.errors, raw: value.errors > 0 ? output : undefined };
}

async function test(): Promise<TestStep> {
  const missing = TEST_TARGETS.filter(
    (target) => !existsSync(join(repoRoot, target)),
  );
  if (missing.length > 0) {
    // Fail before running tests if a configured test directory is missing.
    return {
      pass: 0,
      fail: missing.length,
      failures: missing.map((target) => `missing test target ${target}`),
    };
  }
  const result = await run(["bun", "test", ...TEST_TARGETS]);
  const output = `${result.stdout}\n${result.stderr}`;
  const value = reconcileTest(parseBunTestOutput(output), result.code);
  if (value.pass === 0 && value.fail === 0) {
    // Treat an empty test run as a failure.
    return {
      pass: 0,
      fail: 1,
      failures: ["bun test ran no tests"],
      raw: output,
    };
  }
  return { ...value, raw: value.fail > 0 ? output : undefined };
}

async function orchestrate(): Promise<{
  summary: VerifySummary;
  failingToolOutput: string[];
}> {
  const [typecheckStep, lintStep, testStep] = await Promise.all([
    typecheck(),
    lint(),
    test(),
  ]);
  const summary = buildSummary({
    typecheck: { errors: typecheckStep.errors },
    lint: { errors: lintStep.errors },
    test: {
      pass: testStep.pass,
      fail: testStep.fail,
      failures: testStep.failures,
    },
  });
  const failingToolOutput = [
    typecheckStep.raw,
    lintStep.raw,
    testStep.raw,
  ].filter((value): value is string => value !== undefined);
  return { summary, failingToolOutput };
}

if (import.meta.main) {
  const isJson = process.argv.includes("--json");
  const { summary, failingToolOutput } = await orchestrate();

  if (isJson) {
    console.log(JSON.stringify(summary));
  } else {
    console.log(`typecheck: ${summary.typecheck.errors} error(s)`);
    console.log(`lint: ${summary.lint.errors} error(s)`);
    console.log(`test: ${summary.test.pass} pass, ${summary.test.fail} fail`);
    for (const name of summary.test.failures) console.log(`  FAIL ${name}`);
    console.log(`ok: ${summary.ok}`);
  }

  // Keep stdout to one JSON line in `--json` mode. Write diagnostic tool output
  // to stderr.
  for (const raw of failingToolOutput) console.error(raw);

  process.exit(summary.ok ? 0 : 1);
}

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
  // oxlint 1.79.0 in a pipe prints no summary line, only per-diagnostic
  // lines like "src/x.ts:1:1: error eslint(...): ...". Count those.
  return {
    errors: (text.match(/^\S+:\d+:\d+: error /gm) ?? []).length,
  };
}

// A step passes only when the tool exits 0 and the parser finds nothing to
// count. When the exit code and the parse disagree, fail closed. The one
// exception: oxlint exits non-zero when it reports warnings even with zero
// errors. In that case its output holds a recognized summary line, so the
// parsed zero is trustworthy. Any other non-zero exit with zero parsed
// errors means the tool crashed or printed something we cannot read, so we
// report one error rather than a clean pass.
export function reconcileCount(
  parsed: { errors: number },
  exitCode: number,
  output: string,
): { errors: number } {
  if (exitCode === 0 || parsed.errors > 0) return parsed;
  if (RECOGNIZED_SUMMARY.test(output)) return parsed;
  return { errors: 1 };
}

// Same fail-closed rule for the test step. bun test exits non-zero when
// anything fails, so parsed failures already explain a non-zero exit. A
// non-zero exit with zero parsed failures means the runner died mid-run or
// printed output we cannot parse, and a clean pass would be a lie.
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
    // A missing binary or a spawn failure must reach the reconcilers, not
    // escape as an unhandled rejection. Exit 127 with empty output parses
    // as zero everywhere, so the reconcilers fail the step.
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
    // Insurance against bun test silently scanning nothing one day.
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
    // A suite that ran nothing is not a suite that passed.
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

  // Keep stdout to a single JSON line in --json mode; send the raw output of
  // any failing tool to stderr so a failure names itself.
  for (const raw of failingToolOutput) console.error(raw);

  process.exit(summary.ok ? 0 : 1);
}

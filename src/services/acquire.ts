import { stat } from "node:fs/promises";
import { AppError } from "../contracts/errors";

// Regular expressions for hosts that serve ads or consent modals. The values
// are regexes, not globs. Keep this list small and obvious; grow it from real
// captures.
export const BLOCKED_URL_PATTERNS: readonly string[] = [
  // Google Analytics and Google Ads.
  "google-analytics\\.com",
  "googlesyndication\\.com",
  "doubleclick\\.net",

  // Consent and cookie modals.
  "cookiebot\\.com",
  "onetrust\\.com",
  "sourcepoint\\.com",

  // Common ad networks.
  "googletagmanager\\.com",
  "facebook\\.net",
];

export type CaptureRequest = {
  url: string;
  outputPath: string;
  binaryPath?: string;
  browserPath?: string;
  timeoutMs?: number; // default 120000
};

export type CaptureResult = { path: string; bytes: number };

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_CAPTURE_BYTES = 512;

// The npm package is "single-file-cli"; the binary it puts on PATH is
// "single-file". Both lookup sites use this one constant.
export const SINGLE_FILE_BINARY = "single-file";

export function buildArgs(request: CaptureRequest): string[] {
  const args: string[] = [];
  for (const pattern of BLOCKED_URL_PATTERNS) {
    args.push("--blocked-url-pattern", pattern);
  }
  if (request.browserPath !== undefined) {
    args.push("--browser-executable-path", request.browserPath);
  }
  args.push(request.url, request.outputPath);
  return args;
}

async function outputBytes(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

function killProcessTree(pid: number): void {
  // A negative pid signals the whole process group, which is how a browser
  // child dies with its parent instead of surviving it.
  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // fall through to the single-process kill
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // the process already exited
  }
}

export async function capture(request: CaptureRequest): Promise<CaptureResult> {
  // Bun.which caches the PATH it first saw, so a test that changes PATH after
  // any earlier which() call would resolve a stale binary here. Pass the
  // current PATH so the lookup is always fresh.
  const binaryPath =
    request.binaryPath ??
    Bun.which(SINGLE_FILE_BINARY, { PATH: process.env.PATH });
  if (!binaryPath) {
    throw new AppError(
      "ACQUIRE_TOOL_MISSING",
      `the ${SINGLE_FILE_BINARY} binary is not on PATH`,
    );
  }

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = buildArgs(request);

  // detached puts the child in its own process group, so the timeout can kill
  // the whole tree. stdout is discarded so a chatty tool cannot fill the pipe
  // and block itself.
  const proc = Bun.spawn([binaryPath, ...args], {
    stdout: "ignore",
    stderr: "pipe",
    detached: true,
  });

  // The timer must never fire after the process has exited, or it would kill
  // whatever process id the OS hands out next. Clear it on exit and again in
  // finally, so no path leaves it pending.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      killProcessTree(proc.pid);
      resolve(null);
    }, timeoutMs);
  });
  void proc.exited.then(() => {
    if (timer !== undefined) clearTimeout(timer);
  });

  try {
    const outcome = await Promise.race([
      Promise.all([proc.exited, new Response(proc.stderr).text()]).then(
        ([exitCode, stderr]) => ({ exitCode, stderr }),
      ),
      timedOutPromise,
    ]);

    if (outcome === null) {
      throw new AppError(
        "ACQUIRE_TIMEOUT",
        `capture exceeded ${timeoutMs} ms`,
        { timeout_ms: timeoutMs },
      );
    }
    const { exitCode, stderr } = outcome;
    if (exitCode !== 0) {
      throw new AppError(
        "ACQUIRE_FAILED",
        `${SINGLE_FILE_BINARY} exited with code ${exitCode}`,
        { exit_code: exitCode, stderr: stderr.trim().slice(-2000) },
      );
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const bytes = await outputBytes(request.outputPath);
  if (bytes <= MIN_CAPTURE_BYTES) {
    // The tool exits 0 even on a failed capture, so the file itself is the
    // verdict. Keep this check after we upgrade the tool.
    throw new AppError(
      "ACQUIRE_FAILED",
      `capture wrote ${bytes} bytes to ${request.outputPath}; expected more than ${MIN_CAPTURE_BYTES}`,
      { path: request.outputPath, bytes },
    );
  }

  return { path: request.outputPath, bytes };
}

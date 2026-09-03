import { stat } from "node:fs/promises";
import { AppError } from "../contracts/errors";

// Regular expressions for hosts that serve ads or consent dialogs. Add a
// pattern only when a captured page shows that the host adds unwanted content.
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
  browserPath: string;
  timeoutMs?: number; // Defaults to `DEFAULT_TIMEOUT_MS`.
};

export type CaptureResult = { path: string; bytes: number };

export const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_CAPTURE_BYTES = 512;

// The `single-file-cli` package installs the `single-file` executable.
export const SINGLE_FILE_BINARY = "single-file";

export function buildArgs(request: CaptureRequest): string[] {
  const args: string[] = [];
  for (const pattern of BLOCKED_URL_PATTERNS) {
    args.push("--blocked-url-pattern", pattern);
  }
  args.push("--browser-executable-path", request.browserPath);
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
  // A negative process ID targets the process group, including browser child
  // processes.
  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // Fall back to terminating only the parent process.
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process has already exited.
  }
}

export async function capture(request: CaptureRequest): Promise<CaptureResult> {
  // Pass the current `PATH` because `Bun.which` otherwise reuses the value from
  // its first call. Tests replace `PATH` to provide a fake executable.
  const binaryPath =
    request.binaryPath ??
    Bun.which(SINGLE_FILE_BINARY, { PATH: process.env.PATH });
  if (!binaryPath) {
    throw new AppError(
      "ACQUIRE_TOOL_MISSING",
      `install ${SINGLE_FILE_BINARY} or add it to PATH`,
    );
  }

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = buildArgs(request);

  // Use a separate process group so a timeout can terminate the CLI and its
  // browser processes. Ignore stdout to prevent an unread pipe from filling.
  const proc = Bun.spawn([binaryPath, ...args], {
    stdout: "ignore",
    stderr: "pipe",
    detached: true,
  });

  // Clear the timer after exit so it can't terminate a later process that
  // reuses this process ID. The `finally` block covers every other exit path.
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
    // `single-file` can exit successfully without producing a valid capture,
    // so validate the output file independently.
    throw new AppError(
      "ACQUIRE_FAILED",
      `capture wrote ${bytes} bytes to ${request.outputPath}; expected more than ${MIN_CAPTURE_BYTES}`,
      { path: request.outputPath, bytes },
    );
  }

  return { path: request.outputPath, bytes };
}

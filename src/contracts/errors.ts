export const ERROR_CODES = [
  "CONFIG_FILE_MISSING",
  "CONFIG_FILE_UNREADABLE",
  "CONFIG_PARSE_FAILED",
  "CONFIG_MISSING_KEY",
  "CONFIG_INVALID_VALUE",
  "CLI_UNKNOWN_COMMAND",
  "CLI_BAD_ARGUMENT",
  "CLI_BAD_URL",
  "VIEW_INVALID_TAG",
  "VIEW_INVALID_ATTRIBUTE",
  "WALK_MAP_MALFORMED",
  "ACQUIRE_TOOL_MISSING",
  "ACQUIRE_TIMEOUT",
  "ACQUIRE_FAILED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly context: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.context = context;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export function toLogLine(
  level: "info" | "warn" | "error",
  event: unknown,
  extra: Record<string, unknown> = {},
): string {
  let code = "UNKNOWN";
  let msg: string;
  let context: Record<string, unknown> = {};
  if (event instanceof AppError) {
    code = event.code;
    msg = event.message;
    context = event.context;
  } else if (event instanceof Error) {
    msg = event.message;
  } else {
    msg = String(event);
  }
  return JSON.stringify({ level, code, msg, ...context, ...extra });
}

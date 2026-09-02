import { AppError } from "./errors";

// Centralize clock access so callers can supply deterministic times in tests.
export function now(): Date {
  return new Date();
}

export function addMs(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms);
}

export function toIso(value: Date): string {
  return value.toISOString();
}

export function parseIso(value: string): Date {
  // `new Date(value)` returns an invalid date instead of throwing.
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(
      "CONFIG_INVALID_VALUE",
      `cannot read "${value}" as an ISO timestamp`,
      { value },
    );
  }
  return parsed;
}

export function isBefore(a: Date, b: Date): boolean {
  return a.getTime() < b.getTime();
}

import { AppError } from "./errors";

// The clock is the one place the system may read real time. Everything else
// takes a Date and goes through these five functions.
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
  // new Date() does not throw on a string it cannot read; the NaN check is
  // the verdict.
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

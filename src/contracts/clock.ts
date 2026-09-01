export function now(): Date {
  return new Date();
}

export function addMs(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms);
}

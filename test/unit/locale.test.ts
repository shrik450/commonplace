import { describe, expect, test } from "bun:test";

import { preferredLocale } from "../../src/web/routes/deps";

function request(header: string | null): Request {
  return new Request(
    "http://localhost/library",
    header === null ? undefined : { headers: { "accept-language": header } },
  );
}

describe("preferredLocale", () => {
  test("a browser with no header gets the fallback", () => {
    expect(preferredLocale(request(null))).toBe("en-GB");
  });

  test("a single tag wins", () => {
    expect(preferredLocale(request("de-DE"))).toBe("de-DE");
  });

  test("the highest quality wins, whatever the order", () => {
    expect(preferredLocale(request("en;q=0.5, fr-CA;q=0.9"))).toBe("fr-CA");
  });

  test("a malformed tag does not take the page down", () => {
    expect(preferredLocale(request("not a tag!!, ja-JP"))).toBe("ja-JP");
  });

  test("a wildcard alone falls back", () => {
    expect(preferredLocale(request("*"))).toBe("en-GB");
  });

  test("the chosen locale formats the date its own way", () => {
    const iso = "2026-08-14T09:30:00.000Z";
    const british = new Intl.DateTimeFormat(preferredLocale(request("en-GB")), {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(iso));
    const american = new Intl.DateTimeFormat(preferredLocale(request("en-US")), {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(iso));

    expect(british).not.toBe(american);
  });
});

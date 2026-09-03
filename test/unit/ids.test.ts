import { describe, expect, test } from "bun:test";
import { newUserId } from "../../src/contracts/ids";
import { now } from "../../src/contracts/clock";

describe("ids", () => {
  test("newUserId returns a distinct UUID each call", () => {
    const first = newUserId();
    const second = newUserId();
    expect(typeof first).toBe("string");
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("clock", () => {
  test("now returns a Date", () => {
    expect(now()).toBeInstanceOf(Date);
  });
});

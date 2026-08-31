import { describe, expect, test } from "bun:test";
import { newId } from "../../src/contracts/ids";
import { now } from "../../src/contracts/clock";

describe("ids", () => {
  test("newId returns a distinct string each call", () => {
    const first = newId();
    const second = newId();
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

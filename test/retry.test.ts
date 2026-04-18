// test/retry.test.ts — unit tests for the retry helpers.

import { describe, expect, it } from "vitest";
import {
  computeBackoffMs,
  isRetryableStatus,
  parseRetryAfterMs,
} from "../src/retry.js";

describe("computeBackoffMs", () => {
  it("returns 0 when random is 0", () => {
    expect(
      computeBackoffMs({ attempt: 0, baseMs: 100, maxMs: 1000, random: () => 0 }),
    ).toBe(0);
  });

  it("caps at maxMs", () => {
    // 100 * 2^10 = 102_400 but maxMs is 1_000 → floor(0.999 * 1000) = 999.
    const value = computeBackoffMs({
      attempt: 10,
      baseMs: 100,
      maxMs: 1_000,
      random: () => 0.999,
    });
    expect(value).toBeLessThanOrEqual(1_000);
    expect(value).toBeGreaterThanOrEqual(0);
  });

  it("scales exponentially with attempt", () => {
    const random = () => 0.5;
    const a0 = computeBackoffMs({ attempt: 0, baseMs: 100, maxMs: 10_000, random });
    const a1 = computeBackoffMs({ attempt: 1, baseMs: 100, maxMs: 10_000, random });
    const a2 = computeBackoffMs({ attempt: 2, baseMs: 100, maxMs: 10_000, random });
    expect(a0).toBe(50); // 0.5 * 100
    expect(a1).toBe(100); // 0.5 * 200
    expect(a2).toBe(200); // 0.5 * 400
  });
});

describe("parseRetryAfterMs", () => {
  it("returns null for missing header", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
  });

  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("3")).toBe(3_000);
    expect(parseRetryAfterMs(" 0.5 ")).toBe(500);
  });

  it("parses HTTP-date", () => {
    const now = 1_700_000_000_000;
    const future = new Date(now + 5_000).toUTCString();
    expect(parseRetryAfterMs(future, now)).toBe(5_000);
  });

  it("clamps past HTTP-date to 0", () => {
    const now = 1_700_000_000_000;
    const past = new Date(now - 5_000).toUTCString();
    expect(parseRetryAfterMs(past, now)).toBe(0);
  });

  it("returns null for garbage", () => {
    expect(parseRetryAfterMs("not-a-date")).toBeNull();
  });
});

describe("isRetryableStatus", () => {
  it("treats 408/429/5xx as retryable", () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
  });

  it("treats 4xx (non-408/429) and 2xx/3xx as not retryable", () => {
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(301)).toBe(false);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });
});

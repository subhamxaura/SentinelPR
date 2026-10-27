import { describe, expect, it } from "vitest";
import { parseCron, parseTimezone } from "./steps";

describe("parseCron", () => {
  it("accepts valid five-field schedules", () => {
    expect(parseCron("*/15 * * * *")).toBe("*/15 * * * *");
    expect(parseCron(" 0 9 1 12 1 ")).toBe("0 9 1 12 1");
    expect(parseCron("59 23 31 12 7")).toBe("59 23 31 12 7");
  });

  it("rejects out-of-range values and zero steps", () => {
    expect(() => parseCron("60 * * * *")).toThrow(/minute/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/minute/);
    expect(() => parseCron("0 24 * * *")).toThrow(/hour/);
    expect(() => parseCron("0 0 0 * *")).toThrow(/day of month/);
    expect(() => parseCron("0 0 * 13 *")).toThrow(/month/);
    expect(() => parseCron("0 0 * * 8")).toThrow(/day of week/);
  });

  it("rejects malformed field counts and syntax", () => {
    expect(() => parseCron("* * * *")).toThrow(/5-field/);
    expect(() => parseCron("*/15 * * * * *")).toThrow(/5-field/);
    expect(() => parseCron("1-5 * * * *")).toThrow(/minute/);
    expect(() => parseCron("nope * * * *")).toThrow(/minute/);
  });
});

describe("parseTimezone", () => {
  it("accepts IANA timezones and defaults blanks to UTC", () => {
    expect(parseTimezone("UTC")).toBe("UTC");
    expect(parseTimezone("America/New_York")).toBe("America/New_York");
    expect(parseTimezone(" ")).toBe("UTC");
  });

  it("rejects unknown timezones", () => {
    expect(() => parseTimezone("Mars/Olympus_Mons")).toThrow(/timezone/);
  });
});

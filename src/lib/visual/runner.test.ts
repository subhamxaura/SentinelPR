import { describe, expect, it } from "vitest";
import { parseBrowsers, parseViewports, visualRunStatus } from "./runner";

describe("visualRunStatus", () => {
  it("does not report passed when any capture failed", () => {
    expect(visualRunStatus(false, true)).toBe("error");
    expect(visualRunStatus(true, true)).toBe("failed");
    expect(visualRunStatus(false, false)).toBe("passed");
  });
});

describe("visual config parsing", () => {
  it("keeps only supported browsers", () => {
    expect(parseBrowsers(["chromium", "bogus", "webkit"])).toEqual(["chromium", "webkit"]);
    expect(parseBrowsers("nope")).toEqual(["chromium"]);
  });

  it("drops malformed viewports", () => {
    expect(parseViewports([{ label: "phone", width: 390, height: 844 }, { label: "bad" }])).toEqual([
      { label: "phone", width: 390, height: 844 },
    ]);
  });
});

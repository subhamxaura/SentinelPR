import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStoragePath } from "./index";

const BASE = path.join(process.cwd(), "artifacts-test");

describe("resolveStoragePath", () => {
  it("accepts nested generated keys", () => {
    expect(resolveStoragePath(BASE, "org/screenshot/2026/10/id")).toBe(
      path.resolve(BASE, "org/screenshot/2026/10/id"),
    );
  });

  it("rejects traversal and absolute escapes", () => {
    expect(() => resolveStoragePath(BASE, "../artifacts-test-evil/file")).toThrow();
    expect(() => resolveStoragePath(BASE, "org/../../escape")).toThrow();
    expect(() => resolveStoragePath(BASE, path.resolve(BASE, "..", "outside"))).toThrow();
    expect(() => resolveStoragePath(BASE, "..")).toThrow();
    expect(() => resolveStoragePath(BASE, "")).toThrow();
  });
});

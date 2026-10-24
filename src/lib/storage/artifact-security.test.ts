import { describe, it, expect } from "vitest";
import { resolveStoragePath, MAX_ARTIFACT_SIZE_BYTES } from "./index";

describe("Artifact Storage Path Traversal & Security", () => {
  const baseDir = "C:\\app\\artifacts";

  it("safely resolves valid relative artifact keys under the base directory", () => {
    const validKey = "org-1/screenshot/2026/10/uuid-1234.png";
    const resolved = resolveStoragePath(baseDir, validKey);
    expect(resolved).toContain("org-1");
    expect(resolved).toContain("uuid-1234.png");
  });

  it("rejects directory traversal attacks using ../", () => {
    const traversalKeys = [
      "../../etc/passwd",
      "org/../../../secret.txt",
      "../parent",
      "..",
    ];

    for (const key of traversalKeys) {
      expect(() => resolveStoragePath(baseDir, key)).toThrow("Invalid artifact key");
    }
  });

  it("rejects absolute paths", () => {
    const absoluteKeys = [
      "/etc/shadow",
      "/root/.ssh/id_rsa",
      "\\Windows\\System32\\cmd.exe",
    ];

    for (const key of absoluteKeys) {
      expect(() => resolveStoragePath(baseDir, key)).toThrow("Invalid artifact key");
    }
  });

  it("rejects Windows drive-letter paths", () => {
    const driveKeys = [
      "C:\\Windows\\System32\\drivers",
      "D:\\data\\secret",
      "c:/boot.ini",
    ];

    for (const key of driveKeys) {
      expect(() => resolveStoragePath(baseDir, key)).toThrow("Invalid artifact key");
    }
  });

  it("rejects null byte injection", () => {
    const nullByteKey = "valid-org/image.png\0../../secret";
    expect(() => resolveStoragePath(baseDir, nullByteKey)).toThrow("Invalid artifact key");
  });

  it("defines a sensible maximum artifact size (50MB)", () => {
    expect(MAX_ARTIFACT_SIZE_BYTES).toBe(50 * 1024 * 1024);
  });
});

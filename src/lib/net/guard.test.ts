import { describe, expect, it } from "vitest";
import { isPrivateIPv4, isPrivateIPv6 } from "./guard";

describe("private IP detection", () => {
  it.each([
    ["10.1.2.3", true],
    ["127.0.0.1", true],
    ["169.254.169.254", true], // cloud metadata
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.1.1", true],
    ["100.64.0.1", true], // CGNAT
    ["8.8.8.8", false],
    ["172.32.0.1", false], // just outside the 172.16/12 block
    ["1.2.3.4", false],
  ])("classifies %s as private=%s", (ip, expected) => {
    expect(isPrivateIPv4(ip)).toBe(expected);
  });

  it("classifies IPv6 private ranges", () => {
    expect(isPrivateIPv6("::1")).toBe(true);
    expect(isPrivateIPv6("fd00::1")).toBe(true);
    expect(isPrivateIPv6("fe80::1")).toBe(true);
    expect(isPrivateIPv6("::ffff:192.168.0.1")).toBe(true);
    expect(isPrivateIPv6("2606:4700::1")).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { isPrivateIPv4, isPrivateIPv6, safeFetch, validatePublicUrl } from "./guard";

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

  it.each([
    ["::", true],
    ["::1", true],
    ["fd00::1", true],
    ["fe80::1", true],
    ["fec0::1", true],
    ["ff02::1", true],
    ["::ffff:192.168.0.1", true],
    ["::ffff:7f00:1", true], // URL-normalized 127.0.0.1
    ["0:0:0:0:0:ffff:7f00:1", true],
    ["::ffff:0a00:1", true],
    ["::127.0.0.1", true],
    ["2002:7f00:1::", true], // 6to4 embedding 127.0.0.1
    ["2001:0:4136:e378::1", true], // Teredo
    ["2606:4700::1", false],
    ["2001:4860:4860::8888", false],
    ["::ffff:8.8.8.8", false],
    ["not-an-ip", false],
  ])("classifies IPv6 %s as private=%s", (ip, expected) => {
    expect(isPrivateIPv6(ip)).toBe(expected);
  });
});

describe("safeFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("blocks a redirect to a private target before following it", async () => {
    vi.stubEnv("SENTINEL_ALLOW_PRIVATE_TARGETS", "0");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://[::ffff:7f00:1]/metadata" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(safeFetch("http://8.8.8.8/start")).rejects.toMatchObject({ code: "PRIVATE_TARGET_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows redirects to public targets", async () => {
    vi.stubEnv("SENTINEL_ALLOW_PRIVATE_TARGETS", "0");
    const ok = new Response("ok", { status: 200 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://1.1.1.1/next" } }))
      .mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", fetchMock);

    await expect(safeFetch("http://8.8.8.8/start")).resolves.toBe(ok);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0].toString()).toBe("http://1.1.1.1/next");
  });

  it("strips credentials on cross-origin redirects but preserves other headers", async () => {
    vi.stubEnv("SENTINEL_ALLOW_PRIVATE_TARGETS", "0");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "http://1.1.1.1/next" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await safeFetch("http://8.8.8.8/start", {
      method: "PUT",
      body: "payload",
      headers: { authorization: "Bearer secret", cookie: "sid=1", "x-trace": "keep" },
    });

    const redirected = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(redirected.get("authorization")).toBeNull();
    expect(redirected.get("cookie")).toBeNull();
    expect(redirected.get("x-trace")).toBe("keep");
    expect(fetchMock.mock.calls[1][1]?.method).toBe("PUT");
  });

  it("rewrites 303 POST redirects to a bodyless GET", async () => {
    vi.stubEnv("SENTINEL_ALLOW_PRIVATE_TARGETS", "0");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 303, headers: { location: "http://1.1.1.1/next" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await safeFetch("http://8.8.8.8/start", {
      method: "POST",
      body: "payload",
      headers: { "content-type": "text/plain" },
    });

    const redirected = fetchMock.mock.calls[1][1];
    expect(redirected?.method).toBe("GET");
    expect(redirected?.body).toBeUndefined();
    expect(new Headers(redirected?.headers).get("content-type")).toBeNull();
  });
});

describe("validatePublicUrl", () => {
  it("rejects credentials embedded in target URLs", async () => {
    await expect(validatePublicUrl("http://user:pass@8.8.8.8/")).rejects.toMatchObject({
      code: "INVALID_TARGET_URL",
    });
  });
});

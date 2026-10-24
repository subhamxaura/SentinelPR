import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchIdentity } from "./github-oauth";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const USER = { id: 42, login: "Dev", name: "Dev", avatar_url: "https://example.com/avatar.png" };

describe("fetchIdentity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses only the verified primary email", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ ...USER, email: "stale-public@example.com" }))
      .mockResolvedValueOnce(
        json([
          { email: "secondary@example.com", primary: false, verified: true },
          { email: "primary@example.com", primary: true, verified: true },
          { email: "unverified@example.com", primary: true, verified: false },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const identity = await fetchIdentity("token");

    expect(identity.email).toBe("primary@example.com");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to the noreply address when no verified primary exists", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ ...USER, email: "stale-public@example.com" }))
      .mockResolvedValueOnce(json([{ email: "secondary@example.com", primary: false, verified: true }]));
    vi.stubGlobal("fetch", fetchMock);

    const identity = await fetchIdentity("token");

    expect(identity.email).toBe("42+dev@users.noreply.github.com");
  });

  it("does not trust the public profile email when /user/emails fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ ...USER, email: "stale-public@example.com" }))
      .mockResolvedValueOnce(json({ message: "unavailable" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    const identity = await fetchIdentity("token");

    expect(identity.email).toBe("42+dev@users.noreply.github.com");
  });
});

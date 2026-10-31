import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: mocks.findUnique, update: mocks.update, create: mocks.create } },
}));

import { upsertUserFromIdentity } from "./provisioning";
import type { GitHubIdentity } from "./github-oauth";

const identity: GitHubIdentity = {
  githubId: 12345,
  login: "renamed-user",
  name: "Renamed User",
  avatarUrl: "https://avatars.example.test/12345.png",
  email: "new@example.test",
};

function user(overrides: Record<string, unknown> = {}) {
  return { id: "user-1", email: "old@example.test", name: "Existing", githubId: "12345", githubLogin: "old-login", ...overrides };
}

describe("upsertUserFromIdentity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("finds the account by immutable GitHub ID and safely updates profile/email", async () => {
    mocks.findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.githubId === "12345") return user();
      if (where.email === identity.email) return null;
      if (where.githubLogin === identity.login) return null;
      return null;
    });
    mocks.update.mockResolvedValue(user({ email: identity.email, githubLogin: identity.login }));

    const result = await upsertUserFromIdentity(identity);

    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "user-1" },
      data: expect.objectContaining({ email: identity.email, githubLogin: identity.login }),
    }));
    expect(result.id).toBe("user-1");
  });

  it("binds a legacy account by verified email exactly once", async () => {
    const legacy = user({ githubId: null, email: identity.email, githubLogin: null });
    mocks.findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.email === identity.email) return legacy;
      return null;
    });
    mocks.update.mockResolvedValue(user({ githubId: "12345", email: identity.email, githubLogin: identity.login }));

    await upsertUserFromIdentity(identity);

    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "user-1" },
      data: expect.objectContaining({ githubId: "12345", githubLogin: identity.login }),
    }));
  });

  it("rejects a verified email already linked to a different GitHub ID", async () => {
    mocks.findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.email === identity.email) return user({ email: identity.email, githubId: "99999" });
      return null;
    });

    await expect(upsertUserFromIdentity(identity)).rejects.toThrow(/already linked to a different GitHub account/);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not attach a recycled username to a different legacy account", async () => {
    mocks.findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.githubLogin === identity.login) return user({ githubId: null, githubLogin: identity.login });
      return null;
    });
    mocks.create.mockResolvedValue(user({ githubId: "12345", email: identity.email, githubLogin: null }));

    await upsertUserFromIdentity(identity);

    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ githubId: "12345", email: identity.email, githubLogin: null }),
    }));
  });
});

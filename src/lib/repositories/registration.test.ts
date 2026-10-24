import { describe, expect, it, vi } from "vitest";
import type { Prisma, Repository } from "@/generated/prisma/client";
import { registerRepository, type RepositoryRegistration } from "./registration";

const input: RepositoryRegistration = {
  organizationId: "org-a",
  installationId: "installation-1",
  githubId: 42,
  owner: "acme",
  name: "app",
  fullName: "acme/app",
  private: true,
  defaultBranch: "main",
};

const saved = { id: "repo-1", ...input } as unknown as Repository;

function existingRepository(id: string, organizationId: string): Repository {
  return { ...saved, id, organizationId };
}

function fakeDb() {
  return {
    repository: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  } as unknown as Prisma.TransactionClient;
}

describe("registerRepository", () => {
  it("refuses to move a repository owned by another organization", async () => {
    const db = fakeDb();
    const update = vi.mocked(db.repository.update);
    const create = vi.mocked(db.repository.create);
    vi.mocked(db.repository.findUnique).mockResolvedValue(existingRepository("repo-2", "org-b"));

    await expect(registerRepository(db, input)).rejects.toMatchObject({
      code: "REPOSITORY_ALREADY_CONNECTED",
      status: 409,
    });
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("updates metadata only when the repository already belongs to the organization", async () => {
    const db = fakeDb();
    vi.mocked(db.repository.findUnique).mockResolvedValue(existingRepository("repo-1", "org-a"));
    vi.mocked(db.repository.update).mockResolvedValue(saved);

    await registerRepository(db, { ...input, installationId: undefined });

    expect(db.repository.update).toHaveBeenCalledWith({
      where: { id: "repo-1" },
      data: {
        owner: "acme",
        name: "app",
        fullName: "acme/app",
        private: true,
        defaultBranch: "main",
        active: true,
      },
    });
  });

  it("creates a repository for the acting organization when it is unregistered", async () => {
    const db = fakeDb();
    vi.mocked(db.repository.findUnique).mockResolvedValue(null);
    vi.mocked(db.repository.create).mockResolvedValue(saved);

    await expect(registerRepository(db, input)).resolves.toBe(saved);
    expect(db.repository.create).toHaveBeenCalledWith({
      data: {
        organizationId: "org-a",
        installationId: "installation-1",
        githubId: 42,
        owner: "acme",
        name: "app",
        fullName: "acme/app",
        private: true,
        defaultBranch: "main",
      },
    });
  });

  it("rechecks ownership after losing a concurrent create race", async () => {
    const db = fakeDb();
    const findUnique = vi.mocked(db.repository.findUnique);
    findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingRepository("repo-2", "org-b"));
    vi.mocked(db.repository.create).mockRejectedValue({ code: "P2002" });

    await expect(registerRepository(db, input)).rejects.toMatchObject({
      code: "REPOSITORY_ALREADY_CONNECTED",
      status: 409,
    });
    expect(db.repository.update).not.toHaveBeenCalled();
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("updates the local row when a concurrent create was the same organization", async () => {
    const db = fakeDb();
    const findUnique = vi.mocked(db.repository.findUnique);
    findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingRepository("repo-1", "org-a"));
    vi.mocked(db.repository.create).mockRejectedValue({ code: "P2002" });
    vi.mocked(db.repository.update).mockResolvedValue(saved);

    await expect(registerRepository(db, input)).resolves.toBe(saved);
    expect(db.repository.update).toHaveBeenCalledWith({
      where: { id: "repo-1" },
      data: expect.objectContaining({ installationId: "installation-1", active: true }),
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  snapshotFindFirst: vi.fn(),
  artifactCreate: vi.fn(),
  artifactDelete: vi.fn(),
  transaction: vi.fn(),
  storageGet: vi.fn(),
  storagePut: vi.fn(),
  storageDelete: vi.fn(),
  baselineFindFirst: vi.fn(),
  baselineUpdateMany: vi.fn(),
  baselineCreate: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    visualSnapshot: { findFirst: mocks.snapshotFindFirst },
    artifact: { create: mocks.artifactCreate, delete: mocks.artifactDelete },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/storage", () => ({
  getStorage: () => ({ get: mocks.storageGet, put: mocks.storagePut, delete: mocks.storageDelete }),
  artifactKey: () => "org/baseline/new-key",
  sha256: () => "sha256",
}));
vi.mock("@/lib/web/session", () => ({
  actorFor: () => "user:user-1",
  requireMutationRole: vi.fn(),
  requireOrganization: vi.fn().mockResolvedValue({ id: "org-1", user: { id: "user-1" } }),
}));
vi.mock("@/lib/web/api", () => ({ apiError: (error: unknown) => Response.json({ error: String(error) }, { status: 500 }) }));

import { POST } from "./route";

describe("visual baseline approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storageGet.mockResolvedValue(Buffer.from("image"));
    mocks.storagePut.mockResolvedValue(undefined);
    mocks.storageDelete.mockResolvedValue(undefined);
    mocks.snapshotFindFirst.mockResolvedValue({
      id: "snapshot-1",
      testId: "test-1",
      browser: "chromium",
      viewportLabel: "desktop",
      run: { commitSha: "commit-abc" },
      currentArtifact: { storageKey: "org/snapshot.png", contentType: "image/png" },
    });
    mocks.artifactCreate.mockResolvedValue({ id: "artifact-v2" });
    mocks.baselineFindFirst.mockResolvedValue({ version: 1 });
    mocks.baselineUpdateMany.mockResolvedValue({ count: 1 });
    mocks.baselineCreate.mockResolvedValue({ id: "baseline-v2", version: 2, active: true });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      $queryRaw: vi.fn().mockResolvedValue([]),
      visualBaseline: {
        findFirst: mocks.baselineFindFirst,
        updateMany: mocks.baselineUpdateMany,
        create: mocks.baselineCreate,
      },
      auditLog: { create: mocks.auditCreate },
    }));
  });

  it("creates a new active version and retains the previous version row", async () => {
    const response = await POST(new Request("http://localhost/api/approve", { method: "POST" }), {
      params: Promise.resolve({ id: "snapshot-1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.baselineFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { testId: "test-1", browser: "chromium", viewportLabel: "desktop" },
      orderBy: { version: "desc" },
    }));
    expect(mocks.baselineUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ active: true }),
      data: { active: false },
    }));
    expect(mocks.baselineCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ version: 2, active: true, artifactId: "artifact-v2", commitSha: "commit-abc" }),
    }));
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "visual_baseline.approved" }),
    }));
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });
});

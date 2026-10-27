import { describe, it, expect, vi } from "vitest";
import { getTenantWebhookDeliveries } from "./webhook";

describe("Webhook Delivery Tenant Isolation", () => {
  it("scopes delivery queries to repositories owned by the organization only", async () => {
    const mockDb = {
      repository: {
        findMany: vi.fn().mockImplementation(({ where }) => {
          if (where.organizationId === "org-a") {
            return Promise.resolve([
              { fullName: "org-a/repo-1" },
              { fullName: "org-a/repo-2" },
            ]);
          }
          if (where.organizationId === "org-b") {
            return Promise.resolve([{ fullName: "org-b/repo-private" }]);
          }
          return Promise.resolve([]);
        }),
      },
      webhookDelivery: {
        findMany: vi.fn().mockImplementation(({ where }) => {
          const allowed = where.repositoryFullName.in as string[];
          const allDeliveries = [
            {
              id: "del-1",
              deliveryId: "d-1",
              event: "pull_request",
              action: "opened",
              repositoryFullName: "org-a/repo-1",
              status: "processed",
              error: null,
              createdAt: new Date(),
              processedAt: new Date(),
            },
            {
              id: "del-2",
              deliveryId: "d-2",
              event: "pull_request",
              action: "synchronize",
              repositoryFullName: "org-b/repo-private",
              status: "processed",
              error: null,
              createdAt: new Date(),
              processedAt: new Date(),
            },
          ];
          return Promise.resolve(allDeliveries.filter((d) => allowed.includes(d.repositoryFullName)));
        }),
      },
    };

    // Query deliveries for Org A
    const orgADeliveries = await getTenantWebhookDeliveries(mockDb as any, "org-a", 10);
    expect(orgADeliveries).toHaveLength(1);
    expect(orgADeliveries[0].repositoryFullName).toBe("org-a/repo-1");

    // Org A cannot see Org B's private delivery
    expect(orgADeliveries.some((d) => d.repositoryFullName === "org-b/repo-private")).toBe(false);

    // Query deliveries for Org B
    const orgBDeliveries = await getTenantWebhookDeliveries(mockDb as any, "org-b", 10);
    expect(orgBDeliveries).toHaveLength(1);
    expect(orgBDeliveries[0].repositoryFullName).toBe("org-b/repo-private");
  });

  it("returns empty array for organization with no repositories without querying deliveries", async () => {
    const mockDb = {
      repository: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      webhookDelivery: {
        findMany: vi.fn(),
      },
    };

    const deliveries = await getTenantWebhookDeliveries(mockDb as any, "org-empty", 10);
    expect(deliveries).toEqual([]);
    expect(mockDb.webhookDelivery.findMany).not.toHaveBeenCalled();
  });
});

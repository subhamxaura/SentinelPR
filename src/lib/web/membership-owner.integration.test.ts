import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { changeMemberRole } from "./member-service";

const enabled = process.env.RUN_DB_INTEGRATION === "1" && !!process.env.DATABASE_URL;

describe.skipIf(!enabled)("membership owner invariant (PostgreSQL integration)", () => {
  let organizationId = "";
  let actorA = "";
  let actorB = "";
  let memberA = "";
  let memberB = "";

  beforeAll(async () => {
    const suffix = randomUUID();
    const organization = await prisma.organization.create({
      data: { name: `Owner invariant ${suffix}`, slug: `owner-invariant-${suffix}` },
    });
    organizationId = organization.id;
    const userA = await prisma.user.create({ data: { email: `owner-a-${suffix}@example.test`, name: "Owner A" } });
    actorA = userA.id;
    const userB = await prisma.user.create({ data: { email: `owner-b-${suffix}@example.test`, name: "Owner B" } });
    actorB = userB.id;
    const [membershipA, membershipB] = await Promise.all([
      prisma.organizationMember.create({ data: { organizationId, userId: actorA, role: "owner" } }),
      prisma.organizationMember.create({ data: { organizationId, userId: actorB, role: "owner" } }),
    ]);
    memberA = membershipA.id;
    memberB = membershipB.id;
  });

  afterAll(async () => {
    if (organizationId) await prisma.organization.delete({ where: { id: organizationId } });
    const userIds = [actorA, actorB].filter(Boolean);
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("serializes simultaneous last-owner self-demotions", async () => {
    const results = await Promise.all([
      changeMemberRole({
        organizationId,
        actorUserId: actorA,
        actorLabel: `user:${actorA}`,
        memberId: memberA,
        nextRole: "member",
      }),
      changeMemberRole({
        organizationId,
        actorUserId: actorB,
        actorLabel: `user:${actorB}`,
        memberId: memberB,
        nextRole: "member",
      }),
    ]);

    expect(results.filter((result) => result.kind === "ok")).toHaveLength(1);
    expect(results.some((result) => result.kind === "forbidden" || result.kind === "last-owner")).toBe(true);
    const ownerCount = await prisma.organizationMember.count({ where: { organizationId, role: "owner" } });
    expect(ownerCount).toBe(1);
  });
});

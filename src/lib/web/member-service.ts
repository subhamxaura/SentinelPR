import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { canModifyMember, hasUsableOwnerCount, isAtLeast, type Role } from "@/lib/web/roles";

export type MemberMutationResult<T> =
  | { kind: "not-found" }
  | { kind: "forbidden"; reason: string }
  | { kind: "last-owner" }
  | { kind: "ok"; value: T };

function isSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: string }).code === "P2034";
}

async function withOrganizationMembershipLock<T>(
  organizationId: string,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        // Every owner-sensitive operation locks the same parent row first.
        // This serializes count/check/change as one invariant-preserving action.
        await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`;
        return operation(tx);
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === 2) throw error;
    }
  }
  throw new Error("Organization membership transaction retries exhausted");
}

async function actorRoleInTransaction(
  tx: Prisma.TransactionClient,
  organizationId: string,
  actorUserId: string | null,
): Promise<Role | null> {
  // Local development is an explicitly trusted single operator; OAuth actors
  // are re-read under the same lock so a concurrent demotion cannot race auth.
  if (!actorUserId) return "owner";
  const actor = await tx.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: actorUserId } },
    select: { role: true },
  });
  if (!actor) return null;
  return actor.role === "owner" || actor.role === "admin" || actor.role === "member" ? actor.role : null;
}

export async function changeMemberRole(input: {
  organizationId: string;
  actorUserId: string | null;
  actorLabel: string;
  memberId: string;
  nextRole: Role;
}): Promise<MemberMutationResult<{ id: string; role: string; email: string; name: string | null; githubLogin: string | null }>> {
  return withOrganizationMembershipLock(input.organizationId, async (tx) => {
    const actorRole = await actorRoleInTransaction(tx, input.organizationId, input.actorUserId);
    if (!actorRole || !isAtLeast(actorRole, "admin")) {
      return { kind: "forbidden", reason: "Your organization role no longer permits member management." };
    }
    const target = await tx.organizationMember.findFirst({
      where: { id: input.memberId, organizationId: input.organizationId },
      include: { user: { select: { id: true, email: true, name: true, githubLogin: true } } },
    });
    if (!target) return { kind: "not-found" };

    const ownerCount = await tx.organizationMember.count({ where: { organizationId: input.organizationId, role: "owner" } });
    const decision = canModifyMember(actorRole, target.role as Role, input.nextRole, {
      isSelf: !!input.actorUserId && target.userId === input.actorUserId,
      ownerCount,
    });
    if (!decision.allowed) {
      if (input.actorUserId && target.userId === input.actorUserId && target.role === "owner" &&
        input.nextRole !== "owner" && ownerCount <= 1) return { kind: "last-owner" };
      return { kind: "forbidden", reason: decision.reason ?? "Not allowed." };
    }

    const postChangeOwners = ownerCount - (target.role === "owner" && input.nextRole !== "owner" ? 1 : 0);
    if (!hasUsableOwnerCount(postChangeOwners)) return { kind: "last-owner" };

    const updated = await tx.organizationMember.update({
      where: { id: input.memberId },
      data: { role: input.nextRole },
      include: { user: { select: { id: true, email: true, name: true, githubLogin: true } } },
    });
    await tx.auditLog.create({
      data: {
        organizationId: input.organizationId,
        actor: input.actorLabel,
        action: "member.role_changed",
        targetType: "organization_member",
        targetId: input.memberId,
        metadata: { email: target.user.email, from: target.role, to: input.nextRole },
      },
    });
    return {
      kind: "ok",
      value: {
        id: updated.id,
        role: updated.role,
        email: updated.user.email,
        name: updated.user.name,
        githubLogin: updated.user.githubLogin,
      },
    };
  });
}

export async function removeMember(input: {
  organizationId: string;
  actorUserId: string | null;
  actorLabel: string;
  memberId: string;
}): Promise<MemberMutationResult<true>> {
  return withOrganizationMembershipLock(input.organizationId, async (tx) => {
    const actorRole = await actorRoleInTransaction(tx, input.organizationId, input.actorUserId);
    if (!actorRole || !isAtLeast(actorRole, "admin")) {
      return { kind: "forbidden", reason: "Your organization role no longer permits member management." };
    }
    const target = await tx.organizationMember.findFirst({
      where: { id: input.memberId, organizationId: input.organizationId },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!target) return { kind: "not-found" };

    const ownerCount = await tx.organizationMember.count({ where: { organizationId: input.organizationId, role: "owner" } });
    const decision = canModifyMember(actorRole, target.role as Role, null, {
      isSelf: !!input.actorUserId && target.userId === input.actorUserId,
      ownerCount,
    });
    if (!decision.allowed) {
      if (input.actorUserId && target.userId === input.actorUserId && target.role === "owner" && ownerCount <= 1) {
        return { kind: "last-owner" };
      }
      return { kind: "forbidden", reason: decision.reason ?? "Not allowed." };
    }

    const postChangeOwners = ownerCount - (target.role === "owner" ? 1 : 0);
    if (!hasUsableOwnerCount(postChangeOwners)) return { kind: "last-owner" };

    await tx.organizationMember.delete({ where: { id: input.memberId } });
    await tx.auditLog.create({
      data: {
        organizationId: input.organizationId,
        actor: input.actorLabel,
        action: "member.removed",
        targetType: "organization_member",
        targetId: input.memberId,
        metadata: { email: target.user.email },
      },
    });
    return { kind: "ok", value: true };
  });
}

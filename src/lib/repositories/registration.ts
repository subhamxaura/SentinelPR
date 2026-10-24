import type { Prisma, PrismaClient, Repository } from "@/generated/prisma/client";
import { AppError } from "@/lib/errors";

type RepositoryDb = PrismaClient | Prisma.TransactionClient;

export interface RepositoryRegistration {
  organizationId: string;
  installationId?: string | null;
  githubId: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
}

export function repositoryOwnershipConflict(): AppError {
  return new AppError({
    code: "REPOSITORY_ALREADY_CONNECTED",
    message: "This repository is already connected to another organization.",
    category: "authz",
    retryable: false,
    status: 409,
  });
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

function repositoryUpdate(input: RepositoryRegistration) {
  return {
    owner: input.owner,
    name: input.name,
    fullName: input.fullName,
    private: input.private,
    defaultBranch: input.defaultBranch,
    active: true,
    ...(input.installationId !== undefined ? { installationId: input.installationId } : {}),
  };
}

export async function registerRepository(db: RepositoryDb, input: RepositoryRegistration): Promise<Repository> {
  const existing = await db.repository.findUnique({
    where: { githubId: input.githubId },
    select: { id: true, organizationId: true },
  });

  if (existing) {
    if (existing.organizationId !== input.organizationId) throw repositoryOwnershipConflict();
    return db.repository.update({
      where: { id: existing.id },
      data: repositoryUpdate(input),
    });
  }

  try {
    return await db.repository.create({
      data: {
        organizationId: input.organizationId,
        installationId: input.installationId ?? null,
        githubId: input.githubId,
        owner: input.owner,
        name: input.name,
        fullName: input.fullName,
        private: input.private,
        defaultBranch: input.defaultBranch,
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const raced = await db.repository.findUnique({
      where: { githubId: input.githubId },
      select: { id: true, organizationId: true },
    });
    if (!raced) {
      throw new AppError({
        code: "REPOSITORY_CONFLICT",
        message: "The repository could not be registered because of a conflicting record.",
        category: "config",
        retryable: false,
        status: 409,
      });
    }
    if (raced.organizationId !== input.organizationId) throw repositoryOwnershipConflict();
    return db.repository.update({
      where: { id: raced.id },
      data: repositoryUpdate(input),
    });
  }
}

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/lib/env";
import { err } from "@/lib/errors";

/**
 * Lazy Prisma singleton: importing this module never connects or throws.
 * Without DATABASE_URL the first actual query fails with an honest
 * configuration error (503), so builds and typechecks work on any machine.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const connectionString = env.databaseUrl;
  if (!connectionString) {
    throw err.config(
      "DATABASE_URL is not set. Start PostgreSQL (docker compose up -d) and configure .env — see README.",
      "DATABASE_NOT_CONFIGURED",
    );
  }
  const adapter = new PrismaPg({ connectionString, max: 10 });
  return new PrismaClient({ adapter });
}

function getClient(): PrismaClient {
  if (!globalForPrisma.prisma) globalForPrisma.prisma = createClient();
  return globalForPrisma.prisma;
}

/**
 * Proxy defers client creation to first property access. Every call site keeps
 * the normal `prisma.model.findMany(...)` ergonomics.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getClient();
    const value = Reflect.get(client as object, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

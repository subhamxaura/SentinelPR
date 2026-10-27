import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { env } from "@/lib/env";
import { err } from "@/lib/errors";

/**
 * Artifact storage: large binaries (screenshots, diffs, traces, logs) never
 * live in PostgreSQL. Two real drivers behind one interface:
 *  - local:  filesystem (dev default), served through the authed artifact API
 *  - s3:     any S3-compatible store (MinIO locally, S3/R2 in production)
 */

export interface ArtifactStorage {
  readonly id: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** `org/kind/2026/09/<uuid>` — org prefix keeps the bucket logically partitioned. */
export function artifactKey(orgId: string, kind: string): string {
  const now = new Date();
  return `${orgId}/${kind}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${randomUUID()}`;
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export const MAX_ARTIFACT_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

/** Resolve a storage key under baseDir, rejecting sibling-prefix, absolute and traversal escapes. */
export function resolveStoragePath(baseDir: string, key: string): string {
  if (
    !key ||
    typeof key !== "string" ||
    key.includes("\0") ||
    path.posix.isAbsolute(key) ||
    path.win32.isAbsolute(key) ||
    key.startsWith("/") ||
    key.startsWith("\\") ||
    /^[a-zA-Z]:/.test(key)
  ) {
    throw err.internal("Invalid artifact key");
  }

  // Reject traversal patterns across both POSIX and Windows separators
  const normalizedKey = key.replace(/\\/g, "/");
  const segments = normalizedKey.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw err.internal("Invalid artifact key");
  }

  const base = path.resolve(baseDir);
  const full = path.resolve(base, normalizedKey);
  const relative = path.relative(base, full);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    relative.startsWith("../") ||
    relative.startsWith("..\\") ||
    path.isAbsolute(relative) ||
    path.posix.isAbsolute(relative) ||
    path.win32.isAbsolute(relative)
  ) {
    throw err.internal("Invalid artifact key");
  }
  return full;
}

class LocalFsStorage implements ArtifactStorage {
  readonly id = "local";
  constructor(private readonly baseDir: string) {}

  private resolve(key: string): string {
    return resolveStoragePath(this.baseDir, key);
  }

  async put(key: string, body: Buffer): Promise<void> {
    if (body.length > MAX_ARTIFACT_SIZE_BYTES) {
      throw err.config("Artifact exceeds maximum allowed size (50MB)");
    }
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }

  async get(key: string): Promise<Buffer> {
    const full = this.resolve(key);
    return readFile(full);
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}

class S3Storage implements ArtifactStorage {
  readonly id = "s3";
  private client: import("@aws-sdk/client-s3").S3Client | null = null;

  constructor(private readonly cfg: NonNullable<typeof env.storage.s3>) {}

  private async getClient() {
    if (!this.client) {
      const { S3Client } = await import("@aws-sdk/client-s3");
      this.client = new S3Client({
        region: this.cfg.region,
        ...(this.cfg.endpoint ? { endpoint: this.cfg.endpoint, forcePathStyle: true } : {}),
        credentials: {
          accessKeyId: this.cfg.accessKeyId,
          secretAccessKey: this.cfg.secretAccessKey,
        },
      });
    }
    return this.client;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    if (body.length > MAX_ARTIFACT_SIZE_BYTES) {
      throw err.config("Artifact exceeds maximum allowed size (50MB)");
    }
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.getClient();
    await client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.getClient();
    const res = await client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw err.infra(`Artifact ${key} is empty`, "ARTIFACT_EMPTY");
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.getClient();
    await client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
}

let storage: ArtifactStorage | null = null;

export function getStorage(): ArtifactStorage {
  if (storage) return storage;
  if (env.storage.driver === "s3") {
    const cfg = env.storage.s3;
    if (!cfg) {
      throw err.config(
        "ARTIFACT_DRIVER=s3 but S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are missing.",
        "STORAGE_NOT_CONFIGURED",
      );
    }
    storage = new S3Storage(cfg);
  } else {
    storage = new LocalFsStorage(env.storage.localDir);
  }
  return storage;
}

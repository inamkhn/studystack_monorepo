import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  courseAssetsDir,
  toStorageKey,
  UPLOAD_DIR,
} from "../common/utils/storage.js";

export type StorageDriver = "local" | "s3";

const PRESIGN_TTL_SECONDS = 300;

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly driver: StorageDriver;
  private readonly bucket: string;
  private readonly client: S3Client | null;

  constructor(private readonly config: ConfigService) {
    this.driver =
      config.get<string>("STORAGE_DRIVER", "local") === "s3" ? "s3" : "local";
    this.bucket = config.get<string>("S3_BUCKET", "studystack-uploads");
    this.client = this.driver === "s3" ? this.buildClient() : null;
    if (this.driver === "s3" && !this.client) {
      throw new Error(
        "STORAGE_DRIVER=s3 but S3 client could not be built — check S3_REGION/S3_BUCKET/credentials",
      );
    }
  }

  getDriver(): StorageDriver {
    return this.driver;
  }

  // ── client (virtual-hosted style) ─────────────────────────────────────
  // Virtual-hosted: https://<bucket>.s3.<region>.amazonaws.com/<key>.
  // forcePathStyle:false is what selects it; path-style would put the
  // bucket as the first path segment instead. Presigned URLs bind the
  // exact host, so this must match between presign and browser PUT.

  private buildClient(): S3Client | null {
    try {
      const region = this.config.get<string>("S3_REGION", "");
      if (!region || region === "auto") {
        this.logger.error(
          "S3_REGION must be a real AWS region for STORAGE_DRIVER=s3 (e.g. ap-southeast-1)",
        );
        return null;
      }
      const endpoint = this.config.get<string>("S3_ENDPOINT", "");
      const accessKey = this.config.get<string>("S3_ACCESS_KEY", "");
      const secretKey = this.config.get<string>("S3_SECRET_KEY", "");
      return new S3Client({
        region,
        endpoint: endpoint || undefined,
        forcePathStyle: false,
        credentials:
          accessKey && secretKey
            ? { accessKeyId: accessKey, secretAccessKey: secretKey }
            : undefined,
      });
    } catch (error) {
      this.logger.error(
        `Failed to build S3 client: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  private requireS3(): S3Client {
    if (!this.client) {
      throw new Error("S3 storage is not configured");
    }
    return this.client;
  }

  // ── presigned browser upload ──────────────────────────────────────────

  async presignPut(
    key: string,
    contentType: string,
  ): Promise<{ url: string; expiresIn: number }> {
    const client = this.requireS3();
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: PRESIGN_TTL_SECONDS },
    );
    return { url, expiresIn: PRESIGN_TTL_SECONDS };
  }

  // ── reads ─────────────────────────────────────────────────────────────

  async getObjectBytes(key: string): Promise<Buffer> {
    if (this.driver === "local") {
      const abs = path.isAbsolute(key) ? key : path.join(UPLOAD_DIR, key);
      return readFile(abs);
    }
    const client = this.requireS3();
    const res = await client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return this.streamToBuffer(res.Body as AsyncIterable<Uint8Array>);
  }

  async getHeadBytes(key: string, length: number): Promise<Buffer> {
    if (this.driver === "local") {
      const abs = path.isAbsolute(key) ? key : path.join(UPLOAD_DIR, key);
      const data = await readFile(abs);
      return data.subarray(0, length);
    }
    const client = this.requireS3();
    const res = await client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: `bytes=0-${length - 1}`,
      }),
    );
    return this.streamToBuffer(res.Body as AsyncIterable<Uint8Array>);
  }

  async headSize(key: string): Promise<number | null> {
    try {
      if (this.driver === "local") {
        const abs = path.isAbsolute(key) ? key : path.join(UPLOAD_DIR, key);
        const data = await readFile(abs);
        return data.length;
      }
      const client = this.requireS3();
      const res = await client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return typeof res.ContentLength === "number" ? res.ContentLength : null;
    } catch {
      return null;
    }
  }

  // ── writes / deletes ──────────────────────────────────────────────────

  async putAsset(courseId: string, name: string, data: Uint8Array): Promise<string> {
    const key = `assets/${courseId}/${name}`;
    if (this.driver === "local") {
      const dir = courseAssetsDir(courseId);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dir, { recursive: true });
      const filePath = path.join(dir, name);
      await writeFile(filePath, data);
      return toStorageKey(filePath);
    }
    const client = this.requireS3();
    await client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }),
    );
    return key;
  }

  async deleteKey(key: string): Promise<void> {
    try {
      if (this.driver === "local") {
        const abs = path.isAbsolute(key) ? key : path.join(UPLOAD_DIR, key);
        await rm(abs, { force: true });
        return;
      }
      await this.requireS3().send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch {
      // Best-effort cleanup — never fail deletes over leftover objects.
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    try {
      if (this.driver === "local") {
        await rm(path.join(UPLOAD_DIR, prefix), {
          recursive: true,
          force: true,
        });
        return;
      }
      const client = this.requireS3();
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix }),
      );
      const keys = (listed.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => Boolean(k));
      if (keys.length === 0) return;
      await client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })) },
        }),
      );
    } catch {
      // Best-effort.
    }
  }

  private async streamToBuffer(
    body: AsyncIterable<Uint8Array> | undefined,
  ): Promise<Buffer> {
    if (!body) return Buffer.alloc(0);
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
  }
}

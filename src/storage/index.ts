/**
 * Storage Provider Abstraction
 *
 * Unified storage interface. Currently only a local filesystem implementation
 * is provided — extend with S3/MinIO later if needed.
 *
 * Switch via env:
 *   STORAGE_LOCAL_PATH / SUMI_DATA_DIR  — base path for local storage
 */

import { promises as fs } from "fs";
import path from "path";

export interface FileInfo {
  key: string;
  size: number;
  lastModified: Date;
  contentType?: string;
}

export interface StorageProvider {
  upload(key: string, content: Buffer | string, contentType?: string): Promise<void>;
  download(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Metadata for a single object, or null when it is absent or not a file. */
  stat(key: string): Promise<FileInfo | null>;
  list(prefix: string): Promise<FileInfo[]>;
  deletePrefix(prefix: string): Promise<void>;
}

const MIME_BY_EXT: Record<string, string> = {
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".css": "text/css",
};

export function getMimeType(name: string): string {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Local filesystem storage provider.
 */
export class LocalStorageProvider implements StorageProvider {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = path.resolve(basePath);
  }

  /** Resolve a key to an absolute path, blocking path traversal. */
  private getFullPath(key: string): string {
    const normalized = path.normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
    return path.join(this.basePath, normalized);
  }

  private async ensureDir(filePath: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }

  async upload(key: string, content: Buffer | string): Promise<void> {
    const fullPath = this.getFullPath(key);
    await this.ensureDir(fullPath);
    if (typeof content === "string") {
      await fs.writeFile(fullPath, content, "utf8");
    } else {
      await fs.writeFile(fullPath, content);
    }
  }

  async download(key: string): Promise<Buffer> {
    return fs.readFile(this.getFullPath(key));
  }

  async delete(key: string): Promise<void> {
    const fullPath = this.getFullPath(key);
    try {
      const stats = await fs.stat(fullPath);
      if (stats.isDirectory()) {
        await fs.rm(fullPath, { recursive: true, force: true });
      } else {
        await fs.unlink(fullPath);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await fs.stat(this.getFullPath(key))).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Metadata for one object. Distinct from `list`, which walks a *directory*:
   * calling list on a file path makes readdir throw ENOTDIR and the caller gets
   * a 500 instead of the metadata it wanted.
   */
  async stat(key: string): Promise<FileInfo | null> {
    const fullPath = this.getFullPath(key);
    try {
      const stats = await fs.stat(fullPath);
      if (!stats.isFile()) return null;
      return {
        key,
        size: stats.size,
        lastModified: stats.mtime,
        contentType: getMimeType(key),
      };
    } catch {
      return null;
    }
  }

  async list(prefix: string): Promise<FileInfo[]> {
    const fullPath = this.getFullPath(prefix);
    const results: FileInfo[] = [];
    try {
      await this.listRecursive(fullPath, prefix, results);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return results;
  }

  private async listRecursive(
    dirPath: string,
    prefix: string,
    results: FileInfo[]
  ): Promise<void> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      const key = path.join(prefix, entry.name).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        await this.listRecursive(entryPath, key, results);
      } else if (entry.isFile()) {
        const stats = await fs.stat(entryPath);
        results.push({
          key,
          size: stats.size,
          lastModified: stats.mtime,
          contentType: getMimeType(entry.name),
        });
      }
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    try {
      await fs.rm(this.getFullPath(prefix), { recursive: true, force: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

let storageInstance: StorageProvider | null = null;

/** Storage singleton. */
export async function getStorage(): Promise<StorageProvider> {
  if (storageInstance) return storageInstance;
  const basePath =
    process.env.STORAGE_LOCAL_PATH || process.env.SUMI_DATA_DIR || "./data";
  storageInstance = new LocalStorageProvider(basePath);
  return storageInstance;
}

/** For tests. */
export function resetStorageForTests(): void {
  storageInstance = null;
}

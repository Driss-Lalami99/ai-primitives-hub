/**
 * Shared test helper — an in-memory `FileSystem` double.
 *
 * Mirrors `@ai-primitives-hub/infra`'s own `test/helpers/in-memory-
 * filesystem.ts` (test-only code isn't exported across package
 * boundaries, so each package keeps its own copy — matches the
 * reference branch's own per-package test-helper convention).
 * Also satisfies the narrower `WriterFs`/`LockfileFs` shapes this
 * package's writers/stores accept.
 * @module test/helpers/in-memory-filesystem
 */
import type {
  DirEntry,
  FileStat,
  FileSystem,
} from '@ai-primitives-hub/core';

interface InMemoryEntry {
  contents: string;
  mtimeMs: number;
}

/**
 * A flat, path-keyed in-memory filesystem. Directories are implicit:
 * any prefix of a file path that ends in `/` is considered to exist.
 * All paths are normalized to forward slashes for cross-platform consistency.
 */
export class InMemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, InMemoryEntry>();

  private normalize(p: string): string {
    return p.replace(/\\/g, '/');
  }

  /**
   * Seed a file directly, bypassing `writeFile`, for test setup.
   * @param path - File path to seed.
   * @param contents - Text contents for the seeded file.
   * @param mtimeMs - Modification time to report from `stat()`, in
   * milliseconds since the Unix epoch. Defaults to `0`.
   */
  public seed(path: string, contents: string, mtimeMs = 0): void {
    this.files.set(this.normalize(path), { contents, mtimeMs });
  }

  public async readFile(path: string): Promise<string> {
    const p = this.normalize(path);
    const entry = this.files.get(p);
    if (!entry) {
      throw new Error(`ENOENT: no such file: ${p}`);
    }
    return entry.contents;
  }

  public async writeFile(path: string, contents: string): Promise<void> {
    this.files.set(this.normalize(path), { contents, mtimeMs: Date.now() });
  }

  public async readJson<T = unknown>(path: string): Promise<T> {
    return JSON.parse(await this.readFile(path)) as T;
  }

  public async writeJson(path: string, value: unknown): Promise<void> {
    await this.writeFile(path, JSON.stringify(value, null, 2));
  }

  public async exists(path: string): Promise<boolean> {
    const p = this.normalize(path);
    if (this.files.has(p)) {
      return true;
    }
    const dirPrefix = p.endsWith('/') ? p : `${p}/`;
    return [...this.files.keys()].some((existing) => existing.startsWith(dirPrefix));
  }

  public mkdir(): Promise<void> {
    // No-op: directories are implicit in this flat, in-memory model.
    return Promise.resolve();
  }

  public async readDir(path: string): Promise<string[]> {
    return (await this.readDirEntries(path)).map((entry) => entry.name);
  }

  public async readDirEntries(path: string): Promise<DirEntry[]> {
    const p = this.normalize(path);
    if (this.files.has(p)) {
      throw new Error(`ENOTDIR: not a directory: ${p}`);
    }
    const prefix = p.endsWith('/') ? p : `${p}/`;
    const names = new Map<string, boolean>();

    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) {
        continue;
      }
      const rest = filePath.slice(prefix.length);
      const slashIndex = rest.indexOf('/');
      if (slashIndex === -1) {
        names.set(rest, false);
      } else {
        names.set(rest.slice(0, slashIndex), true);
      }
    }

    return [...names.entries()].map(([name, isDirectory]) => ({ name, isDirectory }));
  }

  public async stat(path: string): Promise<FileStat> {
    const p = this.normalize(path);
    const entry = this.files.get(p);
    if (entry) {
      return {
        isDirectory: false,
        isFile: true,
        size: Buffer.byteLength(entry.contents, 'utf8'),
        mtimeMs: entry.mtimeMs
      };
    }
    if (await this.exists(p)) {
      return { isDirectory: true, isFile: false, size: 0, mtimeMs: 0 };
    }
    throw new Error(`ENOENT: no such file or directory: ${p}`);
  }

  public async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const p = this.normalize(path);
    if (opts?.recursive === true) {
      const prefix = p.endsWith('/') ? p : `${p}/`;
      for (const key of this.files.keys()) {
        if (key === p || key.startsWith(prefix)) {
          this.files.delete(key);
        }
      }
      return;
    }
    this.files.delete(p);
  }
}

import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type ConfinedPathAccessErrorCode =
  | "PathChanged"
  | "PathInvalid"
  | "PathNotDirectory"
  | "PathSymlink";

export class ConfinedPathAccessError extends Error {
  constructor(
    readonly code: ConfinedPathAccessErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type ConfinedPathOperation = "assert" | "link" | "mkdir" | "read" | "write";

type ConfinedPathPhase =
  | "after-validation-before-open"
  | "after-validation-before-link"
  | "after-validation-before-mkdir";

export interface ConfinedPathAccessInterlockEvent {
  readonly operation: ConfinedPathOperation;
  readonly phase: ConfinedPathPhase;
  readonly repositoryRoot: string;
  readonly relativePath: string;
  readonly absolutePath: string;
}

type ConfinedPathAccessInterlock = (
  event: ConfinedPathAccessInterlockEvent,
) => void | Promise<void>;

let confinedPathAccessInterlockForTests:
  | ConfinedPathAccessInterlock
  | undefined;

export function setConfinedPathAccessInterlockForTests(
  interlock: ConfinedPathAccessInterlock,
): () => void {
  if (process.env["NODE_ENV"] !== "test" || process.env["VITEST"] !== "true") {
    throw new ConfinedPathAccessError(
      "PathInvalid",
      "the confined path access test seam is available only inside Vitest",
    );
  }
  if (confinedPathAccessInterlockForTests !== undefined) {
    throw new ConfinedPathAccessError(
      "PathInvalid",
      "the confined path access test seam is already active",
    );
  }
  confinedPathAccessInterlockForTests = interlock;
  return () => {
    confinedPathAccessInterlockForTests = undefined;
  };
}

interface ConfinedPathSnapshotEntry {
  readonly path: string;
  readonly identity: string;
  readonly directory: boolean;
}

interface ConfinedPathSnapshot {
  readonly root: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly entries: readonly ConfinedPathSnapshotEntry[];
}

export interface ConfinedPathFileToken {
  readonly relativePath: string;
  readonly identity: string;
  readonly anchoredPath?: string;
  readonly close?: () => Promise<void>;
}

export interface ConfinedPathAccess {
  readonly kind: "linux-procfd" | "node-descriptor";
  assertExistingPath(root: string, relativePath: string): Promise<void>;
  ensureDirectory(root: string, relativePath: string): Promise<void>;
  linkFile(
    root: string,
    source: ConfinedPathFileToken,
    targetRelativePath: string,
  ): Promise<void>;
  readFile(root: string, relativePath: string): Promise<Buffer>;
  removeFile(root: string, token: ConfinedPathFileToken): Promise<void>;
  writeNewFile(
    root: string,
    relativePath: string,
    bytes: string,
  ): Promise<ConfinedPathFileToken>;
}

/**
 * A path access seam for release evidence and terminal decision files.
 *
 * The Linux implementation anchors component traversal and final reads/writes to
 * directory descriptors through `/proc/self/fd`, giving the finalizer a native
 * openat/linkat-style capability without exposing that host-specific detail to
 * freeze-gate policy code.  The portable fallback still performs no-follow leaf
 * opens, rejects symbolic-link/junction components, and compares component
 * identities immediately before and after each filesystem effect so unsupported
 * hosts fail closed on deterministic namespace swaps instead of accepting
 * substituted evidence.
 */
class CheckedNodeConfinedPathAccess implements ConfinedPathAccess {
  readonly kind: ConfinedPathAccess["kind"] = "node-descriptor";

  async assertExistingPath(root: string, relativePath: string): Promise<void> {
    await snapshotConfinedPath(root, relativePath, "existing");
  }

  async ensureDirectory(root: string, relativePath: string): Promise<void> {
    const components =
      relativePath === "." ? [] : relativeComponents(relativePath);
    let current = resolve(root);
    for (const component of components) {
      const parentRelative = relative(resolve(root), current);
      const parentSnapshot = await snapshotConfinedPath(
        root,
        parentRelative === "" ? "." : slashRelative(parentRelative),
        "existing",
      );
      current = join(current, component);
      try {
        const stats = await lstat(current);
        if (stats.isSymbolicLink()) {
          throw new ConfinedPathAccessError(
            "PathSymlink",
            `${current} is a symbolic-link or junction component`,
          );
        }
        if (!stats.isDirectory()) {
          throw new ConfinedPathAccessError(
            "PathNotDirectory",
            `${current} is not a directory`,
          );
        }
        await assertSnapshotUnchanged(parentSnapshot);
        continue;
      } catch (error) {
        if (error instanceof ConfinedPathAccessError) {
          throw error;
        }
        if (!hasCode(error, "ENOENT")) {
          throw error;
        }
      }
      await runInterlock("mkdir", "after-validation-before-mkdir", {
        root,
        relativePath: slashRelative(relative(resolve(root), current)),
        absolutePath: current,
      });
      await assertSnapshotUnchanged(parentSnapshot);
      try {
        await mkdir(current);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) {
          throw error;
        }
      }
      await assertSnapshotUnchanged(parentSnapshot);
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new ConfinedPathAccessError(
          created.isSymbolicLink() ? "PathSymlink" : "PathNotDirectory",
          `${current} is not a confined directory`,
        );
      }
    }
    await snapshotConfinedPath(root, relativePath, "existing");
  }

  async linkFile(
    root: string,
    source: ConfinedPathFileToken,
    targetRelativePath: string,
  ): Promise<void> {
    const sourceSnapshot = await snapshotConfinedPath(
      root,
      source.relativePath,
      "file",
    );
    assertSnapshotLeafIdentity(sourceSnapshot, source.identity);
    const target = await snapshotConfinedPath(
      root,
      targetRelativePath,
      "missing-or-file",
    );
    await runInterlock("link", "after-validation-before-link", {
      root,
      relativePath: targetRelativePath,
      absolutePath: target.absolutePath,
    });
    await assertSnapshotUnchanged(sourceSnapshot);
    await assertSnapshotUnchanged(target);
    let linked = false;
    try {
      await link(sourceSnapshot.absolutePath, target.absolutePath);
      linked = true;
      await assertSnapshotUnchanged(sourceSnapshot);
      await assertSnapshotUnchanged(target);
      const published = await snapshotConfinedPath(root, targetRelativePath, "file");
      assertSnapshotLeafIdentity(published, source.identity);
    } catch (error) {
      if (linked) {
        await rm(target.absolutePath, { force: true });
      }
      throw error;
    }
  }

  async readFile(root: string, relativePath: string): Promise<Buffer> {
    const snapshot = await snapshotConfinedPath(root, relativePath, "file");
    await runInterlock("read", "after-validation-before-open", {
      root,
      relativePath,
      absolutePath: snapshot.absolutePath,
    });
    await assertSnapshotUnchanged(snapshot);
    const handle = await openNoFollow(snapshot.absolutePath, constants.O_RDONLY);
    try {
      await assertFileHandleMatchesSnapshot(handle, snapshot);
      const bytes = await handle.readFile();
      await assertSnapshotUnchanged(snapshot);
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async removeFile(root: string, token: ConfinedPathFileToken): Promise<void> {
    try {
      const snapshot = await snapshotConfinedPath(root, token.relativePath, "file");
      assertSnapshotLeafIdentity(snapshot, token.identity);
      await rm(snapshot.absolutePath, { force: true });
    } finally {
      await token.close?.();
    }
  }

  async writeNewFile(
    root: string,
    relativePath: string,
    bytes: string,
  ): Promise<ConfinedPathFileToken> {
    const snapshot = await snapshotConfinedPath(
      root,
      relativePath,
      "missing-or-file",
    );
    await runInterlock("write", "after-validation-before-open", {
      root,
      relativePath,
      absolutePath: snapshot.absolutePath,
    });
    await assertSnapshotUnchanged(snapshot);
    const handle = await openNoFollow(
      snapshot.absolutePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    );
    let token: ConfinedPathFileToken | undefined;
    try {
      token = { relativePath, identity: identity(await handle.stat()) };
      await handle.writeFile(bytes, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (token === undefined) {
      throw new ConfinedPathAccessError(
        "PathInvalid",
        `${relativePath} was not written`,
      );
    }
    await assertSnapshotUnchanged(snapshot);
    const written = await snapshotConfinedPath(root, relativePath, "file");
    assertSnapshotLeafIdentity(written, token.identity);
    return token;
  }
}

class UnsupportedNativeConfinedPathAccess implements ConfinedPathAccess {
  readonly kind = "node-descriptor" as const;

  async assertExistingPath(): Promise<void> {
    throw unsupportedHostError();
  }

  async ensureDirectory(): Promise<void> {
    throw unsupportedHostError();
  }

  async linkFile(): Promise<void> {
    throw unsupportedHostError();
  }

  async readFile(): Promise<Buffer> {
    throw unsupportedHostError();
  }

  async removeFile(_root: string, token: ConfinedPathFileToken): Promise<void> {
    await token.close?.();
    throw unsupportedHostError();
  }

  async writeNewFile(): Promise<ConfinedPathFileToken> {
    throw unsupportedHostError();
  }
}

class LinuxProcfsConfinedPathAccess extends CheckedNodeConfinedPathAccess {
  override readonly kind = "linux-procfd" as const;

  override async ensureDirectory(root: string, relativePath: string): Promise<void> {
    const components =
      relativePath === "." ? [] : relativeComponents(relativePath);
    let current = await openDirectoryNoFollow(resolve(root));
    const walked: string[] = [];
    try {
      for (const component of components) {
        const child = descriptorChildPath(current, component);
        walked.push(component);
        try {
          const stats = await lstat(child);
          if (stats.isSymbolicLink()) {
            throw new ConfinedPathAccessError(
              "PathSymlink",
              `${child} is a symbolic-link or junction component`,
            );
          }
          if (!stats.isDirectory()) {
            throw new ConfinedPathAccessError(
              "PathNotDirectory",
              `${child} is not a directory`,
            );
          }
        } catch (error) {
          if (error instanceof ConfinedPathAccessError) {
            throw error;
          }
          if (!hasCode(error, "ENOENT")) {
            throw error;
          }
          await runInterlock("mkdir", "after-validation-before-mkdir", {
            root,
            relativePath: walked.join("/"),
            absolutePath: child,
          });
          try {
            await mkdir(child);
          } catch (mkdirError) {
            if (!hasCode(mkdirError, "EEXIST")) {
              throw mkdirError;
            }
          }
        }
        const next = await openDirectoryNoFollow(child);
        await current.close();
        current = next;
      }
    } finally {
      await closeQuietly(current);
    }
    await snapshotConfinedPath(root, relativePath, "existing");
  }

  override async linkFile(
    root: string,
    source: ConfinedPathFileToken,
    targetRelativePath: string,
  ): Promise<void> {
    const sourceSnapshot = await snapshotConfinedPath(
      root,
      source.relativePath,
      "file",
    );
    assertSnapshotLeafIdentity(sourceSnapshot, source.identity);
    const targetSnapshot = await snapshotConfinedPath(
      root,
      targetRelativePath,
      "missing-or-file",
    );
    await withConfinedParent(
      root,
      source.relativePath,
      async (sourceParent, sourceLeaf) => {
        await withConfinedParent(
          root,
          targetRelativePath,
          async (targetParent, targetLeaf) => {
            const targetAnchoredPath = descriptorChildPath(targetParent, targetLeaf);
            let linked = false;
            try {
              await runInterlock("link", "after-validation-before-link", {
                root,
                relativePath: targetRelativePath,
                absolutePath: targetSnapshot.absolutePath,
              });
              await assertSnapshotUnchanged(sourceSnapshot);
              await assertSnapshotUnchanged(targetSnapshot);
              await link(
                descriptorChildPath(sourceParent, sourceLeaf),
                targetAnchoredPath,
              );
              linked = true;
              await assertSnapshotUnchanged(sourceSnapshot);
              await assertSnapshotUnchanged(targetSnapshot);
              const target = await openNoFollow(targetAnchoredPath, constants.O_RDONLY);
              try {
                const stats = await target.stat();
                if (!stats.isFile() || !sameIdentity(source.identity, stats)) {
                  throw new ConfinedPathAccessError(
                    "PathChanged",
                    `${targetRelativePath} changed during confined path access`,
                  );
                }
              } finally {
                await target.close();
              }
            } catch (error) {
              if (linked) {
                await rm(targetAnchoredPath, { force: true });
              }
              throw error;
            }
          },
        );
      },
    );
    const published = await snapshotConfinedPath(root, targetRelativePath, "file");
    assertSnapshotLeafIdentity(published, source.identity);
  }

  override async readFile(root: string, relativePath: string): Promise<Buffer> {
    const snapshot = await snapshotConfinedPath(root, relativePath, "file");
    let bytes: Buffer;
    await withConfinedParent(root, relativePath, async (parent, leaf) => {
      await runInterlock("read", "after-validation-before-open", {
        root,
        relativePath,
        absolutePath: snapshot.absolutePath,
      });
      const handle = await openNoFollow(descriptorChildPath(parent, leaf), constants.O_RDONLY);
      try {
        await assertFileHandleMatchesSnapshot(handle, snapshot);
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
    });
    await assertSnapshotUnchanged(snapshot);
    return bytes!;
  }

  override async removeFile(
    root: string,
    token: ConfinedPathFileToken,
  ): Promise<void> {
    if (token.anchoredPath === undefined) {
      await super.removeFile(root, token);
      return;
    }
    try {
      await rm(token.anchoredPath, { force: true });
    } finally {
      await token.close?.();
    }
  }

  override async writeNewFile(
    root: string,
    relativePath: string,
    bytes: string,
  ): Promise<ConfinedPathFileToken> {
    const snapshot = await snapshotConfinedPath(
      root,
      relativePath,
      "missing-or-file",
    );
    const components = relativeComponents(relativePath);
    const leaf = components.at(-1);
    if (leaf === undefined) {
      throw new ConfinedPathAccessError(
        "PathInvalid",
        `${relativePath} does not identify a file`,
      );
    }
    const parent = await openConfinedParent(root, relativePath);
    let closeParent = true;
    try {
      await runInterlock("write", "after-validation-before-open", {
        root,
        relativePath,
        absolutePath: snapshot.absolutePath,
      });
      await assertSnapshotUnchanged(snapshot);
      const anchoredPath = descriptorChildPath(parent, leaf);
      const handle = await openNoFollow(
        anchoredPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      );
      let token: ConfinedPathFileToken;
      try {
        token = {
          relativePath,
          identity: identity(await handle.stat()),
          anchoredPath,
          close: async () => {
            await closeQuietly(parent);
          },
        };
        await handle.writeFile(bytes, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await assertSnapshotUnchanged(snapshot);
      const written = await snapshotConfinedPath(root, relativePath, "file");
      assertSnapshotLeafIdentity(written, token.identity);
      closeParent = false;
      return token;
    } finally {
      if (closeParent) {
        await closeQuietly(parent);
      }
    }
  }
}

export const nodeConfinedPathAccess: ConfinedPathAccess =
  process.platform === "linux"
    ? new LinuxProcfsConfinedPathAccess()
    : process.env["NODE_ENV"] === "test" && process.env["VITEST"] === "true"
      ? new CheckedNodeConfinedPathAccess()
      : new UnsupportedNativeConfinedPathAccess();

async function withConfinedParent(
  root: string,
  relativePath: string,
  operation: (parent: FileHandle, leaf: string) => Promise<void>,
): Promise<void> {
  const components = relativeComponents(relativePath);
  const leaf = components.at(-1);
  if (leaf === undefined) {
    throw new ConfinedPathAccessError(
      "PathInvalid",
      `${relativePath} does not identify a file`,
    );
  }
  const parent = await openConfinedParent(root, relativePath);
  try {
    await operation(parent, leaf);
  } finally {
    await closeQuietly(parent);
  }
}

async function openConfinedParent(
  root: string,
  relativePath: string,
): Promise<FileHandle> {
  const components = relativeComponents(relativePath);
  let current = await openDirectoryNoFollow(resolve(root));
  try {
    for (const component of components.slice(0, -1)) {
      const next = await openDirectoryNoFollow(
        descriptorChildPath(current, component),
      );
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await closeQuietly(current);
    throw error;
  }
}

async function openDirectoryNoFollow(path: string): Promise<FileHandle> {
  const handle = await openNoFollow(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isDirectory()) {
      throw new ConfinedPathAccessError(
        "PathNotDirectory",
        `${path} is not a directory`,
      );
    }
    return handle;
  } catch (error) {
    await closeQuietly(handle);
    throw error;
  }
}

function descriptorChildPath(parent: FileHandle, child: string): string {
  return `/proc/self/fd/${parent.fd}/${child}`;
}

function unsupportedHostError(): ConfinedPathAccessError {
  return new ConfinedPathAccessError(
    "PathInvalid",
    "native confined path access is unsupported on this host",
  );
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Best effort cleanup after a failed descriptor operation.
  }
}

async function snapshotConfinedPath(
  root: string,
  relativePath: string,
  mode: "existing" | "file" | "missing-or-file",
): Promise<ConfinedPathSnapshot> {
  const absoluteRoot = resolve(root);
  const rootStats = await lstat(absoluteRoot);
  if (rootStats.isSymbolicLink()) {
    throw new ConfinedPathAccessError(
      "PathSymlink",
      `${absoluteRoot} is a symbolic-link or junction component`,
    );
  }
  if (!rootStats.isDirectory()) {
    throw new ConfinedPathAccessError(
      "PathNotDirectory",
      `${absoluteRoot} is not a directory`,
    );
  }
  const canonicalRoot = await realpath(absoluteRoot);
  const components =
    relativePath === "." ? [] : relativeComponents(relativePath);
  let cursor = absoluteRoot;
  const entries: ConfinedPathSnapshotEntry[] = [
    entryFor(absoluteRoot, rootStats, true),
  ];
  for (const [index, component] of components.entries()) {
    cursor = join(cursor, component);
    let stats: Stats;
    try {
      stats = await lstat(cursor);
    } catch (error) {
      if (
        hasCode(error, "ENOENT") &&
        mode === "missing-or-file" &&
        index === components.length - 1
      ) {
        return {
          root: absoluteRoot,
          relativePath,
          absolutePath: cursor,
          entries,
        };
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new ConfinedPathAccessError(
        "PathSymlink",
        `${cursor} is a symbolic-link or junction component`,
      );
    }
    const isLeaf = index === components.length - 1;
    if (!isLeaf && !stats.isDirectory()) {
      throw new ConfinedPathAccessError(
        "PathNotDirectory",
        `${cursor} is not a directory`,
      );
    }
    if (isLeaf && mode === "file" && !stats.isFile()) {
      throw new ConfinedPathAccessError(
        "PathInvalid",
        `${cursor} is not a regular file`,
      );
    }
    const canonicalCursor = await realpath(cursor);
    const canonicalRelative = relative(canonicalRoot, canonicalCursor);
    if (pathEscapes(canonicalRelative)) {
      throw new ConfinedPathAccessError(
        "PathInvalid",
        `${cursor} resolves outside repository root ${root}`,
      );
    }
    entries.push(entryFor(cursor, stats, !isLeaf || stats.isDirectory()));
  }
  return {
    root: absoluteRoot,
    relativePath,
    absolutePath: cursor,
    entries,
  };
}

function assertSnapshotLeafIdentity(
  snapshot: ConfinedPathSnapshot,
  expectedIdentity: string,
): void {
  const leaf = snapshot.entries.at(-1);
  if (leaf === undefined || leaf.identity !== expectedIdentity) {
    throw new ConfinedPathAccessError(
      "PathChanged",
      `${snapshot.absolutePath} changed during confined path access`,
    );
  }
}

async function assertSnapshotUnchanged(
  snapshot: ConfinedPathSnapshot,
): Promise<void> {
  for (const entry of snapshot.entries) {
    let stats: Stats;
    try {
      stats = await lstat(entry.path);
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        throw new ConfinedPathAccessError(
          "PathChanged",
          `${entry.path} disappeared during confined path access`,
        );
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new ConfinedPathAccessError(
        "PathSymlink",
        `${entry.path} became a symbolic-link or junction component`,
      );
    }
    if (entry.directory && !stats.isDirectory()) {
      throw new ConfinedPathAccessError(
        "PathChanged",
        `${entry.path} stopped being a directory during confined path access`,
      );
    }
    if (!sameIdentity(entry.identity, stats)) {
      throw new ConfinedPathAccessError(
        "PathChanged",
        `${entry.path} changed during confined path access`,
      );
    }
  }
}

async function assertFileHandleMatchesSnapshot(
  handle: FileHandle,
  snapshot: ConfinedPathSnapshot,
): Promise<void> {
  const leaf = snapshot.entries.at(-1);
  if (leaf === undefined || leaf.directory) {
    throw new ConfinedPathAccessError(
      "PathInvalid",
      `${snapshot.absolutePath} is not a regular file`,
    );
  }
  const stats = await handle.stat();
  if (!stats.isFile() || !sameIdentity(leaf.identity, stats)) {
    throw new ConfinedPathAccessError(
      "PathChanged",
      `${snapshot.absolutePath} changed before descriptor read`,
    );
  }
}

async function openNoFollow(
  path: string,
  baseFlags: number,
): Promise<FileHandle> {
  return await open(path, baseFlags | (constants.O_NOFOLLOW ?? 0));
}

function entryFor(
  path: string,
  stats: Stats,
  directory: boolean,
): ConfinedPathSnapshotEntry {
  return {
    path,
    identity: identity(stats),
    directory,
  };
}

function identity(stats: Stats): string {
  // Directory size and timestamps legitimately change when we create a child
  // directory or hard-link a terminal file.  Device, inode/file-index, and mode
  // are the stable component identity needed to detect namespace replacement.
  return [stats.dev, stats.ino, stats.mode].join(":");
}

function sameIdentity(expected: string, stats: Stats): boolean {
  return expected === identity(stats);
}

function relativeComponents(relativePath: string): string[] {
  if (
    relativePath === "" ||
    isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.includes("\0")
  ) {
    throw new ConfinedPathAccessError(
      "PathInvalid",
      `${relativePath} is not a repository-relative path`,
    );
  }
  const components = relativePath.split("/");
  if (
    components.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new ConfinedPathAccessError(
      "PathInvalid",
      `${relativePath} contains an unsafe path segment`,
    );
  }
  return components;
}

function pathEscapes(relativePath: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

function slashRelative(path: string): string {
  return path.split(sep).join("/");
}

async function runInterlock(
  operation: ConfinedPathOperation,
  phase: ConfinedPathPhase,
  input: {
    readonly root: string;
    readonly relativePath: string;
    readonly absolutePath: string;
  },
): Promise<void> {
  await confinedPathAccessInterlockForTests?.({
    operation,
    phase,
    repositoryRoot: resolve(input.root),
    relativePath: input.relativePath,
    absolutePath: input.absolutePath,
  });
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

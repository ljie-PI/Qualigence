import { constants, type Stats } from "node:fs";
import { lstat, open, readFile, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, win32 } from "node:path";

export interface ActionValueProvider {
  resolve(valueRef: string): Promise<string>;
}

export interface FileActionValueProviderOptions {
  readonly root: string;
  readonly configFile: string;
}

const MAXIMUM_ACTION_VALUE_BYTES = 64 * 1024;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export interface ActionValuePathSemantics {
  isAbsolute(path: string): boolean;
  relative(from: string, to: string): string;
}

export function validateActionValueFilename(filename: string): void {
  const windowsRoot = win32.parse(filename).root;
  if (
    filename.includes("\0") ||
    isAbsolute(filename) ||
    posix.isAbsolute(filename) ||
    win32.isAbsolute(filename) ||
    windowsRoot !== "" ||
    filename.split(/[\\/]/u).some((part) =>
      part === ".." || part.includes(":") || WINDOWS_DEVICE_NAME.test(part.replace(/[ .]+$/u, "")))
  ) {
    throw new Error("Action value filenames must be portable relative paths.");
  }
}

export function isActionValuePathInsideRoot(
  root: string,
  candidate: string,
  paths: ActionValuePathSemantics = { isAbsolute, relative },
): boolean {
  const fromRoot = paths.relative(root, candidate);
  return !(
    paths.isAbsolute(fromRoot) ||
    fromRoot === ".." ||
    fromRoot.startsWith("../") ||
    fromRoot.startsWith("..\\")
  );
}

export function validateActionValueFilePermissions(
  mode: number,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32" && (mode & 0o077) !== 0) {
    throw new Error("Action value file permissions are too broad.");
  }
}

export async function openActionValueProvider(
  env: NodeJS.ProcessEnv = process.env,
): Promise<FileActionValueProvider | undefined> {
  const root = env.RUNNER_ACTION_VALUE_ROOT;
  const configFile = env.RUNNER_ACTION_VALUE_CONFIG;
  if (root === undefined && configFile === undefined) return undefined;
  if (root === undefined || root.length === 0 || configFile === undefined || configFile.length === 0) {
    throw new Error("RUNNER_ACTION_VALUE_ROOT and RUNNER_ACTION_VALUE_CONFIG must be configured together.");
  }
  return FileActionValueProvider.open({ root, configFile });
}

export class FileActionValueProvider implements ActionValueProvider {
  private constructor(
    private readonly root: string,
    private readonly files: ReadonlyMap<string, string>,
  ) {}

  static async open(options: FileActionValueProviderOptions): Promise<FileActionValueProvider> {
    const root = await realpath(options.root);
    const parsed = parseConfiguration(await readFile(options.configFile, "utf8"));
    const files = new Map<string, string>();
    for (const [valueRef, filename] of parsed) {
      if (valueRef.length === 0 || filename.length === 0) {
        throw new Error("Action value configuration entries must map non-empty refs to filenames.");
      }
      validateActionValueFilename(filename);
      const candidate = resolve(root, filename);
      if (!isActionValuePathInsideRoot(root, candidate)) {
        throw new Error("Action value filenames must stay under the configured root.");
      }
      const file = await openValidatedValueFile(root, candidate);
      await file.close();
      files.set(valueRef, candidate);
    }
    return new FileActionValueProvider(root, files);
  }

  async resolve(valueRef: string): Promise<string> {
    const configured = this.files.get(valueRef);
    if (configured === undefined) {
      throw new Error("Action value reference is not configured.");
    }
    const file = await openValidatedValueFile(this.root, configured);
    try {
      const buffer = Buffer.alloc(MAXIMUM_ACTION_VALUE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAXIMUM_ACTION_VALUE_BYTES) throw new Error("Action value exceeds the maximum size.");
      return buffer.toString("utf8", 0, length);
    } finally {
      await file.close();
    }
  }
}

async function openValidatedValueFile(root: string, filename: string): Promise<FileHandle> {
  const pathMetadata = await lstat(filename);
  if (pathMetadata.isSymbolicLink()) {
    throw new Error("Action value must not be a symbolic link.");
  }
  validateActionValueFileMetadata(pathMetadata);

  const canonical = await realpath(filename);
  if (!isActionValuePathInsideRoot(root, canonical)) {
    throw new Error("Action value file escapes the configured root.");
  }

  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const file = await open(filename, flags);
  try {
    const [metadata, currentPathMetadata, currentCanonical] = await Promise.all([
      file.stat(),
      lstat(filename),
      realpath(filename),
    ]);
    if (currentPathMetadata.isSymbolicLink()) {
      throw new Error("Action value must not be a symbolic link.");
    }
    if (!isActionValuePathInsideRoot(root, currentCanonical)) {
      throw new Error("Action value file escapes the configured root.");
    }
    if (
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino ||
      metadata.dev !== currentPathMetadata.dev ||
      metadata.ino !== currentPathMetadata.ino
    ) {
      throw new Error("Action value file changed while it was opened.");
    }
    validateActionValueFileMetadata(metadata);
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

export function validateActionValueFileMetadata(
  metadata: Pick<Stats, "isFile" | "size" | "mode">,
): void {
  if (!metadata.isFile()) throw new Error("Action value must be stored in a regular file.");
  if (metadata.size > MAXIMUM_ACTION_VALUE_BYTES) throw new Error("Action value exceeds the maximum size.");
  validateActionValueFilePermissions(metadata.mode);
}

function parseConfiguration(source: string): ReadonlyMap<string, string> {
  let offset = skipWhitespace(source, 0);
  if (source[offset] !== "{") throw new Error("Action value configuration must be an object.");
  offset = skipWhitespace(source, offset + 1);
  const entries = new Map<string, string>();
  if (source[offset] === "}") {
    offset = skipWhitespace(source, offset + 1);
    if (offset !== source.length) throw new Error("Action value configuration has trailing data.");
    return entries;
  }

  while (offset < source.length) {
    const key = parseJsonString(source, offset);
    offset = skipWhitespace(source, key.next);
    if (source[offset] !== ":") throw new Error("Action value configuration entry is missing a colon.");
    const value = parseJsonString(source, skipWhitespace(source, offset + 1));
    if (entries.has(key.value)) throw new Error("Action value configuration contains a duplicate ref.");
    entries.set(key.value, value.value);
    offset = skipWhitespace(source, value.next);
    if (source[offset] === "}") {
      offset = skipWhitespace(source, offset + 1);
      if (offset !== source.length) throw new Error("Action value configuration has trailing data.");
      return entries;
    }
    if (source[offset] !== ",") throw new Error("Action value configuration entry is missing a comma.");
    offset = skipWhitespace(source, offset + 1);
  }
  throw new Error("Action value configuration is incomplete.");
}

function parseJsonString(source: string, offset: number): { readonly value: string; readonly next: number } {
  if (source[offset] !== '"') throw new Error("Action value configuration entries must be strings.");
  let escaped = false;
  for (let index = offset + 1; index < source.length; index += 1) {
    const character = source[index];
    if (!escaped && character === '"') {
      return { value: JSON.parse(source.slice(offset, index + 1)) as string, next: index + 1 };
    }
    if (!escaped && character === "\\") {
      escaped = true;
    } else {
      escaped = false;
    }
  }
  throw new Error("Action value configuration contains an incomplete string.");
}

function skipWhitespace(source: string, offset: number): number {
  while (offset < source.length && /\s/u.test(source[offset]!)) offset += 1;
  return offset;
}

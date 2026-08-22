import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileActionValueProvider,
  isActionValuePathInsideRoot,
  openActionValueProvider,
  validateActionValueFileMetadata,
  validateActionValueFilePermissions,
  validateActionValueFilename,
} from "../../../apps/runner/src/action-value-provider.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qualigence-action-values-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileActionValueProvider", () => {
  it("is disabled only when both production configuration paths are absent", async () => {
    await expect(openActionValueProvider({})).resolves.toBeUndefined();
    await expect(openActionValueProvider({ RUNNER_ACTION_VALUE_ROOT: "configured" })).rejects.toThrow();
    await expect(openActionValueProvider({ RUNNER_ACTION_VALUE_CONFIG: "configured" })).rejects.toThrow();
  });

  it("resolves a configured value from its file without caching plaintext", async () => {
    const root = await temporaryRoot();
    const configFile = join(root, "values.json");
    const valueFile = join(root, "email.txt");
    await writeFile(valueFile, "first@example.test", { mode: 0o600 });
    await writeFile(configFile, JSON.stringify({ "customer.email": "email.txt" }));
    const provider = await FileActionValueProvider.open({ root, configFile });

    await expect(provider.resolve("customer.email")).resolves.toBe("first@example.test");
    await writeFile(valueFile, "second@example.test", { mode: 0o600 });
    await expect(provider.resolve("customer.email")).resolves.toBe("second@example.test");
  });

  it.each([
    ["an absolute filename", (root: string) => join(root, "secret.txt")],
    ["a parent traversal", () => "../secret.txt"],
  ])("rejects %s during initialization", async (_name, filename) => {
    const root = await temporaryRoot();
    const configFile = join(root, "values.json");
    await writeFile(configFile, JSON.stringify({ "customer.email": filename(root) }));

    await expect(FileActionValueProvider.open({ root, configFile })).rejects.toThrow();
  });

  it.each([
    ["a Windows drive-relative filename", "C:secret.txt"],
    ["a Windows UNC filename", "\\\\server\\share\\secret.txt"],
    ["a Windows device namespace", "\\\\.\\pipe\\qualigence-secret"],
    ["a Windows extended device namespace", "\\\\?\\C:\\secret.txt"],
    ["a reserved Windows device name", "values\\NUL.txt"],
    ["a POSIX parent segment", "sub/../secret.txt"],
    ["a Windows parent segment", "sub\\..\\secret.txt"],
    ["a mixed-separator parent segment", "sub/..\\secret.txt"],
  ])("rejects %s before filesystem access", async (_name, filename) => {
    expect(() => validateActionValueFilename(filename)).toThrow();
    const root = await temporaryRoot();
    const configFile = join(root, "values.json");
    await writeFile(configFile, JSON.stringify({ value: filename }));

    await expect(FileActionValueProvider.open({ root, configFile })).rejects.toThrow();
  });

  it("rejects a cross-volume relative result with Windows path semantics", () => {
    expect(isActionValuePathInsideRoot("C:\\values", "D:\\secret", win32)).toBe(false);
    expect(isActionValuePathInsideRoot("C:\\values", "C:\\values\\secret", win32)).toBe(true);
  });

  it("rejects duplicate valueRef keys instead of accepting JSON's last value", async () => {
    const root = await temporaryRoot();
    const configFile = join(root, "values.json");
    await writeFile(configFile, '{"customer.email":"one.txt","customer.email":"two.txt"}');

    await expect(FileActionValueProvider.open({ root, configFile })).rejects.toThrow();
  });

  it("rejects every symlink before opening it", async () => {
    const root = await temporaryRoot();
    const configFile = join(root, "values.json");
    await writeFile(join(root, "secret.txt"), "not-for-runner", { mode: 0o600 });
    await symlink(join(root, "secret.txt"), join(root, "linked.txt"), "file");
    await writeFile(configFile, JSON.stringify({ "customer.email": "linked.txt" }));
    await expect(FileActionValueProvider.open({ root, configFile })).rejects.toThrow();
  });

  it.each([
    ["a directory", async (root: string) => { await mkdir(join(root, "value")); }],
    ["an oversized value", async (root: string) => { await writeFile(join(root, "value"), Buffer.alloc(64 * 1024 + 1), { mode: 0o600 }); }],
  ])("rejects %s during initialization", async (_name, prepare) => {
    const root = await temporaryRoot();
    await prepare(root);
    const configFile = join(root, "values.json");
    await writeFile(configFile, JSON.stringify({ value: "value" }));

    await expect(FileActionValueProvider.open({ root, configFile })).rejects.toThrow();
  });

  it("enforces POSIX secret-file permissions on every test platform", async () => {
    expect(() => validateActionValueFilePermissions(0o100600, "linux")).not.toThrow();
    expect(() => validateActionValueFilePermissions(0o100640, "linux")).toThrow();
    expect(() => validateActionValueFilePermissions(0o100604, "darwin")).toThrow();
    expect(() => validateActionValueFilePermissions(0o100666, "win32")).not.toThrow();

    if (process.platform !== "win32") {
      const root = await temporaryRoot();
      await writeFile(join(root, "value"), "secret", { mode: 0o644 });
      await chmod(join(root, "value"), 0o644);
      const configFile = join(root, "values.json");
      await writeFile(configFile, JSON.stringify({ value: "value" }));

      await expect(FileActionValueProvider.open({ root, configFile })).rejects.toThrow(
        "Action value file permissions are too broad.",
      );
    }
  });

  it("rejects FIFO and other nonregular metadata without opening the path", () => {
    const fifoMetadata = { isFile: () => false, size: 0, mode: 0o10600 };
    expect(() => validateActionValueFileMetadata(fifoMetadata)).toThrow(
      "Action value must be stored in a regular file.",
    );
  });

  it("fails closed when a configured value disappears and for an unknown ref", async () => {
    const root = await temporaryRoot();
    const valueFile = join(root, "value");
    await writeFile(valueFile, "secret", { mode: 0o600 });
    const configFile = join(root, "values.json");
    await writeFile(configFile, JSON.stringify({ value: "value" }));
    const provider = await FileActionValueProvider.open({ root, configFile });
    await rm(valueFile);

    await expect(provider.resolve("missing")).rejects.toThrow();
    await expect(provider.resolve("value")).rejects.toThrow();
  });
});

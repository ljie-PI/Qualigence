import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileActionValueProvider,
  openActionValueProvider,
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

  it("rejects duplicate valueRef keys instead of accepting JSON's last value", async () => {
    const root = await temporaryRoot();
    const configFile = join(root, "values.json");
    await writeFile(configFile, '{"customer.email":"one.txt","customer.email":"two.txt"}');

    await expect(FileActionValueProvider.open({ root, configFile })).rejects.toThrow();
  });

  it("rejects a symlink that leaves the canonical root during initialization", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const configFile = join(root, "values.json");
    await writeFile(join(outside, "secret.txt"), "not-for-runner", { mode: 0o600 });
    await symlink(join(outside, "secret.txt"), join(root, "linked.txt"), "file");
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

  it("rejects permissive POSIX files during initialization", async () => {
    if (process.platform === "win32") return;
    const root = await temporaryRoot();
    await writeFile(join(root, "value"), "secret", { mode: 0o644 });
    await chmod(join(root, "value"), 0o644);
    const configFile = join(root, "values.json");
    await writeFile(configFile, JSON.stringify({ value: "value" }));

    await expect(FileActionValueProvider.open({ root, configFile })).rejects.toThrow();
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

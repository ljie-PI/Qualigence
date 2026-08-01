import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const consoleSrc = join(here, "../../../apps/web-console/src");
const consolePkgJson = join(here, "../../../apps/web-console/package.json");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const sourceFiles = walk(consoleSrc);

/** Internal package name fragments the Console must never import. */
const FORBIDDEN_IMPORT_FRAGMENTS = [
  "core-modules",
  "storage-providers",
  "core-application",
  "execution-application",
  "runner-kernel",
  "@qualigence/mission",
  "@qualigence/skill",
  "@qualigence/investigation",
  "@qualigence/review",
  "@qualigence/evidence",
  "@qualigence/intelligence",
  "@qualigence/application-model",
  "@qualigence/server",
  "@qualigence/oidc",
  "@qualigence/postgres-runtime",
  "@qualigence/relational-kysely",
  "@qualigence/artifact-",
  "@qualigence/kms-",
];

describe("Web Console architectural invariants", () => {
  it("has source files to check", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it("imports no domain, storage, application or server package (Public-API-only)", () => {
    const importRe = /(?:import|export)[^;]*?from\s+["']([^"']+)["']/g;
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const text = readFileSync(file, "utf8");
      let match: RegExpExecArray | null;
      while ((match = importRe.exec(text)) !== null) {
        const spec = match[1] ?? "";
        if (FORBIDDEN_IMPORT_FRAGMENTS.some((frag) => spec.includes(frag))) {
          violations.push(`${file}: ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("only depends on @qualigence/public-api among internal packages", () => {
    const pkg = JSON.parse(readFileSync(consolePkgJson, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const internalDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) =>
      name.startsWith("@qualigence/"),
    );
    expect(internalDeps).toEqual(["@qualigence/public-api"]);
  });

  it("never persists tokens to localStorage, sessionStorage or cookies", () => {
    const bannedPersistence = [
      /localStorage\s*\.\s*setItem/,
      /localStorage\s*\[/,
      /document\s*\.\s*cookie\s*=/,
    ];
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const text = readFileSync(file, "utf8");
      for (const pattern of bannedPersistence) {
        if (pattern.test(text)) {
          violations.push(`${file}: ${pattern}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the access-token store free of any web-storage or cookie access", () => {
    const tokenStore = readFileSync(join(consoleSrc, "auth/memory-token-store.ts"), "utf8");
    expect(tokenStore).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });
});

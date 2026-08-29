import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

export type InfrastructureCode =
  | "ChromiumUnavailable"
  | "OpenSslUnavailable"
  | "DockerUnavailable"
  | "CargoUnavailable"
  | "Windows11Unavailable";

/** Stable, fail-closed infrastructure preflight for non-optional Gates. */
export function requireInfrastructure(requirements: readonly string[]): void {
  for (const requirement of requirements) {
    const code = check(requirement);
    if (code !== undefined) {
      process.stderr.write(`${code}\n`);
      process.exitCode = 1;
      throw new Error(code);
    }
  }
}

function check(requirement: string): InfrastructureCode | undefined {
  switch (requirement) {
    case "chromium":
      try {
        const require = createRequire(new URL("../../packages/target-adapters/web-playwright/package.json", import.meta.url));
        const playwright = require("playwright") as { chromium: { executablePath(): string } };
        return existsSync(playwright.chromium.executablePath()) ? undefined : "ChromiumUnavailable";
      } catch { return "ChromiumUnavailable"; }
    case "openssl":
      try {
        const executable = process.platform === "win32" && existsSync("C:\\Program Files\\Git\\usr\\bin\\openssl.exe")
          ? "C:\\Program Files\\Git\\usr\\bin\\openssl.exe" : "openssl";
        execFileSync(executable, ["version"], { stdio: "ignore", timeout: 10_000 });
        return undefined;
      } catch { return "OpenSslUnavailable"; }
    case "docker":
      try { execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }); return undefined; } catch { return "DockerUnavailable"; }
    case "cargo":
      try { execFileSync("cargo", ["--version"], { stdio: "ignore", timeout: 10_000 }); return undefined; } catch { return "CargoUnavailable"; }
    // `cargo fmt` is a required Gate operation, so cargo alone is insufficient.
    // Keep the existing CargoUnavailable contract until a distinct approved
    // rust-toolchain diagnostic is introduced.
    case "rustfmt":
      try { execFileSync("cargo", ["fmt", "--version"], { stdio: "ignore", timeout: 10_000 }); return undefined; } catch { return "CargoUnavailable"; }
    // Hosted phase-1 Windows/Rust may run on GitHub windows-latest (Windows Server).
    // Map only a true non-Windows host to the existing Windows infrastructure code.
    case "windows":
      return process.platform === "win32" ? undefined : "Windows11Unavailable";
    case "windows11":
      if (process.platform !== "win32") return "Windows11Unavailable";
      try {
        const output = execFileSync("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_OperatingSystem).Caption"], { encoding: "utf8", timeout: 10_000 });
        return /Windows 11/i.test(output) ? undefined : "Windows11Unavailable";
      } catch { return "Windows11Unavailable"; }
    default:
      throw new Error(`Unknown infrastructure requirement: ${requirement}`);
  }
}

if (process.argv[1]?.endsWith("infrastructure-preflight.ts")) {
  requireInfrastructure(process.argv.slice(2));
}

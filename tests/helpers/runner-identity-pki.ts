import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Ephemeral OpenSSL-backed PKI for the Self-hosted Runner identity contract tests.
 * It generates real CA material, real CSRs (with locally held private keys, exactly
 * as a Runner would) and, for negative cases, directly minted client certificates.
 * Everything is produced into scratch directories under the repository (never
 * `/tmp`) and read back as PEM strings; scratch directories are removed immediately.
 */

export interface PemPair {
  readonly certPem: string;
  readonly keyPem: string;
}

export interface RunnerCsr {
  readonly keyPem: string;
  readonly csrPem: string;
}

export type RunnerKeyKind = "ec-p256" | "rsa-2048" | "rsa-3072";

function withScratchDir<T>(run: (dir: string, openssl: (args: readonly string[]) => Buffer) => T): T {
  const dir = mkdtempSync(join(process.cwd(), ".runner-pki-"));
  const openssl = (args: readonly string[]): Buffer =>
    execFileSync("openssl", [...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  try {
    return run(dir, openssl);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function generateKey(openssl: (args: readonly string[]) => Buffer, kind: RunnerKeyKind, out: string): void {
  if (kind === "ec-p256") {
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", out]);
    return;
  }
  const bits = kind === "rsa-2048" ? "2048" : "3072";
  openssl(["genrsa", "-out", out, bits]);
}

export function createRunnerCa(commonName = "Qualigence Self-hosted Runner CA"): PemPair {
  return withScratchDir((dir, openssl) => {
    generateKey(openssl, "ec-p256", "ca.key");
    openssl([
      "req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "2",
      "-subj", `/CN=${commonName}`, "-out", "ca.crt",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ]);
    return {
      certPem: readFileSync(join(dir, "ca.crt"), "utf8"),
      keyPem: readFileSync(join(dir, "ca.key"), "utf8"),
    };
  });
}

export function generateRunnerCsr(options: {
  readonly commonName: string;
  readonly keyKind?: RunnerKeyKind;
  /** A bogus SAN embedded in the CSR to prove the issuer ignores it. */
  readonly bogusUriSan?: string;
}): RunnerCsr {
  return withScratchDir((dir, openssl) => {
    generateKey(openssl, options.keyKind ?? "ec-p256", "leaf.key");
    const args = ["req", "-new", "-key", "leaf.key", "-subj", `/CN=${options.commonName}`, "-out", "leaf.csr"];
    if (options.bogusUriSan !== undefined) {
      args.push("-addext", `subjectAltName=URI:${options.bogusUriSan}`);
    }
    openssl(args);
    return {
      keyPem: readFileSync(join(dir, "leaf.key"), "utf8"),
      csrPem: readFileSync(join(dir, "leaf.csr"), "utf8"),
    };
  });
}

/** Produce a CSR whose signature no longer verifies (body bytes tampered). */
export function corruptCsrSignature(): RunnerCsr {
  return withScratchDir((dir, openssl) => {
    generateKey(openssl, "ec-p256", "leaf.key");
    openssl(["req", "-new", "-key", "leaf.key", "-subj", "/CN=runner-1", "-out", "leaf.csr"]);
    const csr = readFileSync(join(dir, "leaf.csr"), "utf8");
    const lines = csr.trim().split("\n");
    // Flip a character on a middle body line so the CSR stays PEM-shaped but its
    // signature (or structure) no longer verifies under `openssl req -verify`.
    const target = Math.floor(lines.length / 2);
    const body = lines[target] ?? "";
    const first = body.charAt(0);
    lines[target] = `${first === "A" ? "B" : "A"}${body.slice(1)}`;
    return { keyPem: readFileSync(join(dir, "leaf.key"), "utf8"), csrPem: `${lines.join("\n")}\n` };
  });
}

/**
 * Mint a client certificate directly from a CA (bypassing the issuer) with an
 * explicit validity window and URI SAN. Used to construct negative fixtures such
 * as an already-expired certificate or one signed by an untrusted CA.
 */
export function mintClientCertificate(options: {
  readonly ca: PemPair;
  readonly commonName: string;
  readonly uriSan: string;
  readonly validity?: readonly string[];
  readonly keyKind?: RunnerKeyKind;
}): PemPair {
  return withScratchDir((dir, openssl) => {
    writeFileSync(join(dir, "ca.crt"), options.ca.certPem);
    writeFileSync(join(dir, "ca.key"), options.ca.keyPem);
    writeFileSync(
      join(dir, "leaf.ext"),
      [
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature",
        "extendedKeyUsage=clientAuth",
        `subjectAltName=URI:${options.uriSan}`,
        "",
      ].join("\n"),
    );
    generateKey(openssl, options.keyKind ?? "ec-p256", "leaf.key");
    openssl(["req", "-new", "-key", "leaf.key", "-subj", `/CN=${options.commonName}`, "-out", "leaf.csr"]);
    openssl([
      "x509", "-req", "-in", "leaf.csr",
      "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
      "-sha256", "-out", "leaf.crt", "-extfile", "leaf.ext",
      ...(options.validity ?? ["-days", "2"]),
    ]);
    return {
      certPem: readFileSync(join(dir, "leaf.crt"), "utf8"),
      keyPem: readFileSync(join(dir, "leaf.key"), "utf8"),
    };
  });
}

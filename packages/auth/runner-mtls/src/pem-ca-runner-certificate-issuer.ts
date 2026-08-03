import { execFileSync } from "node:child_process";
import { X509Certificate, createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RunnerIdentityError,
  type IssueRunnerCertificateInput,
  type IssuedRunnerCertificate,
  type RunnerCertificateIssuer,
} from "@qualigence/runner-identity";
import { certificateSha256Fingerprint } from "./certificate.js";

/**
 * CA material for the in-process Runner certificate issuer. In a real deployment
 * these PEM bytes are read from a {@link SecretProvider} (Docker secret / Vault),
 * never from the application database; an enterprise PKI can replace this issuer
 * entirely via the {@link RunnerCertificateIssuer} port.
 */
export interface PemCaRunnerCertificateIssuerOptions {
  readonly caCertificatePem: string | Buffer;
  readonly caPrivateKeyPem: string | Buffer;
  /** Issued client-certificate lifetime in days (default 30). */
  readonly validityDays?: number;
}

const DEFAULT_VALIDITY_DAYS = 30;
const MIN_RSA_MODULUS_BITS = 3072;

function withScratchDir<T>(run: (dir: string, openssl: (args: readonly string[]) => Buffer) => T): T {
  const dir = mkdtempSync(join(process.cwd(), ".runner-mtls-issue-"));
  const openssl = (args: readonly string[]): Buffer =>
    execFileSync("openssl", [...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  try {
    return run(dir, openssl);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Issues scoped Runner client certificates by signing a CSR with a PEM CA using
 * the local OpenSSL toolchain (the same real-crypto approach the repository's gRPC
 * mTLS conformance PKI already relies on). The CSR's own subject/SAN are ignored:
 * the issued SAN and scope are derived solely from {@link IssueRunnerCertificateInput}.
 */
export class PemCaRunnerCertificateIssuer implements RunnerCertificateIssuer {
  private readonly caCertificatePem: string;
  private readonly caPrivateKeyPem: string;
  private readonly validityDays: number;

  constructor(options: PemCaRunnerCertificateIssuerOptions) {
    this.caCertificatePem = options.caCertificatePem.toString();
    this.caPrivateKeyPem = options.caPrivateKeyPem.toString();
    this.validityDays = options.validityDays ?? DEFAULT_VALIDITY_DAYS;
  }

  async issue(input: IssueRunnerCertificateInput): Promise<IssuedRunnerCertificate> {
    return withScratchDir((dir, openssl) => {
      writeFileSync(join(dir, "request.csr"), input.csrPem);

      this.verifyCsrSignature(dir, openssl);
      this.assertKeyStrength(dir, openssl);

      writeFileSync(join(dir, "ca.crt"), this.caCertificatePem);
      writeFileSync(join(dir, "ca.key"), this.caPrivateKeyPem);
      writeFileSync(
        join(dir, "leaf.ext"),
        [
          "basicConstraints=critical,CA:FALSE",
          "keyUsage=critical,digitalSignature",
          "extendedKeyUsage=clientAuth",
          `subjectAltName=URI:${input.uriSan}`,
          "",
        ].join("\n"),
      );

      try {
        openssl([
          "x509",
          "-req",
          "-in",
          "request.csr",
          "-CA",
          "ca.crt",
          "-CAkey",
          "ca.key",
          "-CAcreateserial",
          "-sha256",
          "-out",
          "leaf.crt",
          "-extfile",
          "leaf.ext",
          "-days",
          String(this.validityDays),
        ]);
      } catch (error) {
        throw new RunnerIdentityError("RunnerCsrInvalid", "failed to sign the runner CSR", { cause: error });
      }

      const certificatePem = readFileSync(join(dir, "leaf.crt"), "utf8");
      const certificate = new X509Certificate(certificatePem);
      return {
        runnerId: input.runnerId,
        certificatePem,
        caCertificatePem: this.caCertificatePem,
        certificateFingerprintSha256: certificateSha256Fingerprint(certificate),
        certificateNotAfter: new Date(certificate.validTo).toISOString(),
      };
    });
  }

  private verifyCsrSignature(_dir: string, openssl: (args: readonly string[]) => Buffer): void {
    try {
      openssl(["req", "-in", "request.csr", "-noout", "-verify"]);
    } catch (error) {
      throw new RunnerIdentityError("RunnerCsrInvalid", "CSR signature verification failed", { cause: error });
    }
  }

  private assertKeyStrength(_dir: string, openssl: (args: readonly string[]) => Buffer): void {
    let publicKeyPem: string;
    try {
      publicKeyPem = openssl(["req", "-in", "request.csr", "-noout", "-pubkey"]).toString();
    } catch (error) {
      throw new RunnerIdentityError("RunnerCsrInvalid", "unable to read CSR public key", { cause: error });
    }
    const publicKey = createPublicKey(publicKeyPem);
    const details = publicKey.asymmetricKeyDetails ?? {};
    if (publicKey.asymmetricKeyType === "ec") {
      if (details.namedCurve !== "prime256v1") {
        throw new RunnerIdentityError(
          "RunnerKeyTooWeak",
          `unsupported EC curve ${String(details.namedCurve)}; require prime256v1 (P-256)`,
        );
      }
      return;
    }
    if (publicKey.asymmetricKeyType === "rsa") {
      const modulusLength = details.modulusLength ?? 0;
      if (modulusLength < MIN_RSA_MODULUS_BITS) {
        throw new RunnerIdentityError(
          "RunnerKeyTooWeak",
          `RSA modulus ${modulusLength} is below the ${MIN_RSA_MODULUS_BITS}-bit minimum`,
        );
      }
      return;
    }
    throw new RunnerIdentityError(
      "RunnerKeyTooWeak",
      `unsupported key type ${String(publicKey.asymmetricKeyType)}; require ECDSA P-256 or RSA-3072+`,
    );
  }
}

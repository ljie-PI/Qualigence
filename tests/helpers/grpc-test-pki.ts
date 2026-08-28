import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A minimal ephemeral PKI for the gRPC mutual-TLS conformance tests. Certificates
 * are generated with the local `openssl` binary into scratch directories under
 * the repository (never `/tmp`) and read back into memory as PEM buffers. Every
 * scratch directory is removed as soon as its output is captured, so nothing is
 * left on disk. Elliptic-curve keys keep generation fast enough for per-suite
 * setup, and CA material is retained in memory so leaf certificates can be minted
 * lazily and independently.
 */

export interface CertificateMaterial {
  readonly key: Buffer;
  readonly cert: Buffer;
}

export interface GrpcTestPki {
  /** Trusted CA that signs the server and the valid Runner certificates. */
  readonly ca: Buffer;
  /** Server certificate/key with SAN `localhost`/`127.0.0.1`, EKU serverAuth. */
  readonly server: CertificateMaterial;
  /** Mint a Runner client certificate (EKU clientAuth) bound to `runnerId`. */
  clientFor(runnerId: string): CertificateMaterial;
  /** A client certificate whose validity window is already in the past. */
  expiredClientFor(runnerId: string): CertificateMaterial;
  /** A client certificate signed by a different, untrusted CA. */
  untrustedClientFor(runnerId: string): CertificateMaterial;
}

interface CaMaterial {
  readonly key: Buffer;
  readonly cert: Buffer;
}

function withScratchDir<T>(run: (dir: string, openssl: (args: readonly string[]) => void) => T): T {
  const dir = mkdtempSync(join(process.cwd(), ".grpc-test-pki-"));
  const openssl = (args: readonly string[]): void => {
    execFileSync("openssl", [...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  };
  try {
    return run(dir, openssl);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function generateEcKey(openssl: (args: readonly string[]) => void, name: string): void {
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", name]);
}

function createCa(commonName: string): CaMaterial {
  return withScratchDir((dir, openssl) => {
    generateEcKey(openssl, "ca.key");
    openssl([
      "req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "2",
      "-subj", `/CN=${commonName}`, "-out", "ca.crt",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ]);
    return { key: readFileSync(join(dir, "ca.key")), cert: readFileSync(join(dir, "ca.crt")) };
  });
}

function signLeaf(
  ca: CaMaterial,
  options: {
    readonly subject: string;
    readonly ext: string;
    readonly validity: readonly string[];
  },
): CertificateMaterial {
  return withScratchDir((dir, openssl) => {
    writeFileSync(join(dir, "ca.crt"), ca.cert);
    writeFileSync(join(dir, "ca.key"), ca.key);
    writeFileSync(join(dir, "leaf.ext"), options.ext);
    generateEcKey(openssl, "leaf.key");
    openssl(["req", "-new", "-key", "leaf.key", "-subj", options.subject, "-out", "leaf.csr"]);
    openssl([
      "x509", "-req", "-in", "leaf.csr",
      "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
      "-sha256", "-out", "leaf.crt", "-extfile", "leaf.ext",
      ...options.validity,
    ]);
    return { key: readFileSync(join(dir, "leaf.key")), cert: readFileSync(join(dir, "leaf.crt")) };
  });
}

const clientExt = (runnerId: string): string =>
  `extendedKeyUsage=clientAuth\nsubjectAltName=URI:runner://${runnerId}\n`;

function signExpiredClientLeaf(ca: CaMaterial, runnerId: string): CertificateMaterial {
  return withScratchDir((dir, openssl) => {
    writeFileSync(join(dir, "ca.crt"), ca.cert);
    writeFileSync(join(dir, "ca.key"), ca.key);
    writeFileSync(join(dir, "index.txt"), "");
    writeFileSync(join(dir, "serial"), "1000\n");
    writeFileSync(join(dir, "ca.cnf"), [
      "[ca]",
      "default_ca = test_ca",
      "[test_ca]",
      "database = index.txt",
      "serial = serial",
      "new_certs_dir = .",
      "certificate = ca.crt",
      "private_key = ca.key",
      "default_md = sha256",
      "policy = policy_any",
      "x509_extensions = client_ext",
      "[policy_any]",
      "commonName = supplied",
      "[client_ext]",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "extendedKeyUsage=clientAuth",
      `subjectAltName=URI:runner://${runnerId}`,
      "",
    ].join("\n"));
    generateEcKey(openssl, "leaf.key");
    openssl(["req", "-new", "-key", "leaf.key", "-subj", `/CN=${runnerId}`, "-out", "leaf.csr"]);
    openssl([
      "ca", "-batch", "-config", "ca.cnf", "-in", "leaf.csr", "-out", "leaf.crt", "-notext",
      "-startdate", "20200101000000Z", "-enddate", "20200102000000Z",
    ]);
    return { key: readFileSync(join(dir, "leaf.key")), cert: readFileSync(join(dir, "leaf.crt")) };
  });
}

export function createGrpcTestPki(): GrpcTestPki {
  const ca = createCa("Qualigence Test CA");
  const rogueCa = createCa("Rogue Test CA");
  const server = signLeaf(ca, {
    subject: "/CN=localhost",
    ext: "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n",
    validity: ["-days", "2"],
  });

  return {
    ca: ca.cert,
    server,
    clientFor: (runnerId) =>
      signLeaf(ca, { subject: `/CN=${runnerId}`, ext: clientExt(runnerId), validity: ["-days", "2"] }),
    expiredClientFor: (runnerId) => signExpiredClientLeaf(ca, runnerId),
    untrustedClientFor: (runnerId) =>
      signLeaf(rogueCa, { subject: `/CN=${runnerId}`, ext: clientExt(runnerId), validity: ["-days", "2"] }),
  };
}

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Absolute paths to a local mutual-TLS material set. */
export interface LocalCertPaths {
  readonly dir: string;
  readonly ca: string;
  readonly coreCert: string;
  readonly coreKey: string;
  readonly runnerCert: string;
  readonly runnerKey: string;
}

export function certPathsFor(dataDir: string): LocalCertPaths {
  const dir = join(dataDir, "certs");
  return {
    dir,
    ca: join(dir, "ca.crt"),
    coreCert: join(dir, "core.crt"),
    coreKey: join(dir, "core.key"),
    runnerCert: join(dir, "runner.crt"),
    runnerKey: join(dir, "runner.key"),
  };
}

export function certsExist(paths: LocalCertPaths): boolean {
  return (
    existsSync(paths.ca) &&
    existsSync(paths.coreCert) &&
    existsSync(paths.coreKey) &&
    existsSync(paths.runnerCert) &&
    existsSync(paths.runnerKey)
  );
}

function scratch<T>(run: (dir: string, openssl: (args: readonly string[]) => void) => T): T {
  const dir = mkdtempSync(join(process.cwd(), ".local-pki-"));
  const openssl = (args: readonly string[]): void => {
    execFileSync("openssl", [...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  };
  try {
    return run(dir, openssl);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Pem {
  readonly key: Buffer;
  readonly cert: Buffer;
}

function createCa(): Pem {
  return scratch((dir, openssl) => {
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key"]);
    openssl([
      "req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "3650",
      "-subj", "/CN=Qualigence Local CA", "-out", "ca.crt",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ]);
    return { key: readFileSync(join(dir, "ca.key")), cert: readFileSync(join(dir, "ca.crt")) };
  });
}

function signLeaf(ca: Pem, subject: string, ext: string): Pem {
  return scratch((dir, openssl) => {
    writeFileSync(join(dir, "ca.crt"), ca.cert);
    writeFileSync(join(dir, "ca.key"), ca.key);
    writeFileSync(join(dir, "leaf.ext"), ext);
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "leaf.key"]);
    openssl(["req", "-new", "-key", "leaf.key", "-subj", subject, "-out", "leaf.csr"]);
    openssl([
      "x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
      "-CAcreateserial", "-sha256", "-days", "825", "-out", "leaf.crt", "-extfile", "leaf.ext",
    ]);
    return { key: readFileSync(join(dir, "leaf.key")), cert: readFileSync(join(dir, "leaf.crt")) };
  });
}

/**
 * Generate a self-contained local mutual-TLS PKI (CA, Core server certificate,
 * Runner client certificate) into `<dataDir>/certs`. Existing material is left
 * untouched so `init` is idempotent. Elliptic-curve keys keep generation fast.
 */
export async function ensureLocalCerts(dataDir: string): Promise<LocalCertPaths> {
  const paths = certPathsFor(dataDir);
  if (certsExist(paths)) {
    return paths;
  }
  await mkdir(paths.dir, { recursive: true });

  const ca = createCa();
  const core = signLeaf(
    ca,
    "/CN=localhost",
    "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n",
  );
  const runner = signLeaf(
    ca,
    "/CN=qualigence-local-runner",
    "extendedKeyUsage=clientAuth\nsubjectAltName=URI:runner://qualigence-local-runner\n",
  );

  await Promise.all([
    writeFile(paths.ca, ca.cert),
    writeFile(paths.coreCert, core.cert),
    writeFile(paths.coreKey, core.key, { mode: 0o600 }),
    writeFile(paths.runnerCert, runner.cert),
    writeFile(paths.runnerKey, runner.key, { mode: 0o600 }),
  ]);

  return paths;
}

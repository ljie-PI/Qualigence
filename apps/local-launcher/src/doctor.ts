import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import {
  aggregateHealthStatus,
  type HealthCheck,
  type HealthReport,
  type LocalConfig,
} from "@qualigence/local-control";
import { HealthClient } from "./health-client.js";

/** File paths to the mTLS material the doctor validates (never their contents). */
export interface DoctorCertPaths {
  readonly ca?: string;
  readonly cert?: string;
  readonly key?: string;
}

export interface LocalDoctorInput {
  readonly version: string;
  readonly config: LocalConfig;
  readonly dbFile: string;
  readonly artifactDir: string;
  readonly spoolFile?: string;
  readonly certPaths?: DoctorCertPaths;
  readonly minFreeDiskBytes?: number;
  /**
   * Optional provider reachability probe. It must send only a static, non-user
   * string and is executed exclusively when `run(true)` is requested.
   */
  readonly providerProbe?: () => Promise<HealthCheck>;
}

/**
 * A one-shot diagnostic over a Local installation. It validates configuration,
 * port availability, database reachability, disk headroom and TLS certificate
 * validity, and — only on explicit request — probes the model provider with a
 * static string. Every finding is a user-safe, actionable {@link HealthCheck}.
 */
export class LocalDoctor {
  private readonly health: HealthClient;

  constructor(private readonly input: LocalDoctorInput) {
    this.health = new HealthClient(input.version);
  }

  async run(includeProviderProbe: boolean): Promise<HealthReport> {
    const checks: HealthCheck[] = [];
    checks.push(this.checkConfig());
    checks.push(await this.checkPortAvailability());
    checks.push(await this.health.checkDatabase(this.input.dbFile));
    checks.push(await this.health.checkArtifactStore(this.input.artifactDir));
    checks.push(
      await this.health.checkDisk(this.input.dbFile, this.input.minFreeDiskBytes),
    );
    checks.push(...(await this.checkCertificates()));
    if (this.input.spoolFile !== undefined) {
      checks.push(await this.health.checkSpool(this.input.spoolFile));
    }
    if (includeProviderProbe && this.input.providerProbe !== undefined) {
      checks.push(await this.safeProviderProbe());
    }

    return {
      status: aggregateHealthStatus(checks),
      version: this.input.version,
      checks,
    };
  }

  private checkConfig(): HealthCheck {
    const { config } = this.input;
    const loopback = config.core.host === "127.0.0.1";
    const spoolOk = config.runner.spoolSoftBytes < config.runner.spoolHardBytes;
    if (loopback && spoolOk) {
      return {
        name: "database",
        status: "pass",
        safeMessage: "configuration is valid and Core is bound to loopback",
      };
    }
    return {
      name: "database",
      status: "fail",
      code: "InvalidConfiguration",
      safeMessage: loopback
        ? "spool soft limit must be below the hard limit"
        : "Core must be bound to loopback in Local mode",
    };
  }

  private async checkPortAvailability(): Promise<HealthCheck> {
    const { host, port } = this.input.config.core;
    const inUse = await this.isPortInUse(host, port);
    return inUse
      ? {
          name: "database",
          status: "warn",
          code: "PortInUse",
          safeMessage: `core port ${host}:${port} is already in use (launcher may be running)`,
        }
      : {
          name: "database",
          status: "pass",
          safeMessage: `core port ${host}:${port} is available`,
        };
  }

  private async checkCertificates(): Promise<HealthCheck[]> {
    const paths = this.input.certPaths;
    if (paths?.cert === undefined) {
      return [
        {
          name: "runner",
          status: "warn",
          code: "CertificateMissing",
          safeMessage: "no TLS certificate is configured for Core/Runner mTLS",
        },
      ];
    }
    try {
      const pem = await readFile(paths.cert);
      const certificate = new X509Certificate(pem);
      const now = Date.now();
      const notBefore = Date.parse(certificate.validFrom);
      const notAfter = Date.parse(certificate.validTo);
      if (Number.isNaN(notAfter) || now > notAfter) {
        return [
          {
            name: "runner",
            status: "fail",
            code: "CertificateExpired",
            safeMessage: "TLS certificate has expired; regenerate it with `init`",
          },
        ];
      }
      if (Number.isNaN(notBefore) || now < notBefore) {
        return [
          {
            name: "runner",
            status: "fail",
            code: "CertificateNotYetValid",
            safeMessage: "TLS certificate is not yet valid",
          },
        ];
      }
      return [
        {
          name: "runner",
          status: "pass",
          safeMessage: `TLS certificate is valid until ${certificate.validTo}`,
        },
      ];
    } catch {
      return [
        {
          name: "runner",
          status: "fail",
          code: "CertificateUnreadable",
          safeMessage: "TLS certificate could not be read or parsed",
        },
      ];
    }
  }

  private async safeProviderProbe(): Promise<HealthCheck> {
    const probe = this.input.providerProbe;
    if (probe === undefined) {
      return {
        name: "model_provider",
        status: "warn",
        code: "ProviderProbeUnavailable",
        safeMessage: "no provider probe is configured",
      };
    }
    try {
      return await probe();
    } catch {
      return {
        name: "model_provider",
        status: "fail",
        code: "ProviderUnreachable",
        safeMessage: "model provider probe failed",
      };
    }
  }

  private isPortInUse(host: string, port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", (error: NodeJS.ErrnoException) => {
        resolve(error.code === "EADDRINUSE");
      });
      server.listen(port, host, () => {
        server.close(() => resolve(false));
      });
    });
  }
}

import type { PeerCertificate } from "node:tls";
import type { RunnerHello } from "@qualigence/runner-protocol";
import type { AuthenticatedRunnerContext } from "@qualigence/runner-control";
import { RunnerProtocolError } from "./errors.js";

export interface AuthenticatedRunnerIdentity {
  readonly runnerId: string;
  readonly certificateFingerprint: string;
}

/**
 * Validates the Runner identity carried by a verified client certificate against
 * the `runnerId` the Runner claims in its {@link RunnerHello}. The gRPC transport
 * has already proven the certificate chains to the trusted CA and is inside its
 * validity window; this seam adds the identity binding so a valid certificate for
 * one Runner can never be replayed as a different Runner.
 */
export interface TlsRunnerIdentity {
  authenticate(peer: PeerCertificate | undefined, claimedRunnerId: string): AuthenticatedRunnerIdentity;
}

export interface RunnerPeerAuthenticator {
  authenticate(
    peer: PeerCertificate | undefined,
    hello: RunnerHello,
  ): Promise<AuthenticatedRunnerContext>;
}

const RUNNER_URI_PREFIX = "runner://";

function isEmptyCertificate(peer: PeerCertificate | undefined): peer is undefined {
  return peer === undefined || Object.keys(peer).length === 0;
}

function subjectAltNameIdentities(subjectaltname: string | undefined): readonly string[] {
  if (subjectaltname === undefined || subjectaltname === "") {
    return [];
  }
  const identities: string[] = [];
  for (const entry of subjectaltname.split(",")) {
    const trimmed = entry.trim();
    const separator = trimmed.indexOf(":");
    if (separator === -1) continue;
    const type = trimmed.slice(0, separator).trim().toUpperCase();
    const value = trimmed.slice(separator + 1).trim();
    if (type === "URI" && value.startsWith(RUNNER_URI_PREFIX)) {
      identities.push(value.slice(RUNNER_URI_PREFIX.length));
    }
  }
  return identities;
}

function certificateIdentities(peer: PeerCertificate): ReadonlySet<string> {
  const identities = new Set<string>();
  const commonName = peer.subject?.CN;
  if (typeof commonName === "string" && commonName !== "") {
    identities.add(commonName);
  }
  for (const identity of subjectAltNameIdentities(peer.subjectaltname)) {
    identities.add(identity);
  }
  return identities;
}

export class CertificateRunnerIdentity implements TlsRunnerIdentity, RunnerPeerAuthenticator {
  authenticate(
    peer: PeerCertificate | undefined,
    hello: RunnerHello,
  ): Promise<AuthenticatedRunnerContext>;
  authenticate(
    peer: PeerCertificate | undefined,
    claimedRunnerId: string,
  ): AuthenticatedRunnerIdentity;
  authenticate(
    peer: PeerCertificate | undefined,
    helloOrRunnerId: RunnerHello | string,
  ): AuthenticatedRunnerIdentity | Promise<AuthenticatedRunnerContext> {
    if (typeof helloOrRunnerId === "string") {
      return this.bind(peer, helloOrRunnerId);
    }
    const identity = this.bind(peer, helloOrRunnerId.runnerId);
    return Promise.resolve({ ...identity, scope: { kind: "local" } });
  }

  private bind(
    peer: PeerCertificate | undefined,
    claimedRunnerId: string,
  ): AuthenticatedRunnerIdentity {
    if (isEmptyCertificate(peer)) {
      throw new RunnerProtocolError("TlsPeerRejected", "no client certificate was presented");
    }

    const identities = certificateIdentities(peer);
    if (!identities.has(claimedRunnerId)) {
      throw new RunnerProtocolError(
        "RunnerIdentityMismatch",
        `certificate identity ${[...identities].join(",") || "<none>"} does not match claimed runner ${claimedRunnerId}`,
        { details: { claimedRunnerId, certificateIdentities: [...identities] } },
      );
    }

    return {
      runnerId: claimedRunnerId,
      certificateFingerprint: peer.fingerprint256 ?? peer.fingerprint ?? "",
    };
  }
}

import { describe, expect, it } from "vitest";
import {
  buildFreezeReport,
  buildFreezeGateReport,
  generateAutomatedFreezeGateReport,
  OBSERVATION_FREEZE_GATE_REPORT_VERSION,
  REQUIRED_SECURITY_VETO_ITEM_IDS,
  REQUIRED_SHARED_CORE_FIELDS,
  WINDOWS_M3_CHECKLIST_VERSION,
  type ObservationFreezeReportV1,
  type ObservationMigrationResult,
  type SchemaConformanceEvidence,
  type WindowsChecklistEvidence,
} from "@qualigence/observation-migration";

const NOW = () => "2026-08-02T00:00:00.000Z";

function migratedResult(assetId: string): ObservationMigrationResult {
  return {
    assetId,
    sourceHash: `hash-${assetId}`,
    status: "migrated",
    outputRef: `ref-${assetId}`,
    migratorVersion: "observation-migrator/v1",
  };
}

function cleanCandidateReport(): ObservationFreezeReportV1 {
  return buildFreezeReport([migratedResult("a"), migratedResult("b")], NOW);
}

function validSchemaConformanceEvidence(): SchemaConformanceEvidence {
  return {
    schemaVersion: "observation-graph/v1",
    webValidatesV1: true,
    desktopValidatesV1: true,
    sharedCoreFields: [...REQUIRED_SHARED_CORE_FIELDS],
  };
}

function validWindowsChecklistEvidence(): WindowsChecklistEvidence {
  return {
    checklistVersion: WINDOWS_M3_CHECKLIST_VERSION,
    productVersion: "2026.08.02",
    runnerProtocolVersion: "runner-protocol/1",
    windowsBuild: "26100.1742",
    interactiveSessionType: "local",
    operatorName: "Grace Hopper",
    reviewerName: "Alan Turing",
    executedAt: "2026-08-02T09:30:00.000Z",
    evidenceRefs: ["run://win-m3/2026-08-02"],
    securityVetoItemIds: [...REQUIRED_SECURITY_VETO_ITEM_IDS],
    items: REQUIRED_SECURITY_VETO_ITEM_IDS.map((id) => ({
      section: "16",
      id,
      description: `security veto ${id}`,
      result: "pass" as const,
    })),
  };
}

describe("generateAutomatedFreezeGateReport (this automated PR / Linux sandbox)", () => {
  it("honestly reports candidate — there is no real Windows sign-off here", () => {
    const report = generateAutomatedFreezeGateReport(
      cleanCandidateReport(),
      validSchemaConformanceEvidence(),
      NOW,
    );

    expect(report.version).toBe(OBSERVATION_FREEZE_GATE_REPORT_VERSION);
    expect(report.environment).toBe("automated-linux-ci");
    expect(report.status).toBe("candidate");
    expect(report.decision.status).toBe("candidate");
    expect(report.decision.inputs.windowsChecklistValid).toBe(false);
    expect(report.decision.signoff).toBeUndefined();
    expect(report.limitations.length).toBeGreaterThan(0);
    expect(report.limitations.join(" ")).toMatch(/Windows/i);
  });

  it("CANNOT LIE about being frozen — even with perfect automated evidence", () => {
    // The automated generator structurally has no way to supply signed Windows
    // evidence, so its output can never be `frozen`, no matter the other inputs.
    const report = generateAutomatedFreezeGateReport(
      cleanCandidateReport(),
      validSchemaConformanceEvidence(),
      NOW,
    );

    expect(report.status).not.toBe("frozen");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('"status":"frozen"');
  });
});

describe("buildFreezeGateReport (the full evidence-driven generator)", () => {
  it("stays candidate when Windows evidence is absent", () => {
    const report = buildFreezeGateReport(
      {
        environment: "manual-windows-signoff",
        candidateReport: cleanCandidateReport(),
        webConformanceEvidence: validSchemaConformanceEvidence(),
      },
      NOW,
    );

    expect(report.status).toBe("candidate");
  });

  it("only reports frozen when a real signed manual checklist is supplied", () => {
    // This proves the report machinery is genuine, not hardcoded to candidate:
    // a fully-evidenced manual sign-off (which a human produces on real Windows
    // hardware) DOES yield frozen.
    const report = buildFreezeGateReport(
      {
        environment: "manual-windows-signoff",
        candidateReport: cleanCandidateReport(),
        windowsChecklistEvidence: validWindowsChecklistEvidence(),
        webConformanceEvidence: validSchemaConformanceEvidence(),
      },
      NOW,
    );

    expect(report.status).toBe("frozen");
    expect(report.decision.status).toBe("frozen");
    expect(report.decision.signoff?.operatorName).toBe("Grace Hopper");
    expect(report.limitations).toEqual([]);
  });
});

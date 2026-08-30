import { describe, expect, it } from "vitest";
import {
  buildFreezeReport,
  decideGraphFreeze,
  REQUIRED_SECURITY_VETO_ITEM_IDS,
  REQUIRED_WINDOWS_CHECKLIST_ITEM_IDS,
  REQUIRED_SHARED_CORE_FIELDS,
  WINDOWS_M3_CHECKLIST_VERSION,
  type ObservationFreezeReportV1,
  type ObservationMigrationResult,
  type SchemaConformanceEvidence,
  type WindowsChecklistEvidence,
  type WindowsChecklistItemEvidence,
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

/** A clean candidate report: every asset classified, zero unexplained failures. */
function cleanCandidateReport(): ObservationFreezeReportV1 {
  return buildFreezeReport([migratedResult("a"), migratedResult("b")], NOW);
}

/** A candidate report that carries an unexplained `failed` result. */
function dirtyCandidateReport(): ObservationFreezeReportV1 {
  return buildFreezeReport(
    [
      migratedResult("a"),
      {
        assetId: "b",
        sourceHash: "hash-b",
        status: "failed",
        // No reasonCode → unexplained failure.
        migratorVersion: "observation-migrator/v1",
      },
    ],
    NOW,
  );
}

/** Every versioned checklist item, including all passing security vetoes. */
function passingVetoItems(): WindowsChecklistItemEvidence[] {
  return REQUIRED_WINDOWS_CHECKLIST_ITEM_IDS.map((id) => ({
    section: id.split(".")[0] ?? "",
    id,
    description: `checklist item ${id}`,
    result:
      id.startsWith("17.") && id !== "17.item-1"
        ? ("not_applicable" as const)
        : ("pass" as const),
  }));
}

function validWindowsChecklistEvidence(
  overrides: Partial<WindowsChecklistEvidence> = {},
): WindowsChecklistEvidence {
  return {
    checklistVersion: WINDOWS_M3_CHECKLIST_VERSION,
    productVersion: "2026.08.02",
    runnerProtocolVersion: "runner-protocol/v1",
    windowsBuild: "26100.1742",
    interactiveSessionType: "local",
    operatorName: "Grace Hopper",
    reviewerName: "Alan Turing",
    executedAt: "2026-08-02T09:30:00.000Z",
    evidenceRefs: ["run://win-m3/2026-08-02", "artifact://win-m3/trace"],
    securityVetoItemIds: [...REQUIRED_SECURITY_VETO_ITEM_IDS],
    items: passingVetoItems(),
    ...overrides,
  };
}

function validSchemaConformanceEvidence(
  overrides: Partial<SchemaConformanceEvidence> = {},
): SchemaConformanceEvidence {
  return {
    schemaVersion: "observation-graph/v1",
    webValidatesV1: true,
    desktopValidatesV1: true,
    sharedCoreFields: [...REQUIRED_SHARED_CORE_FIELDS],
    ...overrides,
  };
}

describe("decideGraphFreeze", () => {
  it("freezes only when ALL THREE inputs are present and valid", () => {
    const decision = decideGraphFreeze(
      cleanCandidateReport(),
      validWindowsChecklistEvidence(),
      validSchemaConformanceEvidence(),
      NOW,
    );

    expect(decision.status).toBe("frozen");
    expect(decision.blockingReasons).toEqual([]);
    expect(decision.inputs).toEqual({
      candidateReportValid: true,
      windowsChecklistValid: true,
      schemaConformanceValid: true,
    });
    expect(decision.graphSchemaVersion).toBe("observation-graph/v1");
    expect(decision.signoff).toMatchObject({
      operatorName: "Grace Hopper",
      reviewerName: "Alan Turing",
      checklistVersion: WINDOWS_M3_CHECKLIST_VERSION,
    });
  });

  it("stays candidate when the Windows checklist evidence is missing", () => {
    const decision = decideGraphFreeze(
      cleanCandidateReport(),
      undefined,
      validSchemaConformanceEvidence(),
      NOW,
    );

    expect(decision.status).toBe("candidate");
    expect(decision.inputs.windowsChecklistValid).toBe(false);
    expect(decision.blockingReasons.length).toBeGreaterThan(0);
    expect(decision.signoff).toBeUndefined();
  });

  it("stays candidate when one identity signs as both operator and reviewer", () => {
    const decision = decideGraphFreeze(
      cleanCandidateReport(),
      validWindowsChecklistEvidence({
        operatorName: "Same Human",
        reviewerName: "Same Human",
      }),
      validSchemaConformanceEvidence(),
      NOW,
    );

    expect(decision.status).toBe("candidate");
    expect(decision.inputs.windowsChecklistValid).toBe(false);
    expect(decision.blockingReasons).toContain(
      "Windows checklist operator and reviewer must be distinct",
    );
  });

  it("stays candidate when the schema conformance evidence is missing", () => {
    const decision = decideGraphFreeze(
      cleanCandidateReport(),
      validWindowsChecklistEvidence(),
      undefined,
      NOW,
    );

    expect(decision.status).toBe("candidate");
    expect(decision.inputs.schemaConformanceValid).toBe(false);
  });

  it("stays candidate when the candidate report has unexplained failures", () => {
    const decision = decideGraphFreeze(
      dirtyCandidateReport(),
      validWindowsChecklistEvidence(),
      validSchemaConformanceEvidence(),
      NOW,
    );

    expect(decision.status).toBe("candidate");
    expect(decision.inputs.candidateReportValid).toBe(false);
  });

  it("stays candidate when the candidate report timestamp is future-dated", () => {
    const report = {
      ...cleanCandidateReport(),
      generatedAt: "2026-08-03T00:00:00.000Z",
    };
    const decision = decideGraphFreeze(
      report,
      validWindowsChecklistEvidence(),
      validSchemaConformanceEvidence(),
      NOW,
    );

    expect(decision.status).toBe("candidate");
    expect(decision.inputs.candidateReportValid).toBe(false);
    expect(decision.blockingReasons).toContain(
      "candidate Freeze Report has no valid non-future timestamp",
    );
  });

  it("stays candidate when any required security-veto item did not pass", () => {
    const items = passingVetoItems();
    items[0] = { ...items[0]!, result: "fail" };
    const decision = decideGraphFreeze(
      cleanCandidateReport(),
      validWindowsChecklistEvidence({ items }),
      validSchemaConformanceEvidence(),
      NOW,
    );

    expect(decision.status).toBe("candidate");
    expect(decision.inputs.windowsChecklistValid).toBe(false);
    expect(decision.blockingReasons.some((r) => r.includes(items[0]!.id))).toBe(
      true,
    );
  });

  it("stays candidate when a required security-veto item is absent from the evidence", () => {
    const items = passingVetoItems().slice(1);
    const decision = decideGraphFreeze(
      cleanCandidateReport(),
      validWindowsChecklistEvidence({ items }),
      validSchemaConformanceEvidence(),
      NOW,
    );

    expect(decision.status).toBe("candidate");
    expect(decision.inputs.windowsChecklistValid).toBe(false);
  });

  it("stays candidate when a checklist item identity is substituted", () => {
    const items = passingVetoItems();
    items[0] = { ...items[0]!, id: "3.substituted" };
    const decision = decideGraphFreeze(
      cleanCandidateReport(),
      validWindowsChecklistEvidence({ items }),
      validSchemaConformanceEvidence(),
      NOW,
    );

    expect(decision.status).toBe("candidate");
    expect(decision.inputs.windowsChecklistValid).toBe(false);
  });

  it("stays candidate when checklist item ids are swapped across sections", () => {
    const items = passingVetoItems();
    const firstIndex = items.findIndex((item) => item.section === "3");
    const secondIndex = items.findIndex((item) => item.section === "4");
    const first = items[firstIndex];
    const second = items[secondIndex];
    if (first === undefined || second === undefined) {
      throw new Error("checklist fixture is missing sections 3 or 4");
    }
    items[firstIndex] = { ...first, id: second.id };
    items[secondIndex] = { ...second, id: first.id };

    const decision = decideGraphFreeze(
      cleanCandidateReport(),
      validWindowsChecklistEvidence({ items }),
      validSchemaConformanceEvidence(),
      NOW,
    );

    expect(decision.status).toBe("candidate");
    expect(decision.inputs.windowsChecklistValid).toBe(false);
    expect(decision.blockingReasons).toContain(
      `checklist item ${second.id} does not belong to section ${first.section}`,
    );
  });

  it("stays candidate when the checklist is signed with the wrong version", () => {
    const decision = decideGraphFreeze(
      cleanCandidateReport(),
      validWindowsChecklistEvidence({
        checklistVersion: "windows-m3-manual-checklist/v0",
      }),
      validSchemaConformanceEvidence(),
      NOW,
    );

    expect(decision.status).toBe("candidate");
    expect(decision.inputs.windowsChecklistValid).toBe(false);
  });

  it("stays candidate when the checklist binds an incompatible Runner protocol", () => {
    const decision = decideGraphFreeze(
      cleanCandidateReport(),
      validWindowsChecklistEvidence({
        runnerProtocolVersion: "runner-protocol/v2",
      }),
      validSchemaConformanceEvidence(),
      NOW,
    );

    expect(decision.status).toBe("candidate");
    expect(decision.inputs.windowsChecklistValid).toBe(false);
    expect(decision.blockingReasons).toContain(
      "Windows checklist does not bind runner-protocol/v1",
    );
  });

  it("stays candidate when the checklist lacks an operator or reviewer signature", () => {
    const noOperator = decideGraphFreeze(
      cleanCandidateReport(),
      validWindowsChecklistEvidence({ operatorName: "  " }),
      validSchemaConformanceEvidence(),
      NOW,
    );
    const noReviewer = decideGraphFreeze(
      cleanCandidateReport(),
      validWindowsChecklistEvidence({ reviewerName: "" }),
      validSchemaConformanceEvidence(),
      NOW,
    );

    expect(noOperator.status).toBe("candidate");
    expect(noReviewer.status).toBe("candidate");
  });

  it("stays candidate when only one target validates the shared v1 schema", () => {
    const webOnly = decideGraphFreeze(
      cleanCandidateReport(),
      validWindowsChecklistEvidence(),
      validSchemaConformanceEvidence({ desktopValidatesV1: false }),
      NOW,
    );

    expect(webOnly.status).toBe("candidate");
    expect(webOnly.inputs.schemaConformanceValid).toBe(false);
  });

  it("stays candidate when the shared core field set is incomplete", () => {
    const decision = decideGraphFreeze(
      cleanCandidateReport(),
      validWindowsChecklistEvidence(),
      validSchemaConformanceEvidence({ sharedCoreFields: ["role"] }),
      NOW,
    );

    expect(decision.status).toBe("candidate");
    expect(decision.inputs.schemaConformanceValid).toBe(false);
  });
});

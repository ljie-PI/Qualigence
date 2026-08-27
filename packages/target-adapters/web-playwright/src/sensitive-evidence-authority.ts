export const REDACTED_SENSITIVE_TEXT = "[redacted]";
export const SENSITIVE_TARGET_IDS_PROPERTY = "__qualigenceSensitiveTargetIds";
export const SENSITIVE_MASK_ID_ATTRIBUTE = "data-qualigence-sensitive-mask";
export const SENSITIVE_EVIDENCE_STATE_PROPERTY = "__qualigenceSensitiveEvidenceState";
export const SENSITIVE_SHADOW_ROOTS_PROPERTY = "__qualigenceSensitiveShadowRoots";

const MAX_SENSITIVE_RECORDS = 100;
const MAX_FORMS_PER_RECORD = 4;
const MAX_FORM_BYTES = 64 * 1024;

export const MAX_REFLECTED_MUTATION_RECORDS = 1_024;
export const MAX_REFLECTED_NODES = 256;
export const MAX_REFLECTED_REGIONS = 256;
export const MAX_SENSITIVE_SHADOW_ROOTS = 128;
export const MAX_SENSITIVE_SCHEDULER_REGISTRATIONS_PER_EPOCH = 1_024;
export const MAX_SENSITIVE_SCHEDULER_REGISTRATIONS_PER_SESSION = 4_096;
export const MAX_SENSITIVE_PROMISE_OWNER_REGISTRY_OWNERS = 256;

export interface PreparedSensitiveEvidenceRecord {
  readonly navigationGeneration: number;
  readonly dispatchOrdinal: number;
  readonly nodeId: string;
  readonly markerId: string;
  readonly sourceValue: string;
}

export interface SensitiveMaskSnapshotEntry {
  readonly markerId: string;
  readonly maskId: string;
  readonly backendNodeId: number;
}

export interface SensitiveEvidencePageRecordSnapshot {
  readonly markerId: string;
  readonly forms: readonly string[];
  readonly classifiedMaskIds: readonly string[];
  readonly classifiedElementMaskIds: readonly (string | undefined)[];
  readonly classifiedElementTargetIds: readonly (readonly string[])[];
}

export interface SensitiveEvidenceObservedElementMembership {
  readonly maskId?: string;
  readonly targetIds: readonly string[];
  readonly maskable: boolean;
  readonly visible: boolean;
}

export interface SensitiveEvidencePageStateSnapshot {
  readonly status: "ok" | "failed";
  readonly active: boolean;
  readonly poisoned: boolean;
  readonly records: readonly SensitiveEvidencePageRecordSnapshot[];
  readonly observedElementMemberships: readonly SensitiveEvidenceObservedElementMembership[];
}

export interface SensitiveEvidenceRecordInput {
  readonly navigationGeneration: number;
  readonly dispatchOrdinal: number;
  readonly nodeId: string;
  readonly sourceValue: string;
}

export type SensitiveEvidenceAuthorityFailure =
  | "form-limit-exceeded"
  | "form-too-large"
  | "record-limit-exceeded";

export interface SensitiveEvidenceAuthorityResult<T> {
  readonly status: "ok" | "failed";
  readonly value?: T;
  readonly reason?: SensitiveEvidenceAuthorityFailure;
}

export interface SensitiveEvidenceRedactionResult {
  readonly status: "redacted" | "unchanged" | "unavailable";
  readonly value: string;
}

export interface SensitiveEvidenceMaskRefreshRequest {
  readonly markerId: string;
  readonly maskIds: readonly string[];
}

export interface SensitiveEvidenceScanRecord {
  readonly markerId: string;
  readonly forms: readonly string[];
  readonly maskIds: readonly string[];
}

interface SensitiveEvidenceRecord {
  readonly markerId: string;
  readonly navigationGeneration: number;
  readonly dispatchOrdinal: number;
  readonly nodeId: string;
  readonly forms: ReadonlySet<string>;
  readonly maskSnapshot: readonly SensitiveMaskSnapshotEntry[];
}

const encoder = new TextEncoder();

export class SensitiveEvidenceAuthority {
  private readonly records = new Map<string, SensitiveEvidenceRecord>();

  prepare(
    input: SensitiveEvidenceRecordInput,
  ): SensitiveEvidenceAuthorityResult<PreparedSensitiveEvidenceRecord> {
    if (this.records.size >= MAX_SENSITIVE_RECORDS) {
      return { status: "failed", reason: "record-limit-exceeded" };
    }
    if (!isAllowedForm(input.sourceValue)) {
      return { status: "failed", reason: "form-too-large" };
    }
    const markerId = [
      input.navigationGeneration,
      input.dispatchOrdinal,
      input.nodeId,
    ].join(":");
    return {
      status: "ok",
      value: {
        navigationGeneration: input.navigationGeneration,
        dispatchOrdinal: input.dispatchOrdinal,
        nodeId: input.nodeId,
        markerId,
        sourceValue: input.sourceValue,
      },
    };
  }

  complete(
    prepared: PreparedSensitiveEvidenceRecord,
    observedForms: readonly string[],
    maskSnapshot: readonly SensitiveMaskSnapshotEntry[],
  ): SensitiveEvidenceAuthorityResult<void> {
    const forms = new Set<string>([prepared.sourceValue]);
    for (const form of observedForms) {
      if (!isAllowedForm(form)) {
        return { status: "failed", reason: "form-too-large" };
      }
      forms.add(form);
      if (forms.size > MAX_FORMS_PER_RECORD) {
        return { status: "failed", reason: "form-limit-exceeded" };
      }
    }
    if (this.records.size >= MAX_SENSITIVE_RECORDS && !this.records.has(prepared.markerId)) {
      return { status: "failed", reason: "record-limit-exceeded" };
    }
    if (maskSnapshot.length === 0 || maskSnapshot.length > MAX_REFLECTED_REGIONS) {
      return { status: "failed", reason: "record-limit-exceeded" };
    }
    const maskIds = new Set<string>();
    for (const entry of maskSnapshot) {
      if (entry.markerId !== prepared.markerId || !isAllowedMaskId(entry.maskId) || !Number.isSafeInteger(entry.backendNodeId) || maskIds.has(entry.maskId)) {
        return { status: "failed", reason: "record-limit-exceeded" };
      }
      maskIds.add(entry.maskId);
    }
    this.records.set(prepared.markerId, {
      markerId: prepared.markerId,
      navigationGeneration: prepared.navigationGeneration,
      dispatchOrdinal: prepared.dispatchOrdinal,
      nodeId: prepared.nodeId,
      forms,
      maskSnapshot: maskSnapshot.map((entry) => ({ ...entry })),
    });
    return { status: "ok" };
  }

  redactField(
    sensitiveTargetIds: readonly string[] | undefined,
    value: string,
    sensitiveMaskId?: string,
  ): SensitiveEvidenceRedactionResult {
    return this.redactFieldWithStatus(sensitiveTargetIds, value, sensitiveMaskId);
  }

  redactMetadataField(
    sensitiveTargetIds: readonly string[] | undefined,
    value: string,
    sensitiveMaskId?: string,
  ): SensitiveEvidenceRedactionResult {
    const result = this.redactFieldWithStatus(sensitiveTargetIds, value, sensitiveMaskId);
    if (result.status !== "unchanged") return result;
    return this.carriesAnySensitiveForm(value)
      ? { status: "redacted", value: REDACTED_SENSITIVE_TEXT }
      : result;
  }

  redactFieldWithStatus(
    sensitiveTargetIds: readonly string[] | undefined,
    value: string,
    sensitiveMaskId?: string,
  ): SensitiveEvidenceRedactionResult {
    const trustedMarkerIds = new Set<string>();
    let maskMatched = false;
    if (sensitiveMaskId !== undefined) {
      for (const record of this.records.values()) {
        if (record.maskSnapshot.some((entry) => entry.maskId === sensitiveMaskId)) {
          trustedMarkerIds.add(record.markerId);
          maskMatched = true;
        }
      }
    }
    let hasUnknownRecord = false;
    for (const markerId of sensitiveTargetIds ?? []) {
      if (!this.records.has(markerId)) {
        hasUnknownRecord = true;
        continue;
      }
      trustedMarkerIds.add(markerId);
    }
    const hasUnknownMaskId = sensitiveMaskId !== undefined && !maskMatched && trustedMarkerIds.size === 0;

    let carriesAnySensitiveForm = false;
    for (const [markerId, record] of this.records) {
      if (!carriesSensitiveForm(value, record.forms)) continue;
      carriesAnySensitiveForm = true;
      if (trustedMarkerIds.has(markerId)) {
        return { status: "redacted", value: REDACTED_SENSITIVE_TEXT };
      }
      if (trustedMarkerIds.size > 0 || hasUnknownRecord || hasUnknownMaskId) {
        return { status: "unavailable", value };
      }
    }

    if (hasUnknownRecord || (carriesAnySensitiveForm && hasUnknownMaskId)) {
      return { status: "unavailable", value };
    }
    return { status: "unchanged", value };
  }

  pendingMaskRefreshRequests(
    snapshot: SensitiveEvidencePageStateSnapshot,
    pendingMarkerIds: readonly string[],
  ): readonly SensitiveEvidenceMaskRefreshRequest[] | undefined {
    const validation = this.validatePendingPageStateSnapshot(snapshot, pendingMarkerIds, "allow-extra-masks");
    if (validation === undefined) return undefined;
    return validation.refreshRequests;
  }

  refreshPendingMaskSnapshot(markerId: string, maskSnapshot: readonly SensitiveMaskSnapshotEntry[]): boolean {
    const record = this.records.get(markerId);
    if (record === undefined || maskSnapshot.length === 0 || maskSnapshot.length > MAX_REFLECTED_REGIONS) return false;
    const maskIds = new Set<string>();
    for (const entry of maskSnapshot) {
      if (entry.markerId !== markerId || !isAllowedMaskId(entry.maskId) || !Number.isSafeInteger(entry.backendNodeId) || maskIds.has(entry.maskId)) {
        return false;
      }
      maskIds.add(entry.maskId);
    }
    this.records.set(markerId, {
      ...record,
      maskSnapshot: maskSnapshot.map((entry) => ({ ...entry })),
    });
    return true;
  }

  validatePendingPageState(
    snapshot: SensitiveEvidencePageStateSnapshot,
    pendingMarkerIds: readonly string[],
  ): boolean {
    return this.validatePendingPageStateSnapshot(snapshot, pendingMarkerIds, "exact") !== undefined;
  }

  private carriesAnySensitiveForm(value: string): boolean {
    for (const record of this.records.values()) {
      if (carriesSensitiveForm(value, record.forms)) return true;
    }
    return false;
  }

  private validatePendingPageStateSnapshot(
    snapshot: SensitiveEvidencePageStateSnapshot,
    pendingMarkerIds: readonly string[],
    mode: "exact" | "allow-extra-masks",
  ): { readonly refreshRequests: readonly SensitiveEvidenceMaskRefreshRequest[] } | undefined {
    if (pendingMarkerIds.length === 0) return { refreshRequests: [] };
    if (snapshot.status !== "ok" || snapshot.active || snapshot.poisoned) return undefined;
    const pendingMarkers = new Set(pendingMarkerIds);
    if (pendingMarkers.size !== pendingMarkerIds.length) return undefined;
    if (snapshot.records.length !== pendingMarkerIds.length) return undefined;
    const expectedMaskOwnerById = new Map<string, string>();
    const acceptedMaskIdsByMarker = new Map<string, readonly string[]>();
    const seenPageRecords = new Set<string>();
    const refreshRequests: SensitiveEvidenceMaskRefreshRequest[] = [];
    for (const pageRecord of snapshot.records) {
      if (!pendingMarkers.has(pageRecord.markerId) || seenPageRecords.has(pageRecord.markerId)) return undefined;
      seenPageRecords.add(pageRecord.markerId);
      const record = this.records.get(pageRecord.markerId);
      if (record === undefined) return undefined;
      if (!sameStringSet(pageRecord.forms, [...record.forms])) return undefined;
      const currentMaskIds = record.maskSnapshot.map((entry) => entry.maskId);
      const pageElementMaskIds = pageRecord.classifiedElementMaskIds.filter((entry): entry is string => entry !== undefined);
      if (mode === "exact") {
        if (!sameStringSet(pageRecord.classifiedMaskIds, currentMaskIds)) return undefined;
        if (!sameStringSet(pageElementMaskIds, currentMaskIds)) return undefined;
        acceptedMaskIdsByMarker.set(pageRecord.markerId, currentMaskIds);
      } else {
        if (!sameStringSet(pageRecord.classifiedMaskIds, pageElementMaskIds)) return undefined;
        if (!containsAllStrings(pageRecord.classifiedMaskIds, currentMaskIds)) return undefined;
        acceptedMaskIdsByMarker.set(pageRecord.markerId, pageRecord.classifiedMaskIds);
        if (!sameStringSet(pageRecord.classifiedMaskIds, currentMaskIds)) {
          refreshRequests[refreshRequests.length] = { markerId: pageRecord.markerId, maskIds: pageRecord.classifiedMaskIds };
        }
      }
      const acceptedMaskIds = acceptedMaskIdsByMarker.get(pageRecord.markerId)!;
      for (const maskId of acceptedMaskIds) {
        if (expectedMaskOwnerById.has(maskId)) return undefined;
        expectedMaskOwnerById.set(maskId, pageRecord.markerId);
      }
      if (pageRecord.classifiedElementTargetIds.length !== acceptedMaskIds.length) return undefined;
      for (const targetIds of pageRecord.classifiedElementTargetIds) {
        if (!targetIds.includes(pageRecord.markerId) || !allKnownMarkers(targetIds, this.records)) return undefined;
      }
    }
    if (seenPageRecords.size !== pendingMarkerIds.length) return undefined;
    const observedExpectedMaskIds = new Set<string>();
    for (const membership of snapshot.observedElementMemberships) {
      if (!sameStringSet(membership.targetIds, membership.targetIds)) return undefined;
      const pendingTargetIds = membership.targetIds.filter((targetId) => pendingMarkers.has(targetId));
      if (pendingTargetIds.length === 0) continue;
      if (!allKnownMarkers(membership.targetIds, this.records)) return undefined;
      const markerId = pendingTargetIds[0];
      if (markerId === undefined || !sameStringSet(pendingTargetIds, [markerId])) return undefined;
      const acceptedMaskIds = acceptedMaskIdsByMarker.get(markerId);
      if (acceptedMaskIds === undefined) return undefined;
      if (!membership.maskable) continue;
      if (membership.maskId === undefined || !acceptedMaskIds.includes(membership.maskId)) return undefined;
      const expectedOwner = expectedMaskOwnerById.get(membership.maskId);
      if (expectedOwner !== markerId) return undefined;
      if (observedExpectedMaskIds.has(membership.maskId)) return undefined;
      observedExpectedMaskIds.add(membership.maskId);
    }
    for (const maskId of expectedMaskOwnerById.keys()) {
      if (!observedExpectedMaskIds.has(maskId)) return undefined;
    }
    return { refreshRequests };
  }

  hasSensitiveMaskId(maskId: string | undefined): boolean {
    if (maskId === undefined) return false;
    for (const record of this.records.values()) {
      if (record.maskSnapshot.some((entry) => entry.maskId === maskId)) return true;
    }
    return false;
  }

  maskSnapshot(): readonly SensitiveMaskSnapshotEntry[] {
    return [...this.records.values()].flatMap((record) => record.maskSnapshot.map((entry) => ({ ...entry })));
  }

  scanRecords(): readonly SensitiveEvidenceScanRecord[] {
    return [...this.records.values()].map((record) => ({
      markerId: record.markerId,
      forms: [...record.forms],
      maskIds: record.maskSnapshot.map((entry) => entry.maskId),
    }));
  }

  clear(): void {
    this.records.clear();
  }
}

function isAllowedForm(value: string): boolean {
  return encoder.encode(value).byteLength <= MAX_FORM_BYTES;
}

function isAllowedMaskId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function allKnownMarkers(candidates: readonly string[], records: ReadonlyMap<string, SensitiveEvidenceRecord>): boolean {
  for (const value of candidates) {
    if (!records.has(value)) return false;
  }
  return true;
}

function containsAllStrings(candidates: readonly string[], expected: readonly string[]): boolean {
  for (const value of expected) {
    if (!candidates.includes(value)) return false;
  }
  return true;
}

function sameStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const seen = new Set<string>();
  for (const value of actual) {
    if (seen.has(value)) return false;
    seen.add(value);
  }
  for (const value of expected) {
    if (!seen.has(value)) return false;
  }
  return true;
}

function carriesSensitiveForm(value: string, forms: ReadonlySet<string>): boolean {
  if (forms.has(value)) return true;
  for (const form of forms) {
    if (form !== "" && value.includes(form)) return true;
  }
  return false;
}

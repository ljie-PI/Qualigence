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

export interface SensitiveEvidencePageStateSnapshot {
  readonly status: "ok" | "failed";
  readonly active: boolean;
  readonly poisoned: boolean;
  readonly records: readonly SensitiveEvidencePageRecordSnapshot[];
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
    }

    if (hasUnknownRecord || (carriesAnySensitiveForm && hasUnknownMaskId)) {
      return { status: "unavailable", value };
    }
    return { status: "unchanged", value };
  }

  validatePendingPageState(
    snapshot: SensitiveEvidencePageStateSnapshot,
    pendingMarkerIds: readonly string[],
  ): boolean {
    if (pendingMarkerIds.length === 0) return true;
    if (snapshot.status !== "ok" || snapshot.active || snapshot.poisoned) return false;
    for (const markerId of pendingMarkerIds) {
      const record = this.records.get(markerId);
      const pageRecord = snapshot.records.find((candidate) => candidate.markerId === markerId);
      if (record === undefined || pageRecord === undefined) return false;
      if (!containsAll(pageRecord.forms, record.forms)) return false;
      const expectedMaskIds = record.maskSnapshot.map((entry) => entry.maskId);
      if (!sameStringSet(pageRecord.classifiedMaskIds, expectedMaskIds)) return false;
      if (!sameStringSet(pageRecord.classifiedElementMaskIds.filter((entry): entry is string => entry !== undefined), expectedMaskIds)) return false;
      if (pageRecord.classifiedElementTargetIds.length !== expectedMaskIds.length) return false;
      for (const targetIds of pageRecord.classifiedElementTargetIds) {
        if (!targetIds.includes(markerId)) return false;
      }
    }
    return true;
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

function containsAll(candidates: readonly string[], expected: ReadonlySet<string>): boolean {
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

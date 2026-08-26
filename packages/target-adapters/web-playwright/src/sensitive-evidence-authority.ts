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
    for (const entry of maskSnapshot) {
      if (entry.markerId !== prepared.markerId || !isAllowedMaskId(entry.maskId) || !Number.isSafeInteger(entry.backendNodeId)) {
        return { status: "failed", reason: "record-limit-exceeded" };
      }
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
  ): string {
    return this.redactFieldWithStatus(sensitiveTargetIds, value).value;
  }

  redactFieldWithStatus(
    sensitiveTargetIds: readonly string[] | undefined,
    value: string,
  ): SensitiveEvidenceRedactionResult {
    if (sensitiveTargetIds === undefined || sensitiveTargetIds.length === 0) {
      return { status: "unchanged", value };
    }
    let hasUnknownRecord = false;
    for (const markerId of sensitiveTargetIds) {
      const record = this.records.get(markerId);
      if (record === undefined) {
        hasUnknownRecord = true;
        continue;
      }
      if (carriesSensitiveForm(value, record.forms)) {
        return { status: "redacted", value: REDACTED_SENSITIVE_TEXT };
      }
    }
    return hasUnknownRecord
      ? { status: "unavailable", value }
      : { status: "unchanged", value };
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

function carriesSensitiveForm(value: string, forms: ReadonlySet<string>): boolean {
  if (forms.has(value)) return true;
  for (const form of forms) {
    if (form !== "" && value.includes(form)) return true;
  }
  return false;
}

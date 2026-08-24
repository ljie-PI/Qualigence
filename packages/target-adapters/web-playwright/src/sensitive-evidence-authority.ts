export const REDACTED_SENSITIVE_TEXT = "[redacted]";
export const SENSITIVE_TARGET_IDS_PROPERTY = "__qualigenceSensitiveTargetIds";

const MAX_SENSITIVE_RECORDS = 100;
const MAX_FORMS_PER_RECORD = 4;
const MAX_FORM_BYTES = 64 * 1024;

export interface PreparedSensitiveEvidenceRecord {
  readonly navigationGeneration: number;
  readonly dispatchOrdinal: number;
  readonly nodeId: string;
  readonly markerId: string;
  readonly sourceValue: string;
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

interface SensitiveEvidenceRecord {
  readonly markerId: string;
  readonly navigationGeneration: number;
  readonly dispatchOrdinal: number;
  readonly nodeId: string;
  readonly forms: ReadonlySet<string>;
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
    this.records.set(prepared.markerId, {
      markerId: prepared.markerId,
      navigationGeneration: prepared.navigationGeneration,
      dispatchOrdinal: prepared.dispatchOrdinal,
      nodeId: prepared.nodeId,
      forms,
    });
    return { status: "ok" };
  }

  redactField(
    sensitiveTargetIds: readonly string[] | undefined,
    value: string,
  ): string {
    if (sensitiveTargetIds === undefined || sensitiveTargetIds.length === 0) {
      return value;
    }
    for (const markerId of sensitiveTargetIds) {
      const record = this.records.get(markerId);
      if (record !== undefined && record.forms.has(value)) {
        return REDACTED_SENSITIVE_TEXT;
      }
    }
    return value;
  }

  clear(): void {
    this.records.clear();
  }
}

function isAllowedForm(value: string): boolean {
  return encoder.encode(value).byteLength <= MAX_FORM_BYTES;
}

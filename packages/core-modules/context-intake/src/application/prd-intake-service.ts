import type { Clock, Result } from "@qualigence/shared-kernel";
import {
  PrdDocument,
  sha256Hex,
  uuidv7,
} from "../domain/prd-document.js";

export interface IngestPrdInput {
  /** Stable logical identity. When omitted, projectId + title identifies the PRD. */
  readonly prdId?: string;
  readonly projectId: string;
  readonly title: string;
  readonly content: string;
}

export type PrdIntakeErrorCode = "PrdEmpty";

export interface PrdIntakeError {
  readonly code: PrdIntakeErrorCode;
  readonly message: string;
}

/**
 * Ingests raw PRD text into immutable {@link PrdDocument} revisions.
 *
 * Re-ingesting byte-identical content for the same logical PRD is idempotent
 * (returns the existing revision); changed content produces the next revision.
 * Identity is never mutated in place — no last-writer-wins.
 */
export class PrdIntakeService {
  readonly #clock: Clock;
  readonly #idFactory: () => string;
  readonly #latestByKey = new Map<string, PrdDocument>();

  constructor(clock: Clock, idFactory: () => string = uuidv7) {
    this.#clock = clock;
    this.#idFactory = idFactory;
  }

  async ingest(
    input: IngestPrdInput,
  ): Promise<Result<PrdDocument, PrdIntakeError>> {
    if (input.content.length === 0) {
      return {
        ok: false,
        error: { code: "PrdEmpty", message: "PRD content must not be empty." },
      };
    }

    const logicalKey =
      input.prdId ?? `${input.projectId}\u0000${input.title}`;
    const existing = this.#latestByKey.get(logicalKey);
    const contentSha256 = sha256Hex(input.content);

    if (existing !== undefined && existing.contentSha256 === contentSha256) {
      return { ok: true, value: existing };
    }

    const prdId = existing?.prdId ?? input.prdId ?? this.#idFactory();
    const revision = existing === undefined ? 1 : existing.revision + 1;

    const document = PrdDocument.create(
      {
        prdId,
        projectId: input.projectId,
        revision,
        title: input.title,
        content: input.content,
      },
      this.#clock,
    );

    this.#latestByKey.set(logicalKey, document);
    return { ok: true, value: document };
  }
}

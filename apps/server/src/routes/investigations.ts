import type { FastifyInstance } from "fastify";
import type { InvestigationDto } from "@qualigence/public-api";
import {
  authenticateOidc,
  requireRole,
  withTenant,
  type ServerDeps,
} from "../server-context.js";
import { listEnvelope } from "../envelopes.js";
import { notFound } from "../errors.js";

interface CaseRow {
  case_id: string;
  finding_id: string;
  status: string;
  version: number;
  evidence_completeness?: string | null;
}

async function loadAttemptIds(
  stores: { db: { selectFrom: (t: "investigation_attempts") => any } },
  caseId: string,
): Promise<string[]> {
  const rows = await stores.db
    .selectFrom("investigation_attempts")
    .select("attempt_id")
    .where("case_id", "=", caseId)
    .orderBy("ordinal", "asc")
    .execute();
  return rows.map((row: { attempt_id: string }) => row.attempt_id);
}

function toDto(row: CaseRow, attemptIds: readonly string[]): InvestigationDto {
  const completeness = (row.evidence_completeness ?? "limited") as InvestigationDto["evidenceCompleteness"];
  return {
    caseId: row.case_id,
    findingId: row.finding_id,
    status: row.status as InvestigationDto["status"],
    attemptIds: [...attemptIds],
    evidenceCompleteness: completeness,
    version: row.version,
  };
}

export function registerInvestigationRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get<{ Params: { caseId: string } }>(
    "/v1/investigations/:caseId",
    async (request, reply) => {
      const principal = await authenticateOidc(deps, request);
      requireRole(deps, principal, "viewer");
      const dto = await withTenant(deps, principal.tenantId, async (stores) => {
        const row = (await stores.db
          .selectFrom("investigation_cases")
          .select(["case_id", "finding_id", "status", "version"])
          .where("case_id", "=", request.params.caseId)
          .executeTakeFirst()) as CaseRow | undefined;
        if (row === undefined) {
          return undefined;
        }
        const attemptIds = await loadAttemptIds(stores as never, request.params.caseId);
        return toDto(row, attemptIds);
      });
      if (dto === undefined) {
        throw notFound("investigation case not found");
      }
      return reply.send(dto);
    },
  );

  app.get("/v1/investigations", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "viewer");
    const rows = await withTenant(deps, principal.tenantId, (stores) =>
      (stores.db
        .selectFrom("investigation_cases")
        .select(["case_id", "finding_id", "status", "version"])
        .orderBy("created_at", "asc")
        .execute()) as Promise<CaseRow[]>,
    );
    return reply.send(listEnvelope(rows.map((row) => toDto(row, [])), deps.clock.now()));
  });
}

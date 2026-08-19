import { z } from "zod";

const canonicalInstant = z.string().refine((value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
});

export const localStopRequestSchema = z.object({
  version: z.literal("local-stop-request/v1"),
  supervisorPid: z.number().int().positive().safe(),
  corePid: z.number().int().positive().safe(),
  runnerPid: z.number().int().positive().safe(),
  startedAt: canonicalInstant,
  requestedAt: canonicalInstant,
}).strict();

export type LocalStopRequest = z.infer<typeof localStopRequestSchema>;

import type {
  CommandEnvelope,
  ListEnvelope,
} from "@qualigence/public-api";

export function listEnvelope<T>(
  items: readonly T[],
  now: string,
  nextCursor?: string,
): ListEnvelope<T> {
  return {
    items,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    asOfEvent: 0,
    asOfTime: now,
    lagMs: 0,
  };
}

export function commandEnvelope<T>(
  resource: T,
  version: number,
  correlationId: string,
): CommandEnvelope<T> {
  return { resource, version, correlationId };
}

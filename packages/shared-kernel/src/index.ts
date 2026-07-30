export type Brand<TValue, TBrand extends string> = TValue & {
  readonly __brand: TBrand;
};

export type Instant = string;
export type IdempotencyKey = Brand<string, "IdempotencyKey">;

export interface DomainEvent<TPayload = unknown> {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: Instant;
  readonly payload: TPayload;
}

export type Result<TValue, TError> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: TError };

export interface Clock {
  now(): Instant;
}

export class SystemClock implements Clock {
  now(): Instant {
    return new Date().toISOString();
  }
}

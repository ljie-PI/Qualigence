/** A promise plus its externally callable resolve/reject handles. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

/**
 * A single-consumer FIFO queue whose `take` awaits until an item is pushed. Used
 * for unsolicited frames (a Runner awaiting its next Offer). Once `fail` is
 * called the queue rejects all current and future takers, so a dropped
 * connection surfaces as a rejected `nextOffer` rather than a hang.
 */
export class AsyncBlockingQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<Deferred<T>> = [];
  private failure: unknown;
  private failed = false;

  push(item: T): void {
    if (this.failed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(item);
    } else {
      this.items.push(item);
    }
  }

  take(signal?: AbortSignal): Promise<T> {
    if (this.items.length > 0) {
      return Promise.resolve(this.items.shift() as T);
    }
    if (this.failed) {
      return Promise.reject(this.failure);
    }
    const deferred = createDeferred<T>();
    if (signal) {
      if (signal.aborted) {
        return Promise.reject(signal.reason ?? new Error("aborted"));
      }
      const onAbort = (): void => {
        const index = this.waiters.indexOf(deferred);
        if (index !== -1) this.waiters.splice(index, 1);
        deferred.reject(signal.reason ?? new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void deferred.promise
        .finally(() => signal.removeEventListener("abort", onAbort))
        .catch(() => undefined);
    }
    this.waiters.push(deferred);
    return deferred.promise;
  }

  fail(reason: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.failure = reason;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(reason);
    }
  }
}

/**
 * A counting semaphore that bounds concurrent, in-flight work. Producers `await`
 * a permit and never proceed past the limit, so the outbound Trace queue applies
 * genuine backpressure instead of dropping batches. gRPC flow control governs the
 * transport; this governs the application-level Ack window.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = Math.max(1, permits);
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return this.release.bind(this);
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.available -= 1;
    return this.release.bind(this);
  }

  private release(): void {
    this.available += 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

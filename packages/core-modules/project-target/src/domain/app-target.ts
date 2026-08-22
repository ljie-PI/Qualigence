import {
  validateAppTarget,
  type AppTarget,
} from "@qualigence/desktop-contracts";

/**
 * The AppTarget configuration aggregate (LS-13 Core, `@qualigence/project-target`).
 *
 * Core owns AppTarget *configuration*: which desktop application a project may
 * drive and its canonical launch/reset/shutdown lifecycle. This aggregate never
 * launches a process or holds a native handle — that is exclusively the Rust
 * Companion's job. It only validates and versions the configuration, applying
 * the same expected-version optimistic-concurrency discipline as the other Core
 * aggregates so a stale writer can never silently clobber a newer revision.
 */

export type ProjectTargetErrorCode =
  | "AppTargetVersionConflict"
  | "InvalidAppTargetConfiguration"
  | "TargetVersionConflict"
  | "TargetIdempotencyConflict"
  | "InvalidTargetConfiguration"
  | "TargetSecretRejected";

export class ProjectTargetError extends Error {
  readonly code: ProjectTargetErrorCode;
  readonly currentVersion?: number;

  constructor(
    code: ProjectTargetErrorCode,
    message: string,
    context: { readonly currentVersion?: number } = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "ProjectTargetError";
    this.code = code;
    if (context.currentVersion !== undefined) {
      this.currentVersion = context.currentVersion;
    }
  }
}

export interface UpdateAppTargetCommand {
  readonly expectedVersion: number;
  readonly target: unknown;
}

/** The immutable event emitted when an AppTarget configuration changes. */
export interface AppTargetChanged {
  readonly target: AppTarget;
  readonly version: number;
}

export const AppTargetChanged = {
  from(target: AppTarget, version: number): AppTargetChanged {
    return Object.freeze({ target, version });
  },
} as const;

export class AppTargetAggregate {
  #target: AppTarget | undefined;
  #version: number;

  private constructor(target: AppTarget | undefined, version: number) {
    this.#target = target;
    this.#version = version;
  }

  /** A brand-new, unconfigured aggregate at version 0. */
  static create(): AppTargetAggregate {
    return new AppTargetAggregate(undefined, 0);
  }

  /** Rehydrate from a persisted configuration + version. */
  static rehydrate(target: AppTarget, version: number): AppTargetAggregate {
    return new AppTargetAggregate(target, version);
  }

  get version(): number {
    return this.#version;
  }

  get target(): AppTarget | undefined {
    return this.#target;
  }

  update(command: UpdateAppTargetCommand): AppTargetChanged {
    this.#assertExpectedVersion(command.expectedVersion);
    let validated: AppTarget;
    try {
      validated = validateAppTarget(command.target);
    } catch (error) {
      throw new ProjectTargetError(
        "InvalidAppTargetConfiguration",
        error instanceof Error ? error.message : "invalid AppTarget",
      );
    }
    this.#target = validated;
    this.#version += 1;
    return AppTargetChanged.from(validated, this.#version);
  }

  #assertExpectedVersion(expectedVersion: number): void {
    if (expectedVersion !== this.#version) {
      throw new ProjectTargetError(
        "AppTargetVersionConflict",
        `expected version ${expectedVersion} but aggregate is at ${this.#version}`,
        { currentVersion: this.#version },
      );
    }
  }
}

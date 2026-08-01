/**
 * The lossless `uia/v1` capture *source* the Rust Companion returns from a
 * bounded UIA worker capture. It mirrors `apps/companion/src/uia/protocol.rs`
 * exactly (camelCase field-for-field): TypeScript never holds a native UIA
 * element, it only ever receives this already-serialised, secret-masked DTO
 * over the authenticated Companion IPC.
 *
 * This type is deliberately platform-neutral in shape — every UIA-specific field
 * is preserved so the mapper can put common fields into the Observation Graph v1
 * core and the raw UIA facts into the `uia/v1` extension without loss.
 */

import type { UiaPatternDescriptor } from "@qualigence/desktop-contracts";

export interface UiaSourceBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface UiaSourceNode {
  readonly nodeId: string;
  /** Generic, cross-platform role already mapped from `controlTypeId`. */
  readonly role: string;
  readonly controlTypeId: number;
  readonly name?: string;
  readonly value?: string;
  readonly automationId?: string;
  readonly frameworkId?: string;
  readonly className?: string;
  readonly nativeWindowHandle?: string;
  readonly processId: number;
  readonly isOffscreen: boolean;
  readonly isKeyboardFocusable: boolean;
  readonly hasKeyboardFocus: boolean;
  /**
   * True for password / protected edit controls. The Companion has ALREADY
   * masked {@link value} before it left the worker; this flag lets the mapper
   * set the node sensitivity to `secret` and drop the value entirely.
   */
  readonly isPassword: boolean;
  readonly bounds?: UiaSourceBounds;
  readonly patterns: readonly UiaPatternDescriptor[];
  /** Child node ids in document order. */
  readonly children: readonly string[];
}

export interface UiaSource {
  readonly sessionId: string;
  readonly capturedAt: string;
  readonly rootNodeIds: readonly string[];
  readonly nodes: readonly UiaSourceNode[];
}

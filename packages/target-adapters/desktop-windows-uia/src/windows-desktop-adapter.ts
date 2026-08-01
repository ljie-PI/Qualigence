/**
 * The Windows Desktop sensor adapter: it asks the Companion to capture a bounded
 * `uia/v1` source and maps it into a validated Observation Graph v1. It holds no
 * native handle and imports nothing Windows-specific — the entire OS boundary
 * lives in the Rust Companion.
 */

import type { ObservationGraphV1 } from "@qualigence/observation-contracts";
import type { CompanionClient } from "./companion-client.js";
import { mapUiaPayloadToObservationV1 } from "./uia-mapping.js";

export const DESKTOP_WINDOWS_UIA_ADAPTER_ID = "desktop-windows-uia" as const;

export interface WindowsDesktopCaptureRequest {
  readonly sessionId: string;
  readonly deadlineMs: number;
  readonly evidenceRefs?: readonly string[];
}

export class WindowsDesktopAdapter {
  constructor(private readonly companion: CompanionClient) {}

  async capture(request: WindowsDesktopCaptureRequest): Promise<ObservationGraphV1> {
    const source = await this.companion.capture({
      sessionId: request.sessionId,
      deadlineMs: request.deadlineMs,
    });
    return mapUiaPayloadToObservationV1(source, {
      adapterId: DESKTOP_WINDOWS_UIA_ADAPTER_ID,
      ...(request.evidenceRefs === undefined ? {} : { evidenceRefs: request.evidenceRefs }),
    });
  }
}

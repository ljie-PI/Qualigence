const MAGIC = Buffer.from("QLGBOOT1", "ascii");

export const BOOTSTRAP_FRAME_BYTES = 100;
export const BOOTSTRAP_FRAME_HEADER_BYTES = 20;
export const BOOTSTRAP_FRAME_BODY_BYTES = 80;
export const BOOTSTRAP_CREDENTIAL_BYTES = 32;

export type BootstrapFrameParserErrorCode =
  | "BootstrapFrameMagicMismatch"
  | "BootstrapFrameVersionUnsupported"
  | "BootstrapFrameHeaderLengthInvalid"
  | "BootstrapFrameTotalLengthInvalid"
  | "BootstrapFrameBodyLengthInvalid"
  | "BootstrapFrameTimestampInvalid";

export type BootstrapFrameCollectorErrorCode =
  | "BootstrapFrameMissing"
  | "BootstrapFrameTruncated"
  | "BootstrapFrameTrailingBytes"
  | "BootstrapFrameTimedOut"
  | "BootstrapFrameIoFailed";

export class BootstrapFrameError extends Error {
  constructor(readonly code: BootstrapFrameParserErrorCode | BootstrapFrameCollectorErrorCode) {
    super(code);
    this.name = "BootstrapFrameError";
  }
}

export interface BootstrapFrameInput {
  readonly userBootstrap: Uint8Array;
  readonly supervisor: Uint8Array;
  readonly createdAtEpochMs: number;
  readonly userExpiresAtEpochMs: number;
}

export interface ParsedBootstrapFrame extends BootstrapFrameInput {
  destroy(): void;
}

function validEpoch(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function encodeBootstrapFrame(input: BootstrapFrameInput): Buffer {
  if (
    input.userBootstrap.byteLength !== BOOTSTRAP_CREDENTIAL_BYTES ||
    input.supervisor.byteLength !== BOOTSTRAP_CREDENTIAL_BYTES
  ) {
    throw new BootstrapFrameError("BootstrapFrameBodyLengthInvalid");
  }
  if (
    !validEpoch(input.createdAtEpochMs) ||
    !validEpoch(input.userExpiresAtEpochMs) ||
    input.createdAtEpochMs >= input.userExpiresAtEpochMs
  ) {
    throw new BootstrapFrameError("BootstrapFrameTimestampInvalid");
  }
  const frame = Buffer.alloc(BOOTSTRAP_FRAME_BYTES);
  MAGIC.copy(frame, 0);
  frame.writeUInt16BE(1, 8);
  frame.writeUInt16BE(BOOTSTRAP_FRAME_HEADER_BYTES, 10);
  frame.writeUInt32BE(BOOTSTRAP_FRAME_BYTES, 12);
  frame.writeUInt32BE(BOOTSTRAP_FRAME_BODY_BYTES, 16);
  Buffer.from(input.userBootstrap).copy(frame, 20);
  Buffer.from(input.supervisor).copy(frame, 52);
  frame.writeBigInt64BE(BigInt(input.createdAtEpochMs), 84);
  frame.writeBigInt64BE(BigInt(input.userExpiresAtEpochMs), 92);
  return frame;
}

export function parseBootstrapFrame(frame: Buffer): ParsedBootstrapFrame {
  try {
    if (frame.byteLength !== BOOTSTRAP_FRAME_BYTES) {
      throw new BootstrapFrameError("BootstrapFrameTotalLengthInvalid");
    }
    if (!frame.subarray(0, 8).equals(MAGIC)) {
      throw new BootstrapFrameError("BootstrapFrameMagicMismatch");
    }
    if (frame.readUInt16BE(8) !== 1) {
      throw new BootstrapFrameError("BootstrapFrameVersionUnsupported");
    }
    if (frame.readUInt16BE(10) !== BOOTSTRAP_FRAME_HEADER_BYTES) {
      throw new BootstrapFrameError("BootstrapFrameHeaderLengthInvalid");
    }
    if (frame.readUInt32BE(12) !== BOOTSTRAP_FRAME_BYTES) {
      throw new BootstrapFrameError("BootstrapFrameTotalLengthInvalid");
    }
    if (frame.readUInt32BE(16) !== BOOTSTRAP_FRAME_BODY_BYTES) {
      throw new BootstrapFrameError("BootstrapFrameBodyLengthInvalid");
    }
    const createdAtEpochMs = Number(frame.readBigInt64BE(84));
    const userExpiresAtEpochMs = Number(frame.readBigInt64BE(92));
    if (
      !validEpoch(createdAtEpochMs) ||
      !validEpoch(userExpiresAtEpochMs) ||
      createdAtEpochMs >= userExpiresAtEpochMs
    ) {
      throw new BootstrapFrameError("BootstrapFrameTimestampInvalid");
    }
    return {
      userBootstrap: frame.subarray(20, 52),
      supervisor: frame.subarray(52, 84),
      createdAtEpochMs,
      userExpiresAtEpochMs,
      destroy: () => frame.fill(0),
    };
  } catch (error) {
    frame.fill(0);
    if (error instanceof BootstrapFrameError) throw error;
    throw new BootstrapFrameError("BootstrapFrameTimestampInvalid");
  }
}

export function encodeBootstrapCredential(bytes: Uint8Array): string {
  if (bytes.byteLength !== BOOTSTRAP_CREDENTIAL_BYTES) {
    throw new Error("Credential must contain exactly 32 bytes.");
  }
  return Buffer.from(bytes).toString("base64url");
}

export function decodeBootstrapCredential(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("Credential encoding is invalid.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== BOOTSTRAP_CREDENTIAL_BYTES || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    throw new Error("Credential encoding is invalid.");
  }
  return decoded;
}

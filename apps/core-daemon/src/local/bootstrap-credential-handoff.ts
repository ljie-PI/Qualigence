import type { Readable } from "node:stream";
import { BOOTSTRAP_FRAME_BODY_BYTES, BOOTSTRAP_FRAME_BYTES, BOOTSTRAP_FRAME_HEADER_BYTES, BootstrapFrameError, parseBootstrapFrame } from "@qualigence/local-control";

export async function collectBootstrapCredentialHandoff(stream: Readable, timeoutMs: number) {
  const header = Buffer.alloc(BOOTSTRAP_FRAME_HEADER_BYTES);
  let frame: Buffer | undefined;
  let offset = 0;
  let ended = false;
  let streamError: unknown;
  const onEnd = (): void => { ended = true; };
  const onError = (error: unknown): void => { streamError = error; };
  stream.once("end", onEnd);
  stream.once("error", onError);
  const deadline = Date.now() + timeoutMs;
  try {
    offset = await readExact(stream, header, offset, BOOTSTRAP_FRAME_HEADER_BYTES, deadline, () => ended, () => streamError);
    if (offset === 0) throw new BootstrapFrameError("BootstrapFrameMissing");
    if (offset < BOOTSTRAP_FRAME_HEADER_BYTES) throw new BootstrapFrameError("BootstrapFrameTruncated");
    validateHeader(header);
    frame = Buffer.alloc(BOOTSTRAP_FRAME_BYTES);
    header.copy(frame);
    header.fill(0);
    offset = await readExact(stream, frame, offset, BOOTSTRAP_FRAME_BYTES, deadline, () => ended, () => streamError);
    if (offset < BOOTSTRAP_FRAME_BYTES) throw new BootstrapFrameError("BootstrapFrameTruncated");
    if (readTrailing(stream)) throw new BootstrapFrameError("BootstrapFrameTrailingBytes");
    if (!ended) {
      await waitForReadableOrEnd(stream, deadline, () => ended, () => streamError);
      if (readTrailing(stream)) throw new BootstrapFrameError("BootstrapFrameTrailingBytes");
    }
    return parseBootstrapFrame(frame);
  } catch (error) {
    header.fill(0);
    frame?.fill(0);
    if (error instanceof BootstrapFrameError) throw error;
    throw new BootstrapFrameError("BootstrapFrameIoFailed");
  } finally {
    header.fill(0);
    stream.off("end", onEnd);
    stream.off("error", onError);
    stream.destroy();
  }
}

function readTrailing(stream: Readable): boolean {
  const trailing = stream.read(1) as Buffer | string | null;
  if (trailing === null) return false;
  const bytes = Buffer.isBuffer(trailing) ? trailing : Buffer.from(trailing);
  bytes.fill(0);
  return true;
}

function validateHeader(frame: Buffer): void {
  if (!frame.subarray(0, 8).equals(Buffer.from("QLGBOOT1", "ascii"))) throw new BootstrapFrameError("BootstrapFrameMagicMismatch");
  if (frame.readUInt16BE(8) !== 1) throw new BootstrapFrameError("BootstrapFrameVersionUnsupported");
  if (frame.readUInt16BE(10) !== BOOTSTRAP_FRAME_HEADER_BYTES) throw new BootstrapFrameError("BootstrapFrameHeaderLengthInvalid");
  if (frame.readUInt32BE(12) !== BOOTSTRAP_FRAME_BYTES) throw new BootstrapFrameError("BootstrapFrameTotalLengthInvalid");
  if (frame.readUInt32BE(16) !== BOOTSTRAP_FRAME_BODY_BYTES) throw new BootstrapFrameError("BootstrapFrameBodyLengthInvalid");
}

async function readExact(stream: Readable, target: Buffer, start: number, end: number, deadline: number, ended: () => boolean, streamError: () => unknown): Promise<number> {
  let offset = start;
  while (offset < end) {
    const chunk = stream.read(end - offset) as Buffer | string | null;
    if (chunk !== null) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes.copy(target, offset);
      offset += bytes.byteLength;
      bytes.fill(0);
      continue;
    }
    if (streamError() !== undefined) throw streamError();
    if (ended()) return offset;
    await waitForReadableOrEnd(stream, deadline, ended, streamError);
  }
  return offset;
}

async function waitForReadableOrEnd(stream: Readable, deadline: number, ended: () => boolean, streamError: () => unknown): Promise<void> {
  if (ended()) return;
  if (streamError() !== undefined) throw streamError();
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new BootstrapFrameError("BootstrapFrameTimedOut");
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.off("readable", onReadable);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const onReadable = (): void => { cleanup(); resolve(); };
    const onEnd = (): void => { cleanup(); resolve(); };
    const onError = (error: unknown): void => { cleanup(); reject(error); };
    const timer = setTimeout(() => { cleanup(); reject(new BootstrapFrameError("BootstrapFrameTimedOut")); }, remaining);
    timer.unref();
    stream.once("readable", onReadable);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

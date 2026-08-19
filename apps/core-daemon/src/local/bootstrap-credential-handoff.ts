import type { Readable } from "node:stream";
import { BOOTSTRAP_FRAME_BODY_BYTES, BOOTSTRAP_FRAME_BYTES, BOOTSTRAP_FRAME_HEADER_BYTES, BootstrapFrameError, parseBootstrapFrame } from "@qualigence/local-control";

export async function collectBootstrapCredentialHandoff(stream: Readable, timeoutMs: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new BootstrapFrameError("BootstrapFrameTimedOut")), timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([(async () => { for await (const value of stream) { const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); chunks.push(chunk); size += chunk.byteLength; if (size > BOOTSTRAP_FRAME_BYTES) throw new BootstrapFrameError("BootstrapFrameTrailingBytes"); } })(), deadline]);
    if (size === 0) throw new BootstrapFrameError("BootstrapFrameMissing");
    if (size < BOOTSTRAP_FRAME_HEADER_BYTES) throw new BootstrapFrameError("BootstrapFrameTruncated");
    const header = Buffer.concat(chunks, BOOTSTRAP_FRAME_HEADER_BYTES);
    try {
      if (header.readUInt16BE(10) !== BOOTSTRAP_FRAME_HEADER_BYTES) throw new BootstrapFrameError("BootstrapFrameHeaderLengthInvalid");
      if (header.readUInt32BE(12) !== BOOTSTRAP_FRAME_BYTES) throw new BootstrapFrameError("BootstrapFrameTotalLengthInvalid");
      if (header.readUInt32BE(16) !== BOOTSTRAP_FRAME_BODY_BYTES) throw new BootstrapFrameError("BootstrapFrameBodyLengthInvalid");
    } finally { header.fill(0); }
    if (size < BOOTSTRAP_FRAME_HEADER_BYTES + BOOTSTRAP_FRAME_BODY_BYTES) throw new BootstrapFrameError("BootstrapFrameTruncated");
    return parseBootstrapFrame(Buffer.concat(chunks, BOOTSTRAP_FRAME_BYTES));
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0);
    if (error instanceof BootstrapFrameError) throw error;
    throw new BootstrapFrameError("BootstrapFrameIoFailed");
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    stream.destroy();
  }
}

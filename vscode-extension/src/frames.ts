/** The frames the helper speaks. Mirrors `helper/src/frame.rs`: `[len u32 LE][kind u8][session u32 LE][payload]`. */

export const MAX_FRAME = 2 * 1024 * 1024;
const HEADER = 5;

export const Kind = {
  Spawn: 1,
  Write: 2,
  Resize: 3,
  Kill: 4,
  Pause: 5,
  Resume: 6,
  Ready: 0x80,
  Spawned: 0x81,
  Data: 0x82,
  Exit: 0x83,
  Error: 0x84,
} as const;

export type Frame = { kind: number; session: number; payload: Buffer };

const EMPTY = Buffer.alloc(0);

export function encodeFrame(kind: number, session: number, payload: Uint8Array = EMPTY): Buffer {
  const out = Buffer.allocUnsafe(4 + HEADER + payload.length);
  out.writeUInt32LE(HEADER + payload.length, 0);
  out.writeUInt8(kind, 4);
  out.writeUInt32LE(session, 5);
  out.set(payload, 4 + HEADER);
  return out;
}

export function encodeResize(cols: number, rows: number): Buffer {
  const out = Buffer.allocUnsafe(4);
  out.writeUInt16LE(Math.min(cols, 0xffff), 0);
  out.writeUInt16LE(Math.min(rows, 0xffff), 2);
  return out;
}

export class FrameError extends Error {}

/** Turns the helper's stdout, which arrives in arbitrary pieces, back into frames. */
export class FrameParser {
  private pending: Buffer = EMPTY;

  push(chunk: Buffer): Frame[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      if (this.pending.length < 4) break;
      const length = this.pending.readUInt32LE(0);
      if (length < HEADER || length > MAX_FRAME) {
        throw new FrameError(`frame length ${length} is outside ${HEADER}..${MAX_FRAME}`);
      }
      if (this.pending.length < 4 + length) break;
      frames.push({
        kind: this.pending.readUInt8(4),
        session: this.pending.readUInt32LE(5),
        // Copied, so a long-lived frame does not keep the whole read buffer alive.
        payload: Buffer.from(this.pending.subarray(4 + HEADER, 4 + length)),
      });
      this.pending = this.pending.subarray(4 + length);
    }
    return frames;
  }
}

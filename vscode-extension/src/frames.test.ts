import { describe, expect, it } from "vitest";
import { encodeFrame, encodeResize, FrameError, FrameParser, Kind, MAX_FRAME } from "./frames";

describe("frames", () => {
  it("round-trips a frame", () => {
    const frames = new FrameParser().push(encodeFrame(Kind.Data, 7, Buffer.from("hello")));
    expect(frames).toHaveLength(1);
    expect(frames[0].kind).toBe(Kind.Data);
    expect(frames[0].session).toBe(7);
    expect(frames[0].payload.toString()).toBe("hello");
  });

  it("matches the layout the helper expects: length, kind, session, payload", () => {
    const bytes = encodeFrame(Kind.Write, 0x01020304, Buffer.from([9, 8]));
    expect([...bytes]).toEqual([7, 0, 0, 0, 2, 4, 3, 2, 1, 9, 8]);
  });

  it("finds frames however the stream is cut up", () => {
    const stream = Buffer.concat([
      encodeFrame(Kind.Data, 1, Buffer.from("one")),
      encodeFrame(Kind.Exit, 2, Buffer.from([3, 0, 0, 0])),
      encodeFrame(Kind.Data, 1, Buffer.from("three")),
    ]);
    for (const size of [1, 2, 3, 5, 7, stream.length]) {
      const parser = new FrameParser();
      const seen: string[] = [];
      for (let i = 0; i < stream.length; i += size) {
        for (const f of parser.push(stream.subarray(i, i + size))) seen.push(`${f.kind}:${f.session}:${f.payload.length}`);
      }
      expect(seen, `chunk size ${size}`).toEqual([`${Kind.Data}:1:3`, `${Kind.Exit}:2:4`, `${Kind.Data}:1:5`]);
    }
  });

  it("allows an empty payload", () => {
    const [frame] = new FrameParser().push(encodeFrame(Kind.Kill, 4));
    expect(frame.payload.length).toBe(0);
  });

  it("copies the payload so a frame does not hold on to the whole read buffer", () => {
    const stream = Buffer.concat([encodeFrame(Kind.Data, 1, Buffer.from("a")), encodeFrame(Kind.Data, 1, Buffer.from("b"))]);
    const frames = new FrameParser().push(stream);
    stream.fill(0);
    expect(frames.map((f) => f.payload.toString())).toEqual(["a", "b"]);
  });

  it("rejects lengths outside the allowed range", () => {
    const tooBig = Buffer.alloc(4);
    tooBig.writeUInt32LE(MAX_FRAME + 1, 0);
    expect(() => new FrameParser().push(tooBig)).toThrow(FrameError);
    const tooSmall = Buffer.alloc(4);
    tooSmall.writeUInt32LE(2, 0);
    expect(() => new FrameParser().push(tooSmall)).toThrow(FrameError);
  });

  it("encodes a resize as two little-endian u16", () => {
    expect([...encodeResize(132, 40)]).toEqual([132, 0, 40, 0]);
    expect([...encodeResize(70000, 1)]).toEqual([255, 255, 1, 0]);
  });
});

import { describe, it, expect, vi } from "vitest";

import { __test, probeMp4Duration } from "./mp4-probe.js";

const { parseDurationFromSlice, parseMvhdDuration, findAtomLocal } = __test;

// ── Helpers to build synthetic MP4 byte sequences ─────────────────────────────

function uint32BE(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff;
  b[1] = (n >>> 16) & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = n & 0xff;
  return b;
}

function ascii(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function makeAtom(type: string, payload: Uint8Array): Uint8Array {
  const size = 8 + payload.length;
  return concat(uint32BE(size), ascii(type), payload);
}

function makeMvhdV0(timescale: number, duration: number): Uint8Array {
  // version=0 + flags (3 bytes) + creation_time u32 + modification_time u32
  // + timescale u32 + duration u32 + (rest ignored).
  return concat(
    new Uint8Array([0, 0, 0, 0]), // version 0 + 3 bytes of flags
    uint32BE(0), // creation_time
    uint32BE(0), // modification_time
    uint32BE(timescale),
    uint32BE(duration),
    new Uint8Array(80), // rate, volume, matrix, etc. — irrelevant for us
  );
}

function makeMvhdV1(timescale: number, duration: bigint): Uint8Array {
  const high = Number((duration >> 32n) & 0xffffffffn);
  const low = Number(duration & 0xffffffffn);
  return concat(
    new Uint8Array([1, 0, 0, 0]), // version 1 + 3 bytes of flags
    new Uint8Array(8), // creation_time u64
    new Uint8Array(8), // modification_time u64
    uint32BE(timescale),
    uint32BE(high),
    uint32BE(low),
    new Uint8Array(80),
  );
}

function makeMp4WithMoovFirst(mvhd: Uint8Array, mdatSize: number): Uint8Array {
  const ftyp = makeAtom("ftyp", new Uint8Array([0x69, 0x73, 0x6f, 0x6d]));
  const moov = makeAtom("moov", mvhd);
  const mdat = makeAtom("mdat", new Uint8Array(mdatSize));
  return concat(ftyp, moov, mdat);
}

function makeMp4WithMoovLast(mvhd: Uint8Array, mdatSize: number): Uint8Array {
  const ftyp = makeAtom("ftyp", new Uint8Array([0x69, 0x73, 0x6f, 0x6d]));
  const mdat = makeAtom("mdat", new Uint8Array(mdatSize));
  const moov = makeAtom("moov", mvhd);
  return concat(ftyp, mdat, moov);
}

// ── parseMvhdDuration ─────────────────────────────────────────────────────────

describe("parseMvhdDuration", () => {
  it("parses version-0 mvhd correctly", () => {
    const mvhdPayload = makeMvhdV0(1000, 12_500); // 12.5 seconds
    expect(parseMvhdDuration(mvhdPayload)).toBeCloseTo(12.5, 6);
  });

  it("parses version-0 mvhd with typical ElevenLabs-ish timescale", () => {
    const mvhdPayload = makeMvhdV0(44_100, 661_500); // 15 seconds at 44.1 kHz timescale
    expect(parseMvhdDuration(mvhdPayload)).toBeCloseTo(15.0, 6);
  });

  it("parses version-1 mvhd correctly", () => {
    const mvhdPayload = makeMvhdV1(1000, 12_500n);
    expect(parseMvhdDuration(mvhdPayload)).toBeCloseTo(12.5, 6);
  });

  it("returns null for timescale=0", () => {
    const mvhdPayload = makeMvhdV0(0, 1000);
    expect(parseMvhdDuration(mvhdPayload)).toBeNull();
  });

  it("returns null for unknown version", () => {
    const mvhdPayload = concat(new Uint8Array([5, 0, 0, 0]), new Uint8Array(32));
    expect(parseMvhdDuration(mvhdPayload)).toBeNull();
  });

  it("returns null for truncated payload (v0)", () => {
    expect(parseMvhdDuration(new Uint8Array([0, 0, 0, 0, 1, 2]))).toBeNull();
  });

  it("returns null for empty payload", () => {
    expect(parseMvhdDuration(new Uint8Array(0))).toBeNull();
  });
});

// ── findAtomLocal ────────────────────────────────────────────────────────────

describe("findAtomLocal", () => {
  it("finds an atom at the start of the slice", () => {
    const a = makeAtom("moov", new Uint8Array([1, 2, 3, 4]));
    const found = findAtomLocal(a, "moov");
    expect(found).not.toBeNull();
    expect(found!.payloadStart).toBe(8);
    expect(found!.payloadEnd).toBe(12);
  });

  it("finds an atom after siblings", () => {
    const ftyp = makeAtom("ftyp", new Uint8Array(16));
    const moov = makeAtom("moov", new Uint8Array([9, 9, 9]));
    const combined = concat(ftyp, moov);
    const found = findAtomLocal(combined, "moov");
    expect(found).not.toBeNull();
    expect(found!.payloadStart).toBe(ftyp.length + 8);
    expect(found!.payloadEnd).toBe(combined.length);
  });

  it("returns null when atom is not present", () => {
    const slice = makeAtom("ftyp", new Uint8Array(16));
    expect(findAtomLocal(slice, "moov")).toBeNull();
  });

  it("returns null when atom claims to extend past the slice", () => {
    // Manually craft an atom whose declared size exceeds the slice length.
    const slice = concat(uint32BE(99_999), ascii("moov"), new Uint8Array(10));
    expect(findAtomLocal(slice, "moov")).toBeNull();
  });

  it("returns null on a malformed slice with size < header", () => {
    const slice = concat(uint32BE(4), ascii("moov"));
    expect(findAtomLocal(slice, "moov")).toBeNull();
  });
});

// ── parseDurationFromSlice ───────────────────────────────────────────────────

describe("parseDurationFromSlice (moov+mvhd nested)", () => {
  it("parses duration from a slice with moov first", () => {
    const mvhd = makeAtom("mvhd", makeMvhdV0(1000, 8_750));
    const slice = makeMp4WithMoovFirst(mvhd, 256);
    expect(parseDurationFromSlice(slice, true)).toBeCloseTo(8.75, 6);
  });

  it("returns null when slice lacks moov", () => {
    const slice = makeAtom("ftyp", new Uint8Array(16));
    expect(parseDurationFromSlice(slice, true)).toBeNull();
  });

  it("returns null when moov is present but mvhd is missing", () => {
    const slice = concat(
      makeAtom("ftyp", new Uint8Array(8)),
      makeAtom("moov", makeAtom("trak", new Uint8Array(20))),
    );
    expect(parseDurationFromSlice(slice, true)).toBeNull();
  });
});

// ── probeMp4Duration end-to-end ──────────────────────────────────────────────

function makeFetchMock(file: Uint8Array, supportsRange = true): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    void input;
    const rangeHeader = init?.headers
      ? new Headers(init.headers).get("Range")
      : null;
    if (!supportsRange || !rangeHeader) {
      return new Response(file as unknown as BodyInit, {
        status: 200,
        headers: { "Content-Length": String(file.length) },
      });
    }
    // Supports `bytes=N-M` and `bytes=-N` (suffix).
    const absMatch = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
    const suffixMatch = /^bytes=-(\d+)$/.exec(rangeHeader);
    let start = 0;
    let end = file.length - 1;
    if (absMatch) {
      start = Number(absMatch[1]);
      end = Math.min(Number(absMatch[2]), file.length - 1);
    } else if (suffixMatch) {
      const n = Number(suffixMatch[1]);
      start = Math.max(0, file.length - n);
      end = file.length - 1;
    }
    const slice = file.slice(start, end + 1);
    return new Response(slice as unknown as BodyInit, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${file.length}`,
        "Content-Length": String(slice.length),
      },
    });
  }) as unknown as typeof fetch;
}

describe("probeMp4Duration", () => {
  it("probes duration when moov is at start of file", async () => {
    const mvhd = makeAtom("mvhd", makeMvhdV0(1000, 14_300));
    const file = makeMp4WithMoovFirst(mvhd, 8_000);
    const fetchImpl = makeFetchMock(file, true);
    const seconds = await probeMp4Duration("https://example/x.mp4", { fetchImpl });
    expect(seconds).toBeCloseTo(14.3, 6);
  });

  it("falls back to suffix range when moov is at end of file", async () => {
    const mvhd = makeAtom("mvhd", makeMvhdV0(1000, 9_900));
    // Make mdat large enough that moov won't fit in the first 64KB slice.
    const file = makeMp4WithMoovLast(mvhd, 200_000);
    const fetchImpl = makeFetchMock(file, true);
    const seconds = await probeMp4Duration("https://example/x.mp4", { fetchImpl });
    expect(seconds).toBeCloseTo(9.9, 6);
  });

  it("returns null when the server delivers garbage", async () => {
    const garbage = new Uint8Array(200);
    for (let i = 0; i < garbage.length; i++) garbage[i] = 0xab;
    const fetchImpl = makeFetchMock(garbage, true);
    const seconds = await probeMp4Duration("https://example/x.mp4", { fetchImpl });
    expect(seconds).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const seconds = await probeMp4Duration("https://example/x.mp4", { fetchImpl });
    expect(seconds).toBeNull();
  });

  it("still works when the server ignores Range and returns the whole file", async () => {
    const mvhd = makeAtom("mvhd", makeMvhdV0(1000, 11_111));
    const file = makeMp4WithMoovFirst(mvhd, 1_000);
    const fetchImpl = makeFetchMock(file, false);
    const seconds = await probeMp4Duration("https://example/x.mp4", { fetchImpl });
    expect(seconds).toBeCloseTo(11.111, 6);
  });
});

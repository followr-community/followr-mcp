// MP4 duration probe: pure-JS, no native deps, Cloudflare Workers compatible.
//
// Reads the `moov` -> `mvhd` atom to extract movie duration. Used by the
// avatar video pipeline to learn the EXACT length of each lipsync clip
// rendered by veed_fabric_1.0 (the audio length is whatever ElevenLabs
// produced, which the previous heuristic estimateSceneDuration() understated
// for any script with multiple sentences or longer voices). Feeding the real
// duration to Creatomate's render_script eliminates the truncation that made
// every scene end "cortada".
//
// Atom format (ISO BMFF, simplified):
//   - 4 bytes: size (big-endian uint32). If size == 1, real size is in the
//     next 8 bytes (uint64 BE). If size == 0, the atom extends to the end of
//     the enclosing container (or file for top-level).
//   - 4 bytes: type (4 ASCII chars, e.g. "moov", "mvhd").
//   - payload (size - 8, or size - 16 for the extended header).
//
// Strategy:
//   1. Range-fetch the first 64 KB. moov is usually at file start; if so,
//      mvhd (always moov's first child) is well within the slice.
//   2. If moov isn't in the slice (some encoders place moov at file end so
//      the mdat can stream), range-fetch the last 64 KB and retry.
//   3. Walk top-level atoms; find moov; walk moov's children; find mvhd; read
//      version + timescale + duration; return duration / timescale.
//   4. On any failure (network error, atom not found, malformed file, etc.),
//      return null. Callers fall back to their estimate.

const PROBE_SLICE_BYTES = 65_536;

/** Probe an MP4 URL's duration in seconds. Returns null on any failure. */
export async function probeMp4Duration(
  url: string,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<number | null> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 10_000;

  const head = await rangeFetch(fetchImpl, url, 0, PROBE_SLICE_BYTES - 1, timeoutMs);
  if (head) {
    const fromHead = parseDurationFromSlice(head.bytes, true);
    if (fromHead !== null) return fromHead;
  }

  // moov at end of file: fetch the last slice. We use a negative-range
  // request (suffix bytes); if the server doesn't honor it, we fall back
  // to deriving the range from the Content-Range we saw on the head fetch
  // (head.totalSize), or give up. The suffix slice usually starts
  // mid-mdat so we cannot sequential-walk; parseDurationFromSlice falls
  // back to scanForAtomLocal in that case.
  const tail = await suffixFetch(fetchImpl, url, PROBE_SLICE_BYTES, head?.totalSize ?? null, timeoutMs);
  if (tail) {
    return parseDurationFromSlice(tail.bytes, false);
  }

  return null;
}

interface FetchedSlice {
  bytes: Uint8Array;
  totalSize: number | null;
  sliceStart?: number;
}

async function rangeFetch(
  fetchImpl: typeof fetch,
  url: string,
  start: number,
  end: number,
  timeoutMs: number,
): Promise<FetchedSlice | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal: controller.signal,
      });
      // 206 Partial Content is the happy path; 200 means the server ignored
      // Range and returned the whole file (still parseable if it fits).
      if (resp.status !== 206 && resp.status !== 200) return null;
      const buffer = await resp.arrayBuffer();
      if (buffer.byteLength === 0) return null;
      const totalSize = parseTotalSizeFromContentRange(resp.headers.get("content-range"))
        ?? parseIntOrNull(resp.headers.get("content-length"));
      return { bytes: new Uint8Array(buffer), totalSize };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

async function suffixFetch(
  fetchImpl: typeof fetch,
  url: string,
  sliceBytes: number,
  knownTotal: number | null,
  timeoutMs: number,
): Promise<FetchedSlice | null> {
  // Prefer absolute Range when we know the file size (more compatible).
  if (knownTotal !== null && knownTotal > 0) {
    const start = Math.max(0, knownTotal - sliceBytes);
    const end = knownTotal - 1;
    const slice = await rangeFetch(fetchImpl, url, start, end, timeoutMs);
    if (slice) return { ...slice, sliceStart: start };
  }
  // Fallback to suffix range. RFC 7233 syntax: bytes=-N.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(url, {
        headers: { Range: `bytes=-${sliceBytes}` },
        signal: controller.signal,
      });
      if (resp.status !== 206 && resp.status !== 200) return null;
      const buffer = await resp.arrayBuffer();
      if (buffer.byteLength === 0) return null;
      const totalSize = parseTotalSizeFromContentRange(resp.headers.get("content-range"));
      const sliceStart = totalSize !== null
        ? Math.max(0, totalSize - buffer.byteLength)
        : undefined;
      return { bytes: new Uint8Array(buffer), totalSize, ...(sliceStart !== undefined ? { sliceStart } : {}) };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

function parseTotalSizeFromContentRange(header: string | null): number | null {
  if (!header) return null;
  // Format: "bytes <start>-<end>/<total>"
  const match = /\/(\d+)$/.exec(header);
  if (!match) return null;
  return parseIntOrNull(match[1]!);
}

function parseIntOrNull(s: string | null): number | null {
  if (s === null) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

// ── Atom walking ─────────────────────────────────────────────────────────────

// Find an atom by its 4-char type within a byte slice by sequential walk
// from offset 0. Returns the payload bounds (within the slice) or null if
// not found, malformed, or truncated (atom's declared size exceeds the
// slice). Sequential walk requires the slice to start at a valid atom
// boundary; for slices that DO NOT (e.g. suffix-range slices that begin
// mid-mdat), use scanForAtomLocal instead.
function findAtomLocal(slice: Uint8Array, type: string): { payloadStart: number; payloadEnd: number } | null {
  if (type.length !== 4) return null;
  const typeBytes = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
  let cursor = 0;
  while (cursor + 8 <= slice.length) {
    const size = readUint32BE(slice, cursor);
    const t0 = slice[cursor + 4];
    const t1 = slice[cursor + 5];
    const t2 = slice[cursor + 6];
    const t3 = slice[cursor + 7];
    if (size === 0) {
      // Extends to end of slice; we won't find any siblings after this anyway.
      if (t0 === typeBytes[0] && t1 === typeBytes[1] && t2 === typeBytes[2] && t3 === typeBytes[3]) {
        return { payloadStart: cursor + 8, payloadEnd: slice.length };
      }
      return null;
    }
    let headerSize = 8;
    let realSize: number;
    if (size === 1) {
      // 64-bit extended size; the file COULD have an atom larger than 4 GB,
      // but that's not relevant for our slices. We bail if the high 32 bits
      // are non-zero (atom doesn't fit in the slice anyway).
      if (cursor + 16 > slice.length) return null;
      const high = readUint32BE(slice, cursor + 8);
      const low = readUint32BE(slice, cursor + 12);
      if (high !== 0) return null;
      realSize = low;
      headerSize = 16;
    } else {
      realSize = size;
    }
    if (realSize < headerSize) return null;
    // Atom claims to extend past the slice: malformed for our purposes
    // (we cannot read its full payload). Stop walking either way.
    if (cursor + realSize > slice.length) return null;
    if (t0 === typeBytes[0] && t1 === typeBytes[1] && t2 === typeBytes[2] && t3 === typeBytes[3]) {
      return {
        payloadStart: cursor + headerSize,
        payloadEnd: cursor + realSize,
      };
    }
    // Skip to next sibling.
    const nextCursor = cursor + realSize;
    if (nextCursor <= cursor) return null;
    cursor = nextCursor;
  }
  return null;
}

// Scan a byte slice for an atom by 4-char type, without assuming the slice
// starts at an atom boundary. Used for suffix-range slices that begin
// mid-mdat: we look for the type bytes at any offset, then validate the
// preceding 4 bytes as a plausible size field. Returns the first valid
// match. Validation: size header must be >= 8 (8-byte header minimum)
// AND the atom must fit entirely within the slice from its computed start.
function scanForAtomLocal(slice: Uint8Array, type: string): { payloadStart: number; payloadEnd: number } | null {
  if (type.length !== 4) return null;
  const t0 = type.charCodeAt(0);
  const t1 = type.charCodeAt(1);
  const t2 = type.charCodeAt(2);
  const t3 = type.charCodeAt(3);
  // Atom header is at the 4 bytes BEFORE the type bytes. So the earliest
  // valid offset for `type` is index 4.
  for (let i = 4; i + 4 <= slice.length; i++) {
    if (
      slice[i] === t0 &&
      slice[i + 1] === t1 &&
      slice[i + 2] === t2 &&
      slice[i + 3] === t3
    ) {
      const atomStart = i - 4;
      const declaredSize = readUint32BE(slice, atomStart);
      let headerSize = 8;
      let realSize: number;
      if (declaredSize === 1) {
        if (atomStart + 16 > slice.length) continue;
        const high = readUint32BE(slice, atomStart + 8);
        const low = readUint32BE(slice, atomStart + 12);
        if (high !== 0) continue;
        realSize = low;
        headerSize = 16;
      } else if (declaredSize >= 8 && declaredSize < 100_000_000) {
        realSize = declaredSize;
      } else {
        // Implausible size (zero / negative / too large). Likely the
        // bytes coincidentally matched the type chars; keep scanning.
        continue;
      }
      if (atomStart + realSize > slice.length) continue;
      return {
        payloadStart: atomStart + headerSize,
        payloadEnd: atomStart + realSize,
      };
    }
  }
  return null;
}

// Parse mvhd's payload (immediately after the atom header) for duration.
function parseMvhdDuration(payload: Uint8Array): number | null {
  if (payload.length < 4) return null;
  const version = payload[0]!;
  // Flags (3 bytes) at payload[1..3], ignored.
  if (version === 0) {
    // [4] creation_time u32, [8] modification_time u32, [12] timescale u32,
    // [16] duration u32. Total 20 bytes for the relevant block.
    if (payload.length < 20) return null;
    const timescale = readUint32BE(payload, 12);
    const duration = readUint32BE(payload, 16);
    if (timescale === 0) return null;
    return duration / timescale;
  }
  if (version === 1) {
    // [4] creation_time u64, [12] modification_time u64, [20] timescale u32,
    // [24] duration u64. Total 32 bytes for the relevant block.
    if (payload.length < 32) return null;
    const timescale = readUint32BE(payload, 20);
    const durationHigh = readUint32BE(payload, 24);
    const durationLow = readUint32BE(payload, 28);
    if (timescale === 0) return null;
    // Combine as BigInt then convert. For realistic video durations
    // (timescale 1000-100000, length minutes-hours) this fits in Number's
    // safe range with plenty of margin.
    const duration = BigInt(durationHigh) * 0x100000000n + BigInt(durationLow);
    return Number(duration) / timescale;
  }
  return null;
}

function parseDurationFromSlice(
  slice: Uint8Array,
  sliceStartsAtFileOffset0: boolean,
): number | null {
  // Sequential walk works only when the slice starts at file offset 0
  // (atom boundary). For suffix slices that start mid-mdat the scan path
  // is needed. We try both regardless of the hint, so head slices that
  // somehow miss in sequential walk still get a second chance via scan.
  const moov = sliceStartsAtFileOffset0
    ? findAtomLocal(slice, "moov") ?? scanForAtomLocal(slice, "moov")
    : scanForAtomLocal(slice, "moov");
  if (!moov) return null;
  const moovChildren = slice.subarray(moov.payloadStart, moov.payloadEnd);
  // mvhd is the first child of moov and is always present at a clean
  // boundary inside moov, so sequential walk works here.
  const mvhd = findAtomLocal(moovChildren, "mvhd") ?? scanForAtomLocal(moovChildren, "mvhd");
  if (!mvhd) return null;
  const mvhdPayload = moovChildren.subarray(mvhd.payloadStart, mvhd.payloadEnd);
  const seconds = parseMvhdDuration(mvhdPayload);
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds;
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset]! * 0x1000000) +
    (buf[offset + 1]! << 16) +
    (buf[offset + 2]! << 8) +
    buf[offset + 3]!
  );
}

// ── Test exports ─────────────────────────────────────────────────────────────
// Kept out of the public API surface; only used by unit tests.
export const __test = {
  parseDurationFromSlice,
  parseMvhdDuration,
  findAtomLocal,
  scanForAtomLocal,
  readUint32BE,
};

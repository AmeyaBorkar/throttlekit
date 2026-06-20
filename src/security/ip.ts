/**
 * Proxy-correct, IPv6-aware client IP derivation — a security control, not a convenience.
 *
 * Trusting `X-Forwarded-For` blindly is the classic rate-limit bypass: an attacker prepends a
 * forged hop and rotates the "client" IP at will. This module refuses to do that. The default is
 * `trustProxy: false` (ignore XFF entirely, use the socket peer). Trust is opt-in and explicit,
 * either as a hop count (Express "trust proxy" numeric semantics) or a CIDR/IP allowlist of the
 * proxies you actually run.
 *
 * It also aggregates IPv6 to a configurable prefix (`/64` by default), because a single IPv6
 * customer controls billions of addresses; limiting per full address is trivially bypassed.
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4`) collapses to the embedded IPv4. All parsing/masking is
 * implemented here with no external dependency. See THROTTLEKIT.md §14.
 */

/** How much of `X-Forwarded-For` to trust, and how aggressively to aggregate IPv6. */
export interface TrustProxyConfig {
  /**
   * Trust policy for `X-Forwarded-For`:
   *  - `false` (default) — ignore XFF; use `remoteAddr` (the socket peer).
   *  - `number N`        — trust `N` hops; the client is the address `N` positions left of the
   *                        socket peer in `[...xff, remoteAddr]` (clamped at the leftmost).
   *  - `string[]`        — an allowlist of trusted proxy IPs/CIDRs; walking the chain from the
   *                        right, the first address NOT in the allowlist is the client.
   */
  trustProxy?: false | number | string[];
  /** IPv6 aggregation prefix length in bits. Default 64. Range 0..128. */
  ipv6Prefix?: number;
}

/** Input for {@link clientIp}: the socket peer plus the raw forwarded-for header. */
export interface ClientIpInput {
  /** The socket peer address (e.g. `req.socket.remoteAddress`). */
  remoteAddr: string;
  /** The `X-Forwarded-For` header value: a comma-separated string, an array, or absent. */
  xForwardedFor?: string | string[] | undefined;
}

// --- IPv4 -------------------------------------------------------------------------------------

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Parse a dotted-quad into four octets, or `undefined` if it isn't a valid IPv4 literal. */
function parseIpv4(s: string): [number, number, number, number] | undefined {
  const m = IPV4_RE.exec(s);
  if (m === null) return undefined;
  const groups = [m[1], m[2], m[3], m[4]] as const;
  const octets: number[] = [];
  for (const g of groups) {
    if (g === undefined) return undefined;
    // Reject leading zeros like "01" (ambiguous / octal-looking) for a strict, canonical parse.
    if (g.length > 1 && g[0] === "0") return undefined;
    const n = Number(g);
    if (n > 255) return undefined;
    octets.push(n);
  }
  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0];
}

// --- IPv6 -------------------------------------------------------------------------------------

/**
 * Parse an IPv6 literal into its eight 16-bit groups. Handles `::` compression, an embedded
 * IPv4 tail (`::ffff:1.2.3.4`), zone ids (`%eth0`, stripped), and bracketed forms (`[...]`).
 * Returns `undefined` on anything malformed.
 */
function parseIpv6(input: string): number[] | undefined {
  let s = input;
  // Strip a zone id ("fe80::1%eth0") — it is not part of the address identity.
  const pct = s.indexOf("%");
  if (pct !== -1) s = s.slice(0, pct);
  if (s.length === 0) return undefined;

  // An embedded IPv4 tail contributes the low 32 bits as two groups.
  let ipv4Tail: number[] | undefined;
  const lastColon = s.lastIndexOf(":");
  if (lastColon !== -1 && s.includes(".", lastColon)) {
    const v4 = parseIpv4(s.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    ipv4Tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = s.slice(0, lastColon + 1); // keep the trailing colon so the split logic is uniform
  }

  // Split into the part before "::" and the part after (at most one "::" is allowed).
  const dblIdx = s.indexOf("::");
  let headStr: string;
  let tailStr: string;
  let compressed: boolean;
  if (dblIdx === -1) {
    compressed = false;
    headStr = s;
    tailStr = "";
  } else {
    if (s.indexOf("::", dblIdx + 1) !== -1) return undefined; // more than one "::"
    compressed = true;
    headStr = s.slice(0, dblIdx);
    tailStr = s.slice(dblIdx + 2);
  }

  const parseGroups = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (g === "") return undefined; // stray empty group (e.g. ":::" or trailing ":")
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };

  // When we peeled an IPv4 tail, the trailing colon left an empty final segment to drop.
  const head = parseGroups(headStr.endsWith(":") ? headStr.slice(0, -1) : headStr);
  let tail = parseGroups(tailStr.endsWith(":") ? tailStr.slice(0, -1) : tailStr);
  if (head === undefined || tail === undefined) return undefined;
  if (ipv4Tail !== undefined) tail = [...tail, ...ipv4Tail];

  if (compressed) {
    const fill = 8 - (head.length + tail.length);
    if (fill < 0) return undefined; // "::" must stand for at least one zero group
    return [...head, ...new Array<number>(fill).fill(0), ...tail];
  }
  if (head.length + tail.length !== 8) return undefined;
  return [...head, ...tail];
}

/** Render eight 16-bit groups as a canonical (lowercase, `::`-compressed) IPv6 string. */
function formatIpv6(groups: number[]): string {
  // Find the longest run of consecutive zero groups (length >= 2) to compress with "::".
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen < 2) {
    return groups.map((g) => g.toString(16)).join(":");
  }
  const head = groups
    .slice(0, bestStart)
    .map((g) => g.toString(16))
    .join(":");
  const tail = groups
    .slice(bestStart + bestLen)
    .map((g) => g.toString(16))
    .join(":");
  return `${head}::${tail}`;
}

/** True when the eight groups encode an IPv4-mapped address (`::ffff:a.b.c.d`). */
function ipv4MappedTail(groups: number[]): [number, number, number, number] | undefined {
  for (let i = 0; i < 5; i++) {
    if (groups[i] !== 0) return undefined;
  }
  if (groups[5] !== 0xffff) return undefined;
  const g6 = groups[6] ?? 0;
  const g7 = groups[7] ?? 0;
  return [(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff];
}

/** Mask IPv6 groups to the first `prefix` bits, zeroing the host portion. */
function maskIpv6(groups: number[], prefix: number): number[] {
  const out = new Array<number>(8).fill(0);
  let bits = prefix;
  for (let i = 0; i < 8; i++) {
    if (bits >= 16) {
      out[i] = groups[i] ?? 0;
      bits -= 16;
    } else if (bits <= 0) {
      out[i] = 0;
    } else {
      const mask = (0xffff << (16 - bits)) & 0xffff;
      out[i] = (groups[i] ?? 0) & mask;
      bits = 0;
    }
  }
  return out;
}

// --- CIDR matching ----------------------------------------------------------------------------

/** Strip brackets and zone id from a raw address token. */
function stripHost(addr: string): string {
  let s = addr.trim();
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end !== -1) s = s.slice(1, end);
  }
  const pct = s.indexOf("%");
  if (pct !== -1) s = s.slice(0, pct);
  return s;
}

/** Does IPv4 `octets` fall inside `net`/`prefix`? */
function ipv4InCidr(octets: number[], net: number[], prefix: number): boolean {
  const ipInt =
    ((octets[0] ?? 0) << 24) |
    ((octets[1] ?? 0) << 16) |
    ((octets[2] ?? 0) << 8) |
    (octets[3] ?? 0);
  const netInt =
    ((net[0] ?? 0) << 24) | ((net[1] ?? 0) << 16) | ((net[2] ?? 0) << 8) | (net[3] ?? 0);
  if (prefix === 0) return true;
  const mask = prefix >= 32 ? -1 : ~(-1 >>> prefix); // signed 32-bit mask
  return (ipInt & mask) === (netInt & mask);
}

/** Does IPv6 `groups` fall inside `net`/`prefix`? */
function ipv6InCidr(groups: number[], net: number[], prefix: number): boolean {
  const a = maskIpv6(groups, prefix);
  const b = maskIpv6(net, prefix);
  for (let i = 0; i < 8; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Test whether `addr` matches a trusted entry. An entry may be a bare IP or `ip/prefix` CIDR, in
 * either family. IPv4-mapped IPv6 on either side is normalized to IPv4 first so the families line
 * up. Unparseable entries never match (fail-closed for trust).
 */
function addrMatchesEntry(addr: string, entry: string): boolean {
  const slash = entry.indexOf("/");
  const entryAddr = stripHost(slash === -1 ? entry : entry.slice(0, slash));
  const entryPrefixStr = slash === -1 ? undefined : entry.slice(slash + 1);

  // Normalize both sides: IPv4-mapped IPv6 -> IPv4 dotted quad.
  const normalize = (raw: string): { v4?: number[]; v6?: number[] } => {
    const v4 = parseIpv4(raw);
    if (v4 !== undefined) return { v4 };
    const v6 = parseIpv6(raw);
    if (v6 === undefined) return {};
    const mapped = ipv4MappedTail(v6);
    if (mapped !== undefined) return { v4: mapped };
    return { v6 };
  };

  const target = normalize(addr);
  const trusted = normalize(entryAddr);

  if (target.v4 !== undefined && trusted.v4 !== undefined) {
    let prefix = 32;
    if (entryPrefixStr !== undefined) {
      let p = Number(entryPrefixStr);
      if (!Number.isInteger(p) || p < 0) return false;
      // A mapped-v6 entry like `::ffff:10.0.0.0/104` writes its prefix in 128-bit v6 space, but
      // normalize() has collapsed the address to its v4 quad. Recover the v4 prefix by dropping the
      // 96-bit `::ffff:` mapping prefix, so `/104` means the v4 `/8` the operator intended.
      if (entryAddr.includes(":")) p -= 96;
      if (p < 0 || p > 32) return false;
      prefix = p;
    }
    return ipv4InCidr(target.v4, trusted.v4, prefix);
  }
  if (target.v6 !== undefined && trusted.v6 !== undefined) {
    let prefix = 128;
    if (entryPrefixStr !== undefined) {
      const p = Number(entryPrefixStr);
      if (!Number.isInteger(p) || p < 0 || p > 128) return false;
      prefix = p;
    }
    return ipv6InCidr(target.v6, trusted.v6, prefix);
  }
  return false; // family mismatch
}

// --- XFF parsing & client resolution ----------------------------------------------------------

/** Normalize/validate a raw XFF token into a canonical address, or drop it (`undefined`). */
function canonicalizeAddr(raw: string): string | undefined {
  const s = stripHost(raw);
  if (s.length === 0) return undefined;
  if (parseIpv4(s) !== undefined) return s;
  const v6 = parseIpv6(s);
  if (v6 !== undefined) {
    const mapped = ipv4MappedTail(v6);
    if (mapped !== undefined) return mapped.join(".");
    return formatIpv6(v6);
  }
  return undefined;
}

/** Parse `X-Forwarded-For` (string or string[]) into trimmed, valid, canonical addresses. */
function parseXff(xff: string | string[] | undefined): string[] {
  if (xff === undefined) return [];
  const parts = Array.isArray(xff) ? xff.flatMap((p) => p.split(",")) : xff.split(",");
  const out: string[] = [];
  for (const part of parts) {
    const canon = canonicalizeAddr(part);
    if (canon !== undefined) out.push(canon);
  }
  return out;
}

/**
 * Aggregate a single canonical address to its rate-limit key: IPv4 as-is, IPv6 masked to
 * `ipv6Prefix` bits (so a customer rotating within their prefix maps to ONE key), IPv4-mapped
 * IPv6 collapsed to the embedded IPv4.
 */
function aggregate(addr: string, ipv6Prefix: number): string {
  if (parseIpv4(addr) !== undefined) return addr; // IPv4 == /32
  const v6 = parseIpv6(addr);
  if (v6 === undefined) return addr; // already-canonical or opaque; return unchanged
  const mapped = ipv4MappedTail(v6);
  if (mapped !== undefined) return mapped.join(".");
  return formatIpv6(maskIpv6(v6, ipv6Prefix));
}

/**
 * Derive the proxy-correct, aggregated client IP key from a request's socket peer and
 * `X-Forwarded-For` header, honoring an explicit trusted-proxy policy.
 *
 * @see TrustProxyConfig for the trust semantics.
 */
export function clientIp(input: ClientIpInput, config: TrustProxyConfig = {}): string {
  const trustProxy = config.trustProxy ?? false;
  let ipv6Prefix = config.ipv6Prefix ?? 64;
  if (!Number.isInteger(ipv6Prefix) || ipv6Prefix < 0 || ipv6Prefix > 128) {
    ipv6Prefix = 64;
  }

  const remote = canonicalizeAddr(input.remoteAddr) ?? input.remoteAddr.trim();

  // Default and explicit-distrust: the socket peer is the only address we believe.
  if (trustProxy === false) {
    return aggregate(remote, ipv6Prefix);
  }

  const xff = parseXff(input.xForwardedFor);
  // Chain ordered client..proxies left-to-right, with the socket peer (nearest the server) last.
  const chain = [...xff, remote];

  let client: string;
  if (typeof trustProxy === "number") {
    // Trust N hops: step N positions left from the rightmost, clamped to the leftmost entry.
    const idx = Math.max(0, chain.length - 1 - Math.max(0, Math.floor(trustProxy)));
    client = chain[idx] ?? remote;
  } else {
    // Allowlist: walk from the right, skip trusted proxies; first untrusted is the client.
    const isTrusted = (addr: string): boolean =>
      trustProxy.some((entry) => addrMatchesEntry(addr, entry));
    let chosen = chain[0] ?? remote; // leftmost, used if the entire chain is trusted
    for (let i = chain.length - 1; i >= 0; i--) {
      const addr = chain[i];
      if (addr === undefined) continue;
      if (!isTrusted(addr)) {
        chosen = addr;
        break;
      }
    }
    client = chosen;
  }

  return aggregate(client, ipv6Prefix);
}

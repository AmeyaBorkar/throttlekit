import { describe, expect, it } from "vitest";
import { clientIp } from "../../src/security/ip";

describe("clientIp — trust policy (adversarial)", () => {
  it("DEFAULT (trustProxy:false) ignores a spoofed X-Forwarded-For entirely", () => {
    // Attacker forges XFF claiming to be 1.2.3.4; we must use the socket peer.
    const ip = clientIp({
      remoteAddr: "203.0.113.7",
      xForwardedFor: "1.2.3.4, 9.9.9.9",
    });
    expect(ip).toBe("203.0.113.7");
  });

  it("default ignores XFF even when passed as an array", () => {
    const ip = clientIp({
      remoteAddr: "203.0.113.7",
      xForwardedFor: ["1.2.3.4", "9.9.9.9"],
    });
    expect(ip).toBe("203.0.113.7");
  });

  it("numeric hops pick the correct client from [...xff, remoteAddr]", () => {
    const input = { remoteAddr: "10.0.0.1", xForwardedFor: "1.1.1.1, 2.2.2.2" };
    // chain = [1.1.1.1, 2.2.2.2, 10.0.0.1]
    expect(clientIp(input, { trustProxy: 0 })).toBe("10.0.0.1"); // trust nothing -> socket peer
    expect(clientIp(input, { trustProxy: 1 })).toBe("2.2.2.2"); // one hop in
    expect(clientIp(input, { trustProxy: 2 })).toBe("1.1.1.1"); // two hops in -> real client
  });

  it("numeric hops clamp to the leftmost when N exceeds the chain length", () => {
    const input = { remoteAddr: "10.0.0.1", xForwardedFor: "1.1.1.1, 2.2.2.2" };
    expect(clientIp(input, { trustProxy: 99 })).toBe("1.1.1.1");
  });

  it("CIDR allowlist returns the first untrusted address walking from the right", () => {
    // Two trusted internal proxies in 10.0.0.0/8; the client is 1.2.3.4.
    const ip = clientIp(
      { remoteAddr: "10.0.0.1", xForwardedFor: "1.2.3.4, 10.0.0.9" },
      { trustProxy: ["10.0.0.0/8"] },
    );
    expect(ip).toBe("1.2.3.4");
  });

  it("CIDR allowlist resists a spoofed PREPENDED XFF entry", () => {
    // Attacker prepends a fake "client" but the real path is client(8.8.8.8) -> trusted proxies.
    // Walking from the right we skip the two trusted 10.x proxies and stop at 8.8.8.8.
    const ip = clientIp(
      { remoteAddr: "10.0.0.1", xForwardedFor: "6.6.6.6, 8.8.8.8, 10.0.0.5" },
      { trustProxy: ["10.0.0.0/8"] },
    );
    // 8.8.8.8 is the nearest UNtrusted hop; the prepended 6.6.6.6 is never reached.
    expect(ip).toBe("8.8.8.8");
  });

  it("CIDR allowlist falls back to the leftmost when every hop is trusted", () => {
    const ip = clientIp(
      { remoteAddr: "10.0.0.1", xForwardedFor: "10.0.0.7, 10.0.0.8" },
      { trustProxy: ["10.0.0.0/8"] },
    );
    expect(ip).toBe("10.0.0.7");
  });

  it("CIDR allowlist supports IPv6 trusted proxies", () => {
    const ip = clientIp(
      { remoteAddr: "fd00::1", xForwardedFor: "2001:db8::1234, fd00::2" },
      { trustProxy: ["fd00::/8"], ipv6Prefix: 64 },
    );
    // fd00::1 and fd00::2 are trusted; client is the 2001:db8 address, aggregated to /64.
    expect(ip).toBe("2001:db8::");
  });

  it("CIDR allowlist honors an IPv4-mapped IPv6 CIDR's v6-space prefix (regression)", () => {
    // `::ffff:10.0.0.0/104` is the canonical mapped way to write the v4 /8 (96 + 8). normalize()
    // collapses the address to the v4 quad, so the /104 prefix (written in 128-bit v6 space) must be
    // shifted by -96 to mean the v4 /8 the operator intended. The bug range-checked 104 against 0..32
    // and rejected the entry, so the proxy was treated as untrusted and XFF was dropped.
    const trusted = clientIp(
      { remoteAddr: "10.0.0.5", xForwardedFor: "1.2.3.4" },
      { trustProxy: ["::ffff:10.0.0.0/104"] },
    );
    expect(trusted).toBe("1.2.3.4"); // proxy in the mapped /8 is trusted, so the XFF client wins

    // A peer OUTSIDE the mapped /8 stays untrusted (the chain stops at it).
    const outside = clientIp(
      { remoteAddr: "11.0.0.5", xForwardedFor: "1.2.3.4" },
      { trustProxy: ["::ffff:10.0.0.0/104"] },
    );
    expect(outside).toBe("11.0.0.5");

    // A smaller mapped prefix maps consistently: `/120` == v4 /24.
    const in24 = clientIp(
      { remoteAddr: "10.0.0.5", xForwardedFor: "1.2.3.4" },
      { trustProxy: ["::ffff:10.0.0.0/120"] },
    );
    expect(in24).toBe("1.2.3.4");
    const out24 = clientIp(
      { remoteAddr: "10.0.1.5", xForwardedFor: "1.2.3.4" }, // outside 10.0.0.0/24
      { trustProxy: ["::ffff:10.0.0.0/120"] },
    );
    expect(out24).toBe("10.0.1.5");
  });

  it("CIDR allowlist supports a single bare IP (no prefix)", () => {
    const ip = clientIp(
      { remoteAddr: "192.168.1.1", xForwardedFor: "77.0.0.1, 192.168.1.1" },
      { trustProxy: ["192.168.1.1"] },
    );
    expect(ip).toBe("77.0.0.1");
  });
});

describe("clientIp — malformed input is ignored safely", () => {
  it("drops empty and invalid XFF tokens", () => {
    const ip = clientIp(
      { remoteAddr: "10.0.0.1", xForwardedFor: " , not-an-ip, , 1.2.3.4 ,999.999.1.1" },
      { trustProxy: 1 },
    );
    // Valid tokens only: [1.2.3.4], chain=[1.2.3.4, 10.0.0.1], trust 1 hop -> 1.2.3.4
    expect(ip).toBe("1.2.3.4");
  });

  it("handles a chain that is entirely invalid by falling back to remoteAddr", () => {
    const ip = clientIp(
      { remoteAddr: "10.0.0.1", xForwardedFor: "garbage, 999.1.1.1" },
      { trustProxy: 5 },
    );
    expect(ip).toBe("10.0.0.1");
  });

  it("rejects IPv4 octets with leading zeros (strict parse) but keeps remoteAddr usable", () => {
    // "01.02.03.04" is not a canonical IPv4 and is dropped from the chain.
    const ip = clientIp({ remoteAddr: "8.8.8.8", xForwardedFor: "01.02.03.04" }, { trustProxy: 1 });
    expect(ip).toBe("8.8.8.8");
  });
});

describe("clientIp — IPv6 aggregation", () => {
  it("maps two different addresses in the SAME /64 to the SAME key", () => {
    const a = clientIp({ remoteAddr: "2001:db8:abcd:1234::1" });
    const b = clientIp({ remoteAddr: "2001:db8:abcd:1234:ffff:ffff:ffff:ffff" });
    expect(a).toBe(b);
    expect(a).toBe("2001:db8:abcd:1234::");
  });

  it("maps addresses in DIFFERENT /64s to DIFFERENT keys", () => {
    const a = clientIp({ remoteAddr: "2001:db8:abcd:1::1" });
    const b = clientIp({ remoteAddr: "2001:db8:abcd:2::1" });
    expect(a).not.toBe(b);
    expect(a).toBe("2001:db8:abcd:1::");
    expect(b).toBe("2001:db8:abcd:2::");
  });

  it("honors a custom ipv6Prefix (a /48 groups more addresses together)", () => {
    const a = clientIp({ remoteAddr: "2001:db8:abcd:1::1" }, { ipv6Prefix: 48 });
    const b = clientIp({ remoteAddr: "2001:db8:abcd:9999::1" }, { ipv6Prefix: 48 });
    expect(a).toBe(b);
    expect(a).toBe("2001:db8:abcd::");
  });

  it("a /128 prefix keeps full-address granularity", () => {
    const a = clientIp({ remoteAddr: "2001:db8::1" }, { ipv6Prefix: 128 });
    const b = clientIp({ remoteAddr: "2001:db8::2" }, { ipv6Prefix: 128 });
    expect(a).not.toBe(b);
  });

  it("treats IPv4-mapped IPv6 (::ffff:a.b.c.d) as the embedded IPv4", () => {
    expect(clientIp({ remoteAddr: "::ffff:1.2.3.4" })).toBe("1.2.3.4");
    // mixed-case / compressed forms collapse to the same IPv4
    expect(clientIp({ remoteAddr: "::FFFF:203.0.113.9" })).toBe("203.0.113.9");
  });

  it("strips zone ids and brackets before parsing/aggregating", () => {
    expect(clientIp({ remoteAddr: "[2001:db8:abcd:1234::1]" })).toBe("2001:db8:abcd:1234::");
    expect(clientIp({ remoteAddr: "fe80::1%eth0" }, { ipv6Prefix: 64 })).toBe("fe80::");
  });

  it("expands '::' compression correctly for masking", () => {
    // "::1" is the loopback; /64 of it is all-zero high bits -> "::"
    expect(clientIp({ remoteAddr: "::1" })).toBe("::");
    // a fully-specified address round-trips through parse+mask
    expect(clientIp({ remoteAddr: "2001:0db8:0000:0000:0000:0000:0000:0001" })).toBe("2001:db8::");
  });

  it("IPv4 addresses pass through unchanged (treated as /32)", () => {
    expect(clientIp({ remoteAddr: "203.0.113.42" })).toBe("203.0.113.42");
  });

  it("a spoofed IPv6 client rotating within its /64 cannot evade the limit (one key)", () => {
    const trust = { trustProxy: 1 as const, ipv6Prefix: 64 };
    const k1 = clientIp({ remoteAddr: "10.0.0.1", xForwardedFor: "2001:db8:1:1::dead" }, trust);
    const k2 = clientIp({ remoteAddr: "10.0.0.1", xForwardedFor: "2001:db8:1:1::beef" }, trust);
    expect(k1).toBe(k2);
    expect(k1).toBe("2001:db8:1:1::");
  });
});

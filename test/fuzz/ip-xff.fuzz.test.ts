import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type TrustProxyConfig, clientIp } from "../../src/security/ip";

/**
 * FUZZ — the trusted-client-IP boundary (`src/security/ip.ts` `clientIp`). Untrusted surface: the
 * `X-Forwarded-For` header (fully attacker-controlled) plus the socket peer, resolved under an
 * operator trust policy. Trusting XFF blindly is the classic rate-limit bypass, so this is a
 * security control.
 *
 * SAFETY CONTRACT: for any adversarial header chain and any trust config, `clientIp` returns a
 * bounded, deterministic string result; it never throws and does no unbounded work. Two invariants
 * that matter most: (1) `trustProxy:false` ignores XFF ENTIRELY (the header can never change the
 * answer); (2) a numeric hop count is respected exactly (the chosen client is the address `N`
 * positions left of the socket peer, clamped to the leftmost).
 */

const NUM_RUNS = 1200;

const controlString = fc
  .array(fc.integer({ min: 0, max: 0x1f }), { maxLength: 16 })
  .map((codes) => String.fromCharCode(...codes));

/** A pile of address-ish tokens: valid v4/v6, mapped, zone-id, bracketed, and outright garbage. */
const ipToken = fc.oneof(
  fc.constantFrom(
    "1.2.3.4",
    "10.0.0.1",
    "255.255.255.255",
    "0.0.0.0",
    "::1",
    "::ffff:1.2.3.4",
    "fe80::1%eth0",
    "[2001:db8::1]",
    "2001:db8::1",
    "999.1.1.1",
    "01.02.03.04",
    "1.2.3",
    "abcd::x",
    "::ffff::1",
    "   ",
    "",
  ),
  fc
    .tuple(fc.nat(300), fc.nat(300), fc.nat(300), fc.nat(300))
    .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`),
  fc.string({ maxLength: 24 }),
  controlString,
);

const xForwardedFor = fc.oneof(
  fc.constant(undefined),
  fc.array(ipToken, { maxLength: 40 }).map((a) => a.join(", ")),
  fc.array(ipToken, { maxLength: 40 }), // header delivered as an array of values
  fc.string({ maxLength: 120 }),
);

const trustProxy = fc.oneof(
  fc.constant<false>(false),
  fc.integer({ min: -5, max: 300 }),
  fc.double(), // NaN / ±Infinity / fractional hop counts
  fc.array(
    fc.oneof(
      fc.constantFrom(
        "10.0.0.0/8",
        "192.168.0.0/16",
        "::ffff:0:0/96",
        "::/0",
        "10.0.0.1",
        "garbage",
        "1.2.3.4/999",
        "1.2.3.4/-1",
      ),
      ipToken,
    ),
    { maxLength: 10 },
  ),
);

const ipv6Prefix = fc.oneof(
  fc.constant(undefined),
  fc.integer({ min: -10, max: 200 }),
  fc.double(),
);

/** Assemble a `TrustProxyConfig`, honoring exactOptionalPropertyTypes (omit rather than pass `undefined`). */
function makeConfig(tp: false | number | string[], p6: number | undefined): TrustProxyConfig {
  return {
    trustProxy: tp,
    ...(p6 !== undefined ? { ipv6Prefix: p6 } : {}),
  };
}

describe("fuzz: X-Forwarded-For / client-IP boundary", () => {
  it("never throws; result is a deterministic string for any adversarial input", () => {
    fc.assert(
      fc.property(ipToken, xForwardedFor, trustProxy, ipv6Prefix, (remoteAddr, xff, tp, p6) => {
        const input = { remoteAddr, ...(xff !== undefined ? { xForwardedFor: xff } : {}) };
        const config = makeConfig(tp, p6);
        const out = clientIp(input, config);
        expect(typeof out).toBe("string");
        // Deterministic: identical inputs → identical output (no hidden clock/random dependence).
        expect(clientIp(input, config)).toBe(out);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("SECURITY: trustProxy:false ignores X-Forwarded-For entirely (header cannot change the key)", () => {
    fc.assert(
      fc.property(ipToken, xForwardedFor, ipv6Prefix, (remoteAddr, xff, p6) => {
        const p = p6 !== undefined ? { ipv6Prefix: p6 } : {};
        const withXff = clientIp(
          { remoteAddr, ...(xff !== undefined ? { xForwardedFor: xff } : {}) },
          { trustProxy: false, ...p },
        );
        const without = clientIp({ remoteAddr }, { trustProxy: false, ...p });
        expect(withXff).toBe(without);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("numeric hop depth is respected exactly and clamps at the leftmost", () => {
    // A canonical IPv4 aggregates to itself, so `clientIp` must return exactly chain[clampedIdx].
    const octet = fc.integer({ min: 0, max: 255 });
    const ipv4 = fc.tuple(octet, octet, octet, octet).map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);
    fc.assert(
      fc.property(fc.array(ipv4, { minLength: 1, maxLength: 8 }), fc.nat(20), (chain, n) => {
        const remoteAddr = chain[chain.length - 1] as string;
        const xff = chain.slice(0, -1).join(", ");
        const out = clientIp({ remoteAddr, xForwardedFor: xff }, { trustProxy: n });
        const idx = Math.max(0, chain.length - 1 - n); // step N left from the socket peer, clamped
        expect(out).toBe(chain[idx]);
      }),
      { numRuns: 700 },
    );
  });
});

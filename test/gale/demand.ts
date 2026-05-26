/**
 * Deterministic, seeded demand-trace generators for the GALE Pillar 2 simulations.
 * Pure (seeded PRNG, no Date/Math.random) so every regret/safety test is bit-reproducible.
 */

/** mulberry32 PRNG: a fast, well-distributed, fully deterministic uniform generator in [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Approximate standard normal via the central-limit sum of 12 uniforms (mean 0, variance 1). */
export function gaussian(rng: () => number): number {
  let s = 0;
  for (let i = 0; i < 12; i++) s += rng();
  return s - 6;
}

/** One non-negative integer demand sample around `mean` with multiplicative noise (cv = stddev/mean). */
function sample(rng: () => number, mean: number, cv: number): number {
  if (mean <= 0) return 0;
  return Math.max(0, Math.round(mean * (1 + cv * gaussian(rng))));
}

/** Stationary demand: constant mean with multiplicative noise. */
export function makeStationary(t: number, mean: number, cv: number, seed: number): number[] {
  const rng = mulberry32(seed);
  return Array.from({ length: t }, () => sample(rng, mean, cv));
}

/** Smoothly drifting (non-stationary) demand: a sinusoidal mean with `periods` cycles over the horizon. */
export function makeDrift(
  t: number,
  base: number,
  amplitude: number,
  periods: number,
  cv: number,
  seed: number,
): number[] {
  const rng = mulberry32(seed);
  return Array.from({ length: t }, (_unused, i) => {
    const mean = base + amplitude * Math.sin((2 * Math.PI * periods * i) / t);
    return sample(rng, mean, cv);
  });
}

/**
 * Adversarial square-wave demand: `blocks` equal segments alternating between `lo` and `hi`. The
 * abrupt level shifts are exactly what a lagging EWMA estimator mis-tracks at each transition.
 */
export function makeAdversarial(
  t: number,
  lo: number,
  hi: number,
  blocks: number,
  cv: number,
  seed: number,
): number[] {
  const rng = mulberry32(seed);
  const blockLen = Math.max(1, Math.floor(t / blocks));
  return Array.from({ length: t }, (_unused, i) => {
    const high = Math.floor(i / blockLen) % 2 === 1;
    return sample(rng, high ? hi : lo, cv);
  });
}

/** A perfect (clairvoyant) prediction: the realised demand itself. */
export function predictPerfect(trace: readonly number[]): number[] {
  return trace.slice();
}

/** A good-but-imperfect prediction: each true demand perturbed by multiplicative noise (cv). */
export function predictNoisy(trace: readonly number[], cv: number, seed: number): number[] {
  const rng = mulberry32(seed);
  return trace.map((d) => Math.max(0, Math.round(d * (1 + cv * gaussian(rng)))));
}

/** An adversarial prediction that ignores reality — a deliberately useless oracle (constant value). */
export function predictConstant(trace: readonly number[], value: number): number[] {
  return trace.map(() => value);
}

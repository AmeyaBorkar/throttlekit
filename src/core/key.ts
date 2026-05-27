/** Key-namespacing shared by limiters and stores. */

/**
 * Build a key-prefixing function: with a non-empty `prefix`, `key => `${prefix}:${key}``; otherwise
 * the identity (no per-call allocation). The `prefix:key` join format is defined once here, so a
 * limiter and the store backing it can never split a keyspace by formatting the prefix differently.
 */
export function prefixer(prefix?: string): (key: string) => string {
  return prefix !== undefined && prefix.length > 0
    ? (key: string): string => `${prefix}:${key}`
    : (key: string): string => key;
}

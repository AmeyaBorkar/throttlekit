/**
 * A practical YAML subset for `.throttlekit.yaml` — **zero-dep**, deliberately narrow.
 *
 * Supports: block maps (consistent leading-space indent), scalars (bare string, double/single-quoted
 * string, number, `true`/`false`, `null`/`~`), inline flow maps `{ k: v, k2: v2 }`, `#` end-of-line
 * and whole-line comments, blank lines.
 *
 * Does **not** support: block lists, anchors/aliases, multiline scalars, multi-document streams,
 * nested flow maps. Anything outside the subset throws {@link YamlParseError} with a 1-based line
 * number — the config format is intentionally constrained so its meaning is unambiguous.
 */

import { ThrottleKitError } from "../core/errors";

export class YamlParseError extends ThrottleKitError {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`YAML parse error at line ${line + 1}: ${message}`, { code: "config_invalid" });
    this.name = "YamlParseError";
    this.line = line;
  }
}

interface Tokenized {
  indent: number;
  content: string;
  /** Zero-based original line number for error messages. */
  no: number;
}

function tokenize(text: string): Tokenized[] {
  const out: Tokenized[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let s = lines[i] ?? "";
    // Whole-line comment.
    if (/^\s*#/.test(s)) continue;
    // End-of-line comment: require a leading whitespace before `#` so a `#` inside a bare value is preserved.
    const hash = s.indexOf(" #");
    if (hash >= 0) s = s.slice(0, hash);
    if (/^\s*$/.test(s)) continue;
    const m = /^(\s*)(.*?)\s*$/.exec(s);
    const indent = (m?.[1] ?? "").length;
    const content = m?.[2] ?? "";
    if (content === "") continue;
    out.push({ indent, content, no: i });
  }
  return out;
}

function parseScalar(raw: string, lineNo: number): unknown {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(s)) return Number(s);
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s) as string;
    } catch {
      throw new YamlParseError(`malformed double-quoted string ${s}`, lineNo);
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith("{")) return parseFlowMap(s, lineNo);
  // Bare string.
  return s;
}

function parseFlowMap(raw: string, lineNo: number): Record<string, unknown> {
  const s = raw.trim();
  if (!s.startsWith("{") || !s.endsWith("}"))
    throw new YamlParseError("flow map must be { ... }", lineNo);
  const body = s.slice(1, -1).trim();
  if (body === "") return {};
  // We don't support nested flow maps — keep the parser predictable.
  if (body.includes("{") || body.includes("}"))
    throw new YamlParseError("nested flow maps are not supported", lineNo);
  const out: Record<string, unknown> = {};
  for (const pair of body.split(",")) {
    const trimmed = pair.trim();
    if (trimmed === "") continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) throw new YamlParseError('expected "key: value" inside { … }', lineNo);
    const k = trimmed.slice(0, colon).trim();
    if (k === "") throw new YamlParseError("empty key in flow map", lineNo);
    out[k] = parseScalar(trimmed.slice(colon + 1).trim(), lineNo);
  }
  return out;
}

/** Parse a YAML-subset document into a plain object. Throws {@link YamlParseError} on any deviation. */
export function parseYaml(text: string): Record<string, unknown> {
  const lines = tokenize(text);
  let i = 0;

  const parseBlock = (indent: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    while (i < lines.length && lines[i]!.indent === indent) {
      const line = lines[i]!;
      const colon = line.content.indexOf(":");
      if (colon < 0)
        throw new YamlParseError(
          `expected "key: value", got ${JSON.stringify(line.content)}`,
          line.no,
        );
      const key = line.content.slice(0, colon).trim();
      if (key === "") throw new YamlParseError("empty key", line.no);
      const rest = line.content.slice(colon + 1).trim();
      i++;
      if (rest === "") {
        // A nested block (deeper indent) or a `null` value.
        const next = lines[i];
        if (next !== undefined && next.indent > indent) {
          out[key] = parseBlock(next.indent);
        } else {
          out[key] = null;
        }
      } else {
        out[key] = parseScalar(rest, line.no);
      }
    }
    return out;
  };

  if (lines.length === 0) return {};
  if (lines[0]!.indent !== 0)
    throw new YamlParseError("top-level keys must start at column 0", lines[0]!.no);
  const result = parseBlock(0);
  // Any leftover line means an indent error that escaped the block we returned from.
  if (i < lines.length)
    throw new YamlParseError(
      `unexpected indentation at ${JSON.stringify(lines[i]!.content)}`,
      lines[i]!.no,
    );
  return result;
}

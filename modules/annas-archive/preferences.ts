/**
 * ordered preferences. commas tie; `>` moves to a lower tier.
 *
 *     language: en, pt-BR > pt > *
 *     format: pdf, epub > * > mobi
 *
 * `parsePreferences` reads named rules, one per line. `parsePreference` reads
 * just an expression, for callers that already know the name. both produce
 * frozen arrays of tiers; each tier contains equally preferred values.
 * names and values are normalized to lowercase. order within a tier is kept
 * for inspection, not used as a tie-breaker.
 *
 * grammar
 * -------
 *     document   = line { newline line }
 *     line       = [ name ":" expression ] [ comment ]
 *     expression = tier { ">" tier }
 *     tier       = value { "," value }
 *     name       = letter { letter | digit | "_" | "-" }
 *     value      = alphanumeric { alphanumeric | "." | "_" | "+" | "-" } | "*"
 *     comment    = "#" text-to-end-of-line
 *
 * letters and digits are ASCII. surrounding whitespace is ignored. blank lines
 * and `#` comments are allowed; a final newline is optional. LF, CRLF, and CR line
 * endings work. expressions cannot span lines. this is not YAML: no quoting,
 * escaping, nested keys, or partial globs such as `en-*`.
 *
 * empty tiers/values, repeated names, and repeated values within a rule are
 * errors, including case-only duplicates. `*` may occur once per rule, alone
 * or alongside other values. an empty document is valid; an empty expression
 * is not. errors include a one-based line and column in the original input.
 *
 * matching
 * --------
 * `preferenceTier` returns a zero-based tier, or null when nothing matches.
 * explicit values always beat `*`, regardless of their position. in
 * `pdf, epub > * > mobi`, mobi belongs to tier 2, not tier 1. the wildcard is
 * the remainder, not a glob evaluated from left to right. without `*`,
 * unlisted values have no tier. lookup trims whitespace and ignores case.
 *
 * identifiers are opaque: `pt` and `pt-BR` are distinct. this module does not
 * infer locales, aliases, missing metadata, or file types. callers must make
 * those domain decisions before lookup. it also does not sort search results,
 * combine dimensions, or decide which tiers are normal, faded, or hidden.
 * ranking describes preference; presentation depends on the results found.
 *
 * no imports, I/O, host globals, or dependencies. copy this file to use it
 * elsewhere. returned data is immutable, including the named-rule object.
 *
 * @example
 * const rules = parsePreferences("format: pdf, epub > * > mobi");
 * const format = rules.format!;
 * preferenceTier(format, "EPUB"); // 0: tied with pdf
 * preferenceTier(format, "azw3"); // 1: wildcard remainder
 * preferenceTier(format, "mobi"); // 2: explicitly reserved for last
 */

export type Preference = readonly (readonly string[])[];
export type Preferences = Readonly<Record<string, Preference | undefined>>;

export class PreferenceSyntaxError extends SyntaxError {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(`line ${line}, column ${column}: ${message}`);
    this.name = "PreferenceSyntaxError";
    this.line = line;
    this.column = column;
  }
}

function expression(source: string, line: number, column: number): Preference {
  const tiers: (readonly string[])[] = [];
  const seen = new Set<string>();
  let tierOffset = 0;

  for (const rawTier of source.split(">")) {
    const tier: string[] = [];
    let valueOffset = tierOffset;
    for (const rawValue of rawTier.split(",")) {
      const trimmed = rawValue.trim();
      const value = trimmed.toLowerCase();
      const position = column + valueOffset + (trimmed ? rawValue.indexOf(trimmed) : 0);
      if (!trimmed) throw new PreferenceSyntaxError("expected a value; empty tiers and empty comma entries are not allowed", line, position);
      if (!/^(?:[a-zA-Z0-9][a-zA-Z0-9._+-]*|\*)$/.test(trimmed)) {
        throw new PreferenceSyntaxError("expected an identifier or standalone *; quoting and partial globs are not supported", line, position);
      }
      if (seen.has(value)) throw new PreferenceSyntaxError(`duplicate value '${value}'`, line, position);
      seen.add(value);
      tier.push(value);
      valueOffset += rawValue.length + 1;
    }
    tiers.push(Object.freeze(tier));
    tierOffset += rawTier.length + 1;
  }
  return Object.freeze(tiers);
}

/** Parse a single-line expression. Comments work here too, as in a named rule. */
export function parsePreference(source: string): Preference {
  const newline = source.search(/[\r\n]/);
  if (newline !== -1) throw new PreferenceSyntaxError("an expression must fit on one line", 1, newline + 1);
  return expression(source.split("#", 1)[0], 1, 1);
}

/** A null-prototype object keeps rule names such as `constructor` ordinary keys. */
export function parsePreferences(source: string): Preferences {
  const rules: Record<string, Preference> = Object.create(null);
  const lines = source.split(/\r\n|[\r\n]/);
  for (const [index, rawLine] of lines.entries()) {
    const content = rawLine.split("#", 1)[0];
    if (!content.trim()) continue;
    const line = index + 1;
    const colon = content.indexOf(":");
    const column = content.search(/\S/) + 1;
    if (colon === -1) throw new PreferenceSyntaxError("expected name: expression", line, column);
    const rawName = content.slice(0, colon).trim();
    const name = rawName.toLowerCase();
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(rawName)) throw new PreferenceSyntaxError("expected a rule name starting with a letter", line, column);
    if (name in rules) throw new PreferenceSyntaxError(`duplicate rule '${name}'`, line, column);
    rules[name] = expression(content.slice(colon + 1), line, colon + 2);
  }
  return Object.freeze(rules);
}

/** Search all explicit values first: a wildcard cannot steal a later value. */
export function preferenceTier(preference: Preference, value: string): number | null {
  const normalized = value.trim().toLowerCase();
  let wildcard: number | null = null;
  for (const [index, tier] of preference.entries()) {
    for (const candidate of tier) {
      if (candidate === "*") wildcard = index;
      else if (candidate.trim().toLowerCase() === normalized) return index;
    }
  }
  return wildcard;
}

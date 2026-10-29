import { readFileSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { responseText } from "./http.ts";
import { createSearchSession, SessionError } from "./session.ts";
import { parsePreference, parsePreferences, preferenceTier, PreferenceSyntaxError, type Preference } from "./preferences.ts";

export class SearchError extends Error {}
export const defaultPreferencesFile = fileURLToPath(new URL("./preferences.conf", import.meta.url));
export interface SearchPreferences { language: Preference; format: Preference }
export interface SearchOptions {
  query: string;
  preferences: SearchPreferences;
  pages: number;
  limit: number;
  all: boolean;
  annaBaseUrl: string;
}
export interface Book {
  md5: string;
  title: string;
  authors: string[];
  languages: string[];
  formats: string[];
  size: string;
  url: string;
}
export interface RankedBook extends Book {
  languageTier: number | null;
  formatTier: number | null;
  display: "normal" | "faded" | "hidden";
}
export interface SearchResult {
  source: "annas-archive";
  query: string;
  pagesFetched: number;
  candidates: number;
  hasMore: boolean;
  coverage: "fetched-pages-only";
  hidden: number;
  omitted: number;
  skippedRecords: number;
  duplicateRecords: number;
  preferences: SearchPreferences;
  results: RankedBook[];
}

/** Read the live file on every invocation. A broken preference must not silently disappear. */
export function loadPreferences(path: string, overrides: { language?: string; format?: string } = {}): SearchPreferences {
  try {
    const rules = parsePreferences(readFileSync(path, "utf8"));
    if (Object.keys(rules).some(key => key !== "language" && key !== "format") || !rules.language || !rules.format) {
      throw new SearchError("anna: preferences must define language and format, with no other rule names");
    }
    return {
      language: overrides.language === undefined ? rules.language : parsePreference(overrides.language),
      format: overrides.format === undefined ? rules.format : parsePreference(overrides.format),
    };
  } catch (error) {
    if (error instanceof SearchError) throw error;
    if (error instanceof PreferenceSyntaxError) throw new SearchError(`anna: invalid preferences: ${error.message}`);
    throw new SearchError("anna: cannot read preferences file; check ANNAS_ARCHIVE_PREFERENCES_FILE or --preferences");
  }
}

/** Never invent a region for bare Portuguese. Locale negotiation stays outside the parser. */
function language(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  try { return Intl.getCanonicalLocales(normalized)[0].toLowerCase(); }
  catch { return normalized; }
}
function best(tiers: (number | null)[]): number | null {
  const known = tiers.filter((n): n is number => n !== null);
  return known.length ? Math.min(...known) : null;
}
function languageTier(rule: Preference, codes: string[]): number | null {
  return best(codes.length ? codes.map(code => {
    const normalized = language(code);
    // A specific region reserves its tier even when a generic range appears earlier.
    const range = rule.flat().filter(token => token !== "*" && (normalized === token || normalized.startsWith(token + "-")))
      .sort((a, b) => b.length - a.length)[0];
    return preferenceTier(rule, range ?? normalized);
  }) : [preferenceTier(rule, "")]);
}

/**
 * tiers 0/1 are visible; deeper tiers are fallback-only. restrict language first,
 * then format, so a foreign PDF cannot suppress an English MOBI. the best surviving
 * pair is normal and lower visible pairs are faded. promotion happens after
 * filtering. absence means absence among fetched candidates, never archive-wide.
 */
export function rankBooks(books: Book[], preferences: SearchPreferences, all: boolean): RankedBook[] {
  const ranked = books.map(book => ({
    ...book,
    languageTier: languageTier(preferences.language, book.languages),
    formatTier: best(book.formats.length ? book.formats.map(f => preferenceTier(preferences.format, f)) : [preferenceTier(preferences.format, "")]),
    display: "hidden" as RankedBook["display"],
  }));
  const eligible = ranked.filter(b => b.languageTier !== null && b.formatTier !== null);
  const languageBest = best(eligible.map(b => b.languageTier));
  const languagePool = eligible.filter(b => b.languageTier! <= Math.max(1, languageBest ?? 1));
  const formatBest = best(languagePool.map(b => b.formatTier));
  const visible = new Set(languagePool.filter(b => b.formatTier! <= Math.max(1, formatBest ?? 1)));
  const score = (n: number | null) => n ?? Number.MAX_SAFE_INTEGER;
  ranked.sort((a, b) => score(a.languageTier) - score(b.languageTier) || score(a.formatTier) - score(b.formatTier));
  const top = ranked.find(b => visible.has(b));
  for (const book of ranked) if (visible.has(book)) {
    book.display = book.languageTier === top?.languageTier && book.formatTier === top.formatTier ? "normal" : "faded";
  }
  return all ? ranked : ranked.filter(book => book.display !== "hidden");
}

const text = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();

/**
 * parse the server-rendered index, never execute its scripts or fetch covers.
 * Anna also renders unrelated partial matches after an empty primary search;
 * those must not masquerade as matches. selectors are covered by reduced live
 * fixtures. missing markup is a schema failure, not proof of an empty index.
 */
export function parseSearchPage(html: string, baseUrl: string, query: string, page: number): { books: Book[]; skipped: number; hasMore: boolean } {
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll("script,style")) node.remove();
  if (!/ - Search - Anna[’']s Archive$/.test(document.querySelector("title")?.textContent ?? "") || !document.querySelector('form[action="/search"]')) {
    throw new SearchError("anna: expected Anna search HTML; received a challenge, login page, or changed markup");
  }
  const sections = [...document.querySelectorAll(".js-aarecord-list-outer")].filter(section =>
    ![...section.querySelectorAll(".italic.font-bold")].some(label => /partial matches/i.test(label.textContent ?? "")));
  if (sections.length !== 1) throw new SearchError("anna: search result sections changed; refusing to report no matches");
  const cards = [...sections[0].querySelectorAll("div.flex.pt-3")];
  if (cards.length > 50) throw new SearchError("anna: search page exceeded the 50-record budget");
  const books: Book[] = [];
  for (const card of cards) {
    const titleLink = card.querySelector('a.js-vim-focus[href^="/md5/"]');
    const md5 = titleLink?.getAttribute("href")?.match(/^\/md5\/([a-f0-9]{32})$/i)?.[1].toLowerCase();
    const title = text(titleLink?.textContent ?? "");
    const metadata = card.querySelector("div.text-gray-800.font-semibold");
    if (!md5 || !title || !metadata) continue;
    const [lang, format, size] = (metadata.textContent ?? "").split("·").map(text);
    if (format === undefined || size === undefined) continue;
    const author = card.querySelector('[class*="mdi--user-edit"]')?.closest("a");
    const authorName = text(author?.textContent ?? "");
    books.push({
      md5, title, authors: authorName ? [authorName] : [],
      languages: [...lang.matchAll(/\[([a-zA-Z][a-zA-Z0-9_-]*)\]/g)].map(match => language(match[1])),
      formats: format && !/^unknown$/i.test(format) ? [format.toLowerCase()] : [],
      size, url: new URL(`/md5/${md5}`, baseUrl).href,
    });
  }
  if (cards.length && !books.length) throw new SearchError("anna: search cards could not be parsed; refusing to report no matches");
  if (!cards.length && ![...document.querySelectorAll("span,p")].some(node => text(node.textContent ?? "") === "No files found.")) {
    throw new SearchError("anna: no explicit empty-search marker; refusing to report no matches");
  }
  // Treat pagination as evidence only; never follow a server-provided URL with a cookie.
  const hasMore = [...document.querySelectorAll('a[href*="page="]')].some(anchor => {
    try {
      const next = new URL(anchor.getAttribute("href")!, baseUrl);
      return next.origin === new URL(baseUrl).origin && next.pathname === "/search" &&
        next.searchParams.get("q") === query && next.searchParams.get("page") === String(page + 1);
    } catch { return false; }
  });
  return { books, skipped: cards.length - books.length, hasMore };
}

/** One login per invocation; only the configured Anna origin receives credentials. */
export async function search(options: SearchOptions, key: string, fetcher: typeof fetch = fetch): Promise<SearchResult> {
  if (!options.query.trim() || options.query.length > 300 || /[\x00-\x1f\x7f]/.test(options.query)) throw new SearchError("anna: search query must be 1–300 characters without control characters");
  if (!Number.isInteger(options.pages) || options.pages < 1 || options.pages > 5 || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new SearchError("anna: pages must be 1–5 and limit 1–100");
  }
  try {
    const session = await createSearchSession(options.annaBaseUrl, key, fetcher);
    const books = new Map<string, Book>();
    let pagesFetched = 0, skippedRecords = 0, duplicateRecords = 0, hasMore = false;
    for (let page = 1; page <= options.pages; page++) {
      if (page > 1) await pause(1000);
      const response = await session.page(options.query, page);
      let html: string;
      try { html = await responseText(response, 2 * 1024 * 1024); }
      catch { throw new SearchError("anna: invalid, oversized, or interrupted search response"); }
      const parsed = parseSearchPage(html, options.annaBaseUrl, options.query, page);
      pagesFetched++;
      skippedRecords += parsed.skipped;
      hasMore = parsed.hasMore;
      for (const book of parsed.books) {
        if (books.has(book.md5)) duplicateRecords++;
        else books.set(book.md5, book);
      }
      if (!hasMore) break;
    }
    const candidates = [...books.values()];
    const every = rankBooks(candidates, options.preferences, true);
    const selected = options.all ? every : every.filter(book => book.display !== "hidden");
    const result: SearchResult = {
      source: "annas-archive", query: options.query, coverage: "fetched-pages-only", pagesFetched,
      candidates: candidates.length, hasMore, skippedRecords, duplicateRecords,
      hidden: every.filter(b => b.display === "hidden").length,
      omitted: Math.max(0, selected.length - options.limit), preferences: options.preferences,
      results: selected.slice(0, options.limit),
    };
    session.assertPublic(JSON.stringify(result));
    return result;
  } catch (error) {
    if (error instanceof SearchError) throw error;
    if (error instanceof SessionError) throw new SearchError(`anna: ${error.message}; no retry was made`);
    throw new SearchError("anna: search failed; private details suppressed");
  }
}

export function renderSearch(result: SearchResult, color: boolean): string {
  const lines = [
    "Anna’s Archive index — file MD5s; download availability not probed",
    `${result.candidates} candidates; ${result.pagesFetched} page(s); ${result.hasMore ? "more pages available" : "no next page advertised"}; coverage is fetched pages only`,
    `${result.hidden} fallback/unranked record(s) hidden by default; ${result.omitted} record(s) beyond --limit`,
  ];
  if (!result.results.length) lines.push(result.candidates === 0 ? "no primary index matches" : "no candidates match these preferences; use --all or adjust the rules");
  for (const [index, book] of result.results.entries()) {
    const label = book.display === "hidden" ? "[hidden; --all] " : book.display === "faded" ? "[secondary] " : "";
    const block = [
      `${index + 1}. ${label}${text(book.title)}`,
      `   ${text(book.authors.join("; ")) || "author unknown"} | ${text(book.languages.join(", ")) || "language unknown"} | ${text(book.formats.join(", ")) || "format unknown"} | ${text(book.size) || "size unknown"}`,
      `   ${book.md5} — ${book.url}`,
    ].join("\n");
    lines.push(color && book.display !== "normal" ? `\x1b[2m${block}\x1b[0m` : block);
  }
  if (result.skippedRecords) lines.push(`warning: ${result.skippedRecords} malformed record(s) skipped`);
  if (result.duplicateRecords) lines.push(`warning: ${result.duplicateRecords} repeated MD5(s) deduplicated; pages may overlap`);
  return lines.join("\n");
}

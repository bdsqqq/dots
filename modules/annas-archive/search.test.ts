import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run, type Config } from "./cli.ts";
import { parsePreference } from "./preferences.ts";
import { defaultPreferencesFile, loadPreferences, parseSearchPage, rankBooks, renderSearch, search, type Book, type SearchOptions } from "./search.ts";
import { card, cards, cookie, hash, htmlResponse, key, loginResponse, page } from "./fixtures/index.ts";

const preferences = loadPreferences(defaultPreferencesFile);
const base: SearchOptions = { query: "design", preferences, pages: 1, limit: 20, all: false, annaBaseUrl: "https://annas-archive.gl" };
const book = (md5: string, languages: string[], formats: string[]): Book => ({ md5, title: md5, authors: [], languages, formats, size: "", url: `https://annas-archive.gl/md5/${md5}` });
const transport = (content: string): typeof fetch => async input => new URL(String(input)).pathname === "/account/" ? loginResponse() : htmlResponse(content);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "anna-search-"));
  const apiKeyFile = join(root, "key");
  writeFileSync(apiKeyFile, key, { mode: 0o600 });
  const cfg: Config = { enabled: true, apiKeyFile, baseUrl: base.annaBaseUrl };
  return { cfg, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("signed-in CLI search uses only Anna, returns file MD5s, and applies saved preferences", async () => {
  const { cfg, cleanup } = fixture();
  try {
    let requests = 0;
    const output = JSON.parse(await run(["search", "design", "--pages", "1", "--json"], cfg, async (input, init) => {
      requests++;
      const url = new URL(String(input));
      assert.equal(url.origin, base.annaBaseUrl);
      assert.equal(url.searchParams.has("key"), false);
      assert(init?.signal instanceof AbortSignal);
      if (url.pathname === "/account/") {
        assert.equal(init.method, "POST");
        assert.equal(new URLSearchParams(String(init.body)).get("key"), key);
        assert.equal(init.redirect, "manual");
        return loginResponse();
      }
      assert.equal(url.pathname, "/search");
      assert.equal(url.searchParams.get("q"), "design");
      assert.equal(url.searchParams.get("page"), "1");
      assert.equal(init.redirect, "error");
      assert.equal(new Headers(init.headers).get("Cookie"), `aa_account_id2=${cookie}`);
      return htmlResponse(page(cards));
    }));
    assert.equal(requests, 2);
    assert.equal(output.source, "annas-archive");
    assert.equal(output.coverage, "fetched-pages-only");
    assert.equal(output.hidden, 3);
    assert.deepEqual(output.results.map((r: Book) => r.title), ["Preferred PDF", "Brazilian", "Preferred EPUB", "Secondary Portuguese", "European Portuguese"]);
    assert.deepEqual(output.results.map((r: { display: string }) => r.display), ["normal", "normal", "faded", "faded", "faded"]);
    assert.deepEqual(output.results[1].languages, ["pt-br"]);
    assert.deepEqual(output.results[3].languages, ["pt"]);
    for (const item of output.results) assert.equal(item.url, `${base.annaBaseUrl}/md5/${item.md5}`);
    assert(!JSON.stringify(output).includes(key));
    assert(!JSON.stringify(output).includes(cookie));
  } finally { cleanup(); }
});

test("saved defaults prefer PDF over EPUB and keep other formats as fallback", () => {
  assert.deepEqual(preferences.format, [["pdf"], ["epub"], ["*"], ["mobi"]]);
  const candidates = [book("epub", ["en"], ["epub"]), book("other", ["en"], ["azw3"]), book("pdf", ["en"], ["pdf"])];
  assert.deepEqual(rankBooks(candidates, preferences, false).map(b => [b.md5, b.display]), [["pdf", "normal"], ["epub", "faded"]]);
  assert.deepEqual(rankBooks(candidates.slice(0, 2), preferences, false).map(b => [b.md5, b.display]), [["epub", "normal"]]);
  assert.deepEqual(rankBooks([candidates[1]], preferences, false).map(b => [b.md5, b.display]), [["other", "normal"]]);
});

test("reduced live HTML extracts actual MD5s and ignores partial-match recommendations", () => {
  const html = readFileSync(new URL("./fixtures/search.html", import.meta.url), "utf8");
  const parsed = parseSearchPage(html, base.annaBaseUrl, "The Design of Everyday Things", 1);
  assert.equal(parsed.books.length, 3);
  assert.equal(parsed.books[0].md5, "9e4af5615db9cd4c1c8d0579b98ee549");
  assert.equal(parsed.books[0].title, "The Design of Everyday Things: Revised and Expanded Edition");
  assert.deepEqual(parsed.books[0].authors, ["Don Norman"]);
  assert.deepEqual(parsed.books[0].languages, ["en"]);
  assert.deepEqual(parsed.books[0].formats, ["epub"]);
  assert.equal(parsed.books[0].size, "1.2MB");
  assert.equal(parsed.hasMore, true);
  const empty = parseSearchPage(readFileSync(new URL("./fixtures/empty.html", import.meta.url), "utf8"), base.annaBaseUrl, "no-match", 1);
  assert.deepEqual(empty.books, []);
  assert.equal(empty.skipped, 0);
});

test("MOBI fallback is suppressed by another eligible format, not a foreign-language PDF", () => {
  const mobi = book("mobi", ["en"], ["mobi"]);
  assert.deepEqual(rankBooks([mobi], preferences, false).map(b => [b.md5, b.display]), [["mobi", "normal"]]);
  assert.deepEqual(rankBooks([mobi, book("other", ["en"], ["azw3"])], preferences, false).map(b => [b.md5, b.display]), [["other", "normal"]]);
  assert.deepEqual(rankBooks([mobi, book("foreign-pdf", ["fr"], ["pdf"])], preferences, false).map(b => b.md5), ["mobi"]);
  assert.deepEqual(rankBooks([mobi, book("portuguese-pdf", ["pt-pt"], ["pdf"])], preferences, false).map(b => [b.md5, b.display]), [["portuguese-pdf", "normal"]]);
});

test("empty higher tiers promote secondary and last-resort results to normal", () => {
  for (const candidate of [book("secondary", ["pt"], ["azw3"]), book("fallback", ["fr"], ["mobi"])]) {
    assert.equal(rankBooks([candidate], preferences, false)[0].display, "normal");
  }
  assert.deepEqual(rankBooks([book("unknown", [], [])], preferences, false).map(b => [b.languageTier, b.formatTier, b.display]), [[2, 2, "normal"]]);
});

test("language ranges belong to the adapter; specific regions reserve their tier", () => {
  const rules = { language: parsePreference("pt > pt-BR > *"), format: parsePreference("*") };
  const result = rankBooks([book("br", ["pt-br"], ["pdf"]), book("pt", ["pt"], ["pdf"]), book("ptpt", ["pt-pt"], ["pdf"])], rules, true);
  assert.equal(result.find(b => b.md5 === "br")!.languageTier, 1);
  assert.equal(result.find(b => b.md5 === "ptpt")!.languageTier, 0);
  assert.equal(result.find(b => b.md5 === "pt")!.languageTier, 0);
});

test("--all exposes hidden and unranked records without promoting them", () => {
  const rules = { language: parsePreference("en"), format: parsePreference("pdf, epub > * > mobi") };
  const results = rankBooks([book("foreign", ["fr"], ["pdf"]), book("mobi", ["en"], ["mobi"]), book("preferred", ["en"], ["pdf"])], rules, true);
  assert.deepEqual(results.map(b => [b.md5, b.display]), [["preferred", "normal"], ["mobi", "hidden"], ["foreign", "hidden"]]);
});

test("live preference edits and overrides apply without rebuilding", async () => {
  const { cfg, root, cleanup } = fixture();
  try {
    const path = join(root, "preferences.conf");
    writeFileSync(path, "language: en > pt > *\nformat: mobi > * > pdf, epub\n");
    const options = { ...cfg, preferencesFile: path };
    const first = JSON.parse(await run(["search", "design", "--pages", "1", "--json"], options, transport(page(cards))));
    assert.equal(first.results[0].title, "Last resort MOBI");
    writeFileSync(path, "language: en, pt-BR > pt > *\nformat: pdf, epub > * > mobi\n");
    const second = JSON.parse(await run(["search", "design", "--pages", "1", "--json"], options, transport(page(cards))));
    assert.equal(second.results[0].title, "Preferred PDF");
    const overridden = JSON.parse(await run(["search", "design", "--pages", "1", "--json", "--preferences", path, "--format", "mobi > * > pdf, epub", "--language", "en"], cfg, transport(page(cards))));
    assert.equal(overridden.results[0].title, "Last resort MOBI");
    for (const contents of ["", "langauge: en\nformat: pdf", "language: en\nformat: pdf >> epub"]) {
      writeFileSync(path, contents);
      await assert.rejects(run(["search", "design"], options, async () => { throw new Error("network must not run"); }), /preferences/);
    }
    assert.throws(() => loadPreferences(path + "-missing"), /cannot read preferences/);
  } finally { cleanup(); }
});

test("pagination deduplicates MD5s, keeps sibling order, and never claims complete coverage", async () => {
  let requests = 0;
  const result = await search({ ...base, pages: 2, limit: 1 }, key, async input => {
    const url = new URL(String(input));
    if (url.pathname === "/account/") return loginResponse();
    requests++;
    assert.equal(url.searchParams.get("page"), String(requests));
    return htmlResponse(requests === 1 ? page(card(1, "one"), "design", 2) : page(card(1, "one") + card(2, "two")));
  });
  assert.equal(requests, 2);
  assert.equal(result.candidates, 2);
  assert.equal(result.duplicateRecords, 1);
  assert.equal(result.omitted, 1);
  assert.equal(result.results[0].md5, hash(1));
  assert.equal(result.coverage, "fetched-pages-only");
  assert.equal(result.hasMore, false);
  assert.match(renderSearch(result, false), /pages may overlap/);
  const bounded = await search(base, key, transport(page(card(1, "one"), "design", 2)));
  assert.equal(bounded.hasMore, true);
  assert.equal(bounded.pagesFetched, 1);
});

test("explicit empty results differ from challenges, login pages, or markup drift", async () => {
  const empty = await search(base, key, transport(page("")));
  assert.equal(empty.candidates, 0);
  assert.match(renderSearch(empty, false), /no primary index matches/);
  for (const html of ["<title>DDoS-Guard</title>", "<form>Log in</form>", page("").replace("No files found.", "new markup"), page(card(1, "broken")).replace("js-vim-focus", "new-title-class"), page(card(1, "broken")).replace("text-gray-800", "new-meta-class")]) {
    await assert.rejects(search(base, key, transport(html)), /challenge|changed|marker|could not be parsed/);
  }
  await assert.rejects(search(base, key, transport("x".repeat(2 * 1024 * 1024 + 1))), /oversized/);
});

test("partial parse failures are visible and script text/comments cannot create records", async () => {
  const html = page(card(1, "good") + '<div class="flex pt-3">malformed</div>' + `<script>${card(2, "script fake")}</script><!--${card(3, "comment fake")}-->`);
  const result = await search(base, key, transport(html));
  assert.equal(result.candidates, 1);
  assert.equal(result.skippedRecords, 1);
  assert.match(renderSearch(result, false), /malformed record/);
});

test("foreign pagination links are never treated as permission to forward a cookie", async () => {
  const html = page(card(1, "one"), "design", 2).replace('href="/search?q=design&amp;page=2"', 'href="https://evil.test/search?q=design&amp;page=2"');
  const result = await search({ ...base, pages: 2 }, key, transport(html));
  assert.equal(result.pagesFetched, 1);
  assert.equal(result.hasMore, false);
});

test("untrusted text cannot inject terminal controls; plain output retains display labels", async () => {
  const result = await search({ ...base, all: true }, key, transport(page(card(1, "good") + card(2, "bad\x1b[2J\nnew line", "pt", "EPUB") + card(3, "mobi", "en", "MOBI"))));
  const plain = renderSearch(result, false);
  assert(!plain.includes("\x1b"));
  assert.match(plain, /\[secondary\]/);
  assert.match(plain, /\[hidden; --all\]/);
  const colored = renderSearch(result, true);
  assert.equal((colored.match(/\x1b\[2m/g) ?? []).length, 2);
  assert.equal((colored.match(/\x1b\[0m/g) ?? []).length, 2);
  assert(!colored.includes("\x1b[2J"));
});

test("successful metadata cannot reflect the account key or session cookie into either output format", async () => {
  const { cfg, cleanup } = fixture();
  try {
    for (const secret of [key, cookie, encodeURIComponent(key), [...cookie].map(c => "%" + c.charCodeAt(0).toString(16)).join("")]) {
      for (const flags of [[], ["--json"]]) {
        await assert.rejects(run(["search", "design", "--pages", "1", ...flags], cfg, transport(page(card(1, `reflected ${secret}`)))), error => {
          assert(error instanceof Error);
          assert.match(error.message, /private data/i);
          assert(!error.message.includes(key));
          assert(!error.message.includes(cookie));
          return true;
        });
      }
    }
    const valid = page(card(1, "public title")).replace("</body>", `<nav>${key} ${cookie}</nav></body>`);
    assert.match(await run(["search", "design", "--pages", "1"], cfg, transport(valid)), /public title/);
  } finally { cleanup(); }
});

test("disabled auth, removed catalog flags, and invalid budgets fail before requests", async () => {
  const { cfg, cleanup } = fixture();
  const offline: typeof fetch = async () => { throw new Error("network must not run"); };
  try {
    await assert.rejects(run(["search", "design"], { ...cfg, enabled: false }, offline), /integration disabled/);
    for (const args of [["search"], ["search", "x", "--pages", "0"], ["search", "x", "--pages", "6"], ["search", "x", "--limit", "101"], ["search", "x", "--source", "openlibrary"], ["search", "x", "--key", key], ["search", "x", "--json", "--json"], ["search", "x", "--language"], ["search", "x", "--pages", "1", "--pages", "2"], ["search", "x\x1b"]]) {
      await assert.rejects(run(args, cfg, offline), /anna:/);
    }
  } finally { cleanup(); }
});

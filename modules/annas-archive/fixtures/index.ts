// Synthetic variants of the reduced live card markup, never real credentials.
export const key = "fixture-account-key&not-another=parameter";
export const cookie = "fixture-session-cookie";
export const hash = (n: number) => n.toString(16).padStart(32, "0");
const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export function card(n: number, title: string, lang = "en", format = "PDF"): string {
  return `<div class="flex pt-3"><a href="/md5/${hash(n)}"><img></a><div><a class="js-vim-focus" href="/md5/${hash(n)}">${escape(title)}</a><a href="/search?q=Writer"><span class="icon-[mdi--user-edit]"></span>Writer</a><div class="text-gray-800 font-semibold">Language [${escape(lang)}] · ${escape(format)} · 2.1MB · 2024</div></div></div>`;
}
export function page(cards: string, query = "design", next?: number): string {
  return `<!doctype html><html><head><title>${escape(query)} - Search - Anna’s Archive</title></head><body><form action="/search"></form><div class="js-aarecord-list-outer">${cards}</div>${!cards ? '<span class="font-bold">No files found.</span>' : ""}${next ? `<a href="/search?${new URLSearchParams({ q: query, page: String(next) }).toString().replaceAll("&", "&amp;")}">Next</a>` : ""}</body></html>`;
}
export const htmlResponse = (html: string) => new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
export const loginResponse = () => new Response(null, { status: 302, headers: { "Set-Cookie": `aa_account_id2=${cookie}; Secure; HttpOnly; Path=/`, Location: "/account/" } });
export const cards = [card(1, "Preferred PDF"), card(2, "Preferred EPUB", "en-US", "EPUB"), card(3, "Brazilian", "pt_BR"), card(4, "Secondary Portuguese", "pt"), card(5, "Another format", "en", "DJVU"), card(6, "European Portuguese", "pt-PT"), card(7, "Foreign", "fr"), card(8, "Last resort MOBI", "en", "MOBI")].join("\n");

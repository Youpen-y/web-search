/**
 * Web Search Extension for Pi
 *
 * Gives Pi read-only web access with two capabilities:
 *   1. SEARCH  — find relevant links for a query
 *   2. FETCH   — read a URL's content as clean markdown
 *
 * The classic insight: search only needs to return {title, url, snippet};
 * once you have a URL, fetching the content is a separate, trivial step.
 * Pi's own LLM is the reasoning layer — no second LLM / subscription needed.
 *
 * Backends (all keyless):
 *   web_search  → local SearXNG CLI if available, else Wikipedia API
 *   fetch_url   → Jina Reader (r.jina.ai), free, no API key
 *
 * Search backend selection:
 *   - If a SearXNG CLI is reachable, `web_search` shells out to it for real
 *     web results (aggregates many engines, keyless, runs locally).
 *   - Otherwise it falls back to the Wikipedia API (keyless, reliable, but
 *     encyclopedic coverage only).
 *   The CLI is discovered via, in order:
 *       1. env SEARXNG_CMD   — full command prefix, e.g.
 *                              "searxng"
 *                              "uv run searxng"
 *                              "grun /data/.../searxng"
 *       2. `searxng` on PATH
 *   Optional env:
 *       SEARXNG_ENGINES     — comma list, default "google,duckduckgo,bing"
 *       SEARXNG_IT_ENGINES  — it-category dev engines, default "github,stackoverflow"
 *
 * Why these backends? In 2026 every major search engine (Google/Bing/DDG),
 * most public SearXNG instances, and paid search APIs (Jina Search, etc.)
 * block headless clients or require paid keys. A *local* SearXNG is the one
 * reliable keyless path to general web search. Jina Reader and the Wikipedia
 * API are the keyless fallbacks that still work.
 *
 * Tools:
 *   web_search  — search the web (SearXNG) or Wikipedia for a query
 *   fetch_url   — retrieve a URL's content as markdown
 *
 * Commands:
 *   /web <query> — quick search from the command line
 */

import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { load } from "cheerio";

// ─── Types ────────────────────────────────────────────────────

interface Hit {
  title: string;
  url: string;
  snippet: string;
}

interface SearchResult {
  hits: Hit[];
  backend: string;
  note?: string;
}

// ─── Constants ────────────────────────────────────────────────

const READER_BASE = "https://r.jina.ai/";
const DEFAULT_NUM = 5;
const FETCH_MAX_CHARS = 20000;
/** Lines shown when a fetch_url result is collapsed in the TUI. */
const FETCH_PREVIEW_LINES = 20;
const TIMEOUT_MS = 30_000;
const SEARXNG_SEARCH_TIMEOUT = 45_000;
const DEFAULT_ENGINES = "google,duckduckgo,bing";
/** Developer engines queried via the `it` category (reliable, API-based). SearXNG filters
 *  engines by one category per call, so these run as a second search and are merged in. */
const DEFAULT_IT_ENGINES = "github,stackoverflow";

// ─── Helpers ──────────────────────────────────────────────────

/** Ensure a URL has a protocol. */
function normalizeUrl(url: string): string {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return "https://" + u;
  return u;
}

/** Strip HTML tags and decode basic entities. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Run a shell command synchronously, returning trimmed stdout (or error string). */
function run(cmd: string, timeout = 10_000): { ok: boolean; out: string } {
  try {
    const out = execSync(cmd, { encoding: "utf8", timeout, stdio: ["pipe", "pipe", "pipe"] }).trim();
    return { ok: true, out };
  } catch (e: any) {
    return { ok: false, out: ((e.stderr || e.stdout || e.message || "") + "").trim().slice(0, 500) };
  }
}

/** Fetch text from a URL via Node fetch, aborting after TIMEOUT_MS. */
async function httpText(url: string, headers: Record<string, string> = {}): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "pi-web-search/1.0", ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (e: any) {
    return { ok: false, status: 0, text: e?.message || String(e) };
  }
}

/** Quote a string for safe single-quote bash usage. */
function bashSingle(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ─── Search backend: SearXNG CLI ──────────────────────────────

/** Resolve the command prefix to invoke the SearXNG CLI, or null if unavailable. */
function searxngCmd(): string | null {
  if (process.env.SEARXNG_CMD) return process.env.SEARXNG_CMD;
  const probe = run("command -v searxng 2>/dev/null");
  if (probe.ok && probe.out) return "searxng";
  return null;
}

/**
 * Search via a local SearXNG CLI: `<cmd> search QUERY --format json --engines ... --category ...`.
 * Parses SearXNG's standard JSON schema ({ results: [{ title, url, content }] }).
 *
 * SearXNG filters the `--engines` list by a single category per call, so general web
 * engines and `it` (developer) engines cannot share one call. We run one search per
 * category and merge the results.
 */

/** Run one SearXNG CLI search scoped to a category; return raw results, or null on failure. */
function searxngRun(cmd: string, query: string, engines: string, category: string): any[] | null {
  // os.tmpdir() is portable: /tmp on Linux, the Termux tmp dir on Termux,
  // and respects $TMPDIR when set. Suffix with category + randomness so the
  // general and it calls never collide on the same temp file.
  const tmpFile = `${os.tmpdir()}/pi-searxng-${category}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  // Write output to a temp file (NOT the execSync pipe) and bound wall-clock with
  // `timeout`. A spawned process tree can hold the stdout pipe open; redirecting to
  // a file guarantees execSync returns even if a grandchild lingers after a timeout.
  const inner = `${cmd} search ${bashSingle(query)} --format json --engines ${engines} --category ${category} > ${bashSingle(tmpFile)} 2>/dev/null`;
  const fullCmd = `timeout ${Math.floor(SEARXNG_SEARCH_TIMEOUT / 1000)} sh -c ${bashSingle(inner)}`;
  try { run(fullCmd, SEARXNG_SEARCH_TIMEOUT + 5_000); } catch { return null; }
  let out = "";
  try { out = fs.readFileSync(tmpFile, "utf8"); } catch { return null; }
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!out.trim()) return null;
  try { return JSON.parse(out)?.results || []; } catch { return null; }
}

function searxngSearch(query: string, num: number): SearchResult {
  const cmd = searxngCmd();
  if (!cmd) throw new Error("SearXNG CLI unavailable");

  const general = process.env.SEARXNG_ENGINES || DEFAULT_ENGINES;
  const it = process.env.SEARXNG_IT_ENGINES || DEFAULT_IT_ENGINES;
  const used = it ? `${general}, ${it}` : general;

  // Query each category separately, then merge. A batch is null when that call
  // failed entirely (timeout / no output); only an all-out failure throws, so the
  // caller can fall back to Wikipedia.
  const batches: (any[] | null)[] = [searxngRun(cmd, query, general, "general")];
  if (it) batches.push(searxngRun(cmd, query, it, "it"));
  const ok = batches.filter((b): b is any[] => Array.isArray(b));
  if (ok.length === 0) throw new Error("SearXNG CLI produced no output (timeout or failure)");

  // Interleave the batches so neither category buries the other, dedup by URL.
  const seen = new Set<string>();
  const hits: Hit[] = [];
  const maxLen = Math.max(...ok.map((b) => b.length));
  for (let i = 0; i < maxLen && hits.length < num; i++) {
    for (const b of ok) {
      const r = b[i];
      if (!r || !r.url) continue;
      const key = r.url.toString().trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        title: (r.title || "").toString().trim(),
        url: r.url.toString().trim(),
        snippet: stripHtml((r.content || r.description || "").toString()).slice(0, 300),
      });
      if (hits.length >= num) break;
    }
  }

  return { hits, backend: `SearXNG (local, ${used})` };
}

// ─── Search backend: Wikipedia (keyless fallback) ─────────────

/**
 * Wikipedia Search: free, keyless, reliable. Encyclopedic / factual coverage.
 * Defaults to en.wikipedia; pass `lang` to target another language edition.
 */
async function wikiSearch(query: string, num: number, lang?: string): Promise<SearchResult> {
  const wp = lang || "en";
  const url =
    `https://${wp}.wikipedia.org/w/api.php?action=query&list=search` +
    `&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${num}&utf8=1`;

  const res = await httpText(url);
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  let data: any;
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new Error(`Wikipedia returned non-JSON: ${res.text.slice(0, 200)}`);
  }
  const items: any[] = data?.query?.search || [];
  const hits: Hit[] = items.map((it): Hit => ({
    title: it.title,
    url: `https://${wp}.wikipedia.org/?curid=${it.pageid}`,
    snippet: stripHtml(it.snippet || ""),
  }));

  return {
    hits,
    backend: `Wikipedia (${wp})`,
    note:
      "Fell back to Wikipedia (encyclopedia only). For full-web search, install a local SearXNG CLI and set SEARXNG_CMD.",
  };
}

/** Top-level search: SearXNG CLI if available, else Wikipedia. */
async function searchWeb(query: string, num: number, lang?: string): Promise<SearchResult> {
  if (searxngCmd()) {
    try {
      return searxngSearch(query, num);
    } catch (e: any) {
      const fb = await wikiSearch(query, num, lang);
      return { ...fb, note: `SearXNG failed (${e.message}); fell back to ${fb.backend}. ${fb.note || ""}` };
    }
  }
  return await wikiSearch(query, num, lang);
}

// ─── Fetch backend: Jina Reader (free, no key) ────────────────

/** A chunk sliced from a longer document, with position metadata for paging. */
interface TextSlice {
  content: string;
  start: number;   // inclusive char offset actually returned
  end: number;     // exclusive char offset (use as the next `offset`)
  total: number;   // full document length
  hasNext: boolean; // more content beyond `end`
}

/**
 * Slice text to [offset, offset+maxChars), snapping the end backward to the
 * nearest paragraph break ("\n\n") so we never cut mid-paragraph or mid-code-block.
 * Callers page forward by passing the returned `end` as the next `offset`.
 */
function sliceText(text: string, offset: number, maxChars: number): TextSlice {
  const total = text.length;
  if (offset >= total) {
    return { content: "", start: total, end: total, total, hasNext: false };
  }
  const start = offset;
  let end = Math.min(start + maxChars, total);
  // Snap end back to a paragraph boundary, but only if it keeps >= 50% of the
  // requested window (don't throw away most of the chunk just to align).
  if (end < total) {
    const lastBreak = text.lastIndexOf("\n\n", end);
    if (lastBreak > start + Math.floor(maxChars * 0.5)) {
      end = lastBreak + 2; // include the "\n\n" so the next chunk starts clean
    }
  }
  return { content: text.slice(start, end), start, end, total, hasNext: end < total };
}

/**
 * Jina Reader: fetch a URL and return clean markdown.
 * Free, no API key required (rate-limited on the free tier).
 */
async function jinaReader(url: string, offset: number, maxChars: number): Promise<TextSlice> {
  const res = await httpText(READER_BASE + normalizeUrl(url), { "X-Retain-Images": "none" });
  if (!res.ok) {
    throw new Error(`Jina Reader HTTP ${res.status || "(network error)"}: ${res.text.slice(0, 200)}`);
  }
  return sliceText(res.text, offset, maxChars);
}

// ─── Fallback: Direct fetch + HTML-to-text ────────────────────

/**
 * Simple HTML-to-text conversion for fallback when Jina Reader is unreachable.
 * Uses cheerio for proper DOM parsing, strips unwanted elements, extracts
 * from main content area, and returns clean readable text.
 */
function htmlToText(html: string, baseUrl?: string): string {
  const $ = load(html);

  // Remove unwanted elements
  $('script, style, nav, header, footer, aside, noscript, svg, form, .sidebar, nav, .nav, .footer, .header, [role="navigation"]').remove();

  // Find best content container: main > article > [role=main] > .content > body
  let container = $('main, article, [role="main"], .post-content, .article-content, .content, #content, body').first();
  if (!container.length) container = $('body');

  // Headings → markdown-style prefix
  container.find('h1').prepend('# ');
  container.find('h2').prepend('## ');
  container.find('h3, h4').prepend('### ');
  container.find('h5, h6').prepend('#### ');

  // List items → bullet prefix
  container.find('li').each(function () {
    const parent = $(this).parent();
    const prefix = parent.is('ol') ? '1. ' : '* ';
    $(this).prepend(prefix);
  });

  // Table cells → pipe separation
  container.find('td, th').each(function () {
    $(this).append(' | ');
  });

  // Block elements → newline after
  container.find('h1, h2, h3, h4, h5, h6, p, div, li, tr, pre, br, hr, blockquote, section, details, summary, dl, dt, dd').each(function () {
    $(this).append('\n');
  });

  // Links → text [url]
  // Remove skip-to-content / accessibility-only links (href starts with #)
  container.find('a[href^="#"]').remove();

  // Resolve relative URL against base
  function resolveUrl(href: string): string {
    if (!baseUrl) return href;
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return href;
    }
  }

  // Links → text [url] (resolve relative URLs)
  container.find('a[href]').each(function () {
    const href = $(this).attr('href')!;
    const text = $(this).text().trim();
    if (href && text && href !== text && !href.startsWith('#') && !href.startsWith('javascript:')) {
      $(this).replaceWith(text + ' [' + resolveUrl(href) + ']');
    }
  });

  // Images → alt text
  container.find('img[alt]').each(function () {
    const alt = $(this).attr('alt')!.trim();
    if (alt) {
      $(this).replaceWith('[img: ' + alt + ']');
    }
  });

  // Get text and clean up whitespace
  let text = container.text();

  text = text
    .replace(/[ \t]+\n/g, '\n')      // trailing spaces before newline
    .replace(/\n[ \t]+/g, '\n')      // leading spaces after newline
    .replace(/[ \t]+/g, ' ')           // collapse inline spaces
    .replace(/\n{3,}/g, '\n\n')        // max 2 consecutive newlines
    .replace(/^[ \t]+|[ \t]+$/gm, '') // trim per line (not \s — don't eat newlines)
    .replace(/\| \n/g, '\n')           // clean trailing pipe before newline
    .trim();

  return text;
}

/**
 * Direct fetch fallback: fetch the URL directly and extract text content.
 * Used when Jina Reader is unreachable.
 */
async function directFetch(url: string, offset: number, maxChars: number): Promise<TextSlice> {
  const res = await httpText(normalizeUrl(url), {
    "User-Agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  });
  if (!res.ok) {
    throw new Error(`Direct HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  }
  const text = htmlToText(res.text, url);
  return sliceText(text, offset, maxChars);
}

// ─── Formatting ───────────────────────────────────────────────

function formatHits(hits: Hit[]): string {
  if (hits.length === 0) return "No results found.";
  return hits
    .map((h, i) =>
      `${i + 1}. ${h.title}\n   🔗 ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`
    )
    .join("\n\n");
}

// ─── Error helper ─────────────────────────────────────────────

function errorResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true as const,
    details: {},
  };
}

// ─── Main Extension ───────────────────────────────────────────

export default function webSearch(pi: ExtensionAPI) {

  // ── web_search ─────────────────────────────────────────────

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web for a query and return a list of results (title, URL, snippet). " +
      "Uses a local SearXNG CLI if one is available (set SEARXNG_CMD or have `searxng` on PATH); " +
      "otherwise falls back to the Wikipedia API (free, keyless). " +
      "Use this when the user asks to look something up online, find current information, or research a topic. " +
      "After finding relevant URLs, use fetch_url to read the full page content.",
    promptSnippet: "Search the web (SearXNG) or Wikipedia for a query",
    promptGuidelines: [
      "Use web_search when the user asks to look something up online or research a topic.",
      "Translate the query to English before searching — the Wikipedia fallback is the English edition and engines return the best results for English queries (e.g. send '量子力学' as 'quantum mechanics').",
      "web_search returns links and snippets; to read a page in full, follow up with fetch_url on the chosen URL.",
      "If no local SearXNG is configured, web_search covers Wikipedia only — tell the user and suggest installing a local SearXNG CLI (set SEARXNG_CMD) for general web search.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      num: Type.Optional(Type.Integer({ description: "Max number of results (default 5)", minimum: 1, maximum: 20 })),
      lang: Type.Optional(Type.String({ description: "Wikipedia language hint when falling back (e.g. 'zh', 'en'). Defaults to 'en' if omitted." })),
    }),
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const q = (args.query ?? "").trim();
      const display = q ? q : theme.fg("toolOutput", "...");
      text.setText(theme.fg("toolTitle", theme.bold("Web Search: ")) + display);
      return text;
    },
    async execute(_id, params) {
      const query = (params.query || "").trim();
      if (!query) return errorResult("❌ Query must not be empty");

      const num = params.num || DEFAULT_NUM;
      let result: SearchResult;
      try {
        result = await searchWeb(query, num, params.lang);
      } catch (e: any) {
        return errorResult(`❌ Search failed: ${e.message || e}`);
      }

      const body =
        `${result.backend}\n\n` +
        formatHits(result.hits) +
        (result.note ? `\n\n💡 ${result.note}` : "");

      return {
        content: [{ type: "text", text: body }],
        details: { backend: result.backend, count: result.hits.length, hits: result.hits },
      };
    },
  });

  // ── fetch_url ──────────────────────────────────────────────

  pi.registerTool({
    name: "fetch_url",
    label: "Fetch URL",
    description:
      "Retrieve the content of a web page as clean text (via Jina Reader with direct-fetch fallback, free, no API key). " +
      "Use this after web_search to read the full text of a result URL, or whenever the user wants the contents of a specific page. " +
      "Long pages are returned in chunks: if truncated, re-call with the returned `end` as `offset` to page through the rest.",
    promptSnippet: "Read a web page's content as markdown",
    promptGuidelines: [
      "Use fetch_url to read the full content of a URL returned by web_search, or any URL the user provides.",
      "fetch_url works without an API key (via Jina Reader).",
      "If a page is truncated (hasNext), re-call fetch_url with offset=<the returned `end`> to read the remainder chunk by chunk.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch (http/https). Bare domains are prefixed with https://." }),
      max_length: Type.Optional(Type.Integer({ description: "Max characters to return per chunk (default 20000)", minimum: 500, maximum: 100000 })),
      offset: Type.Optional(Type.Integer({ description: "Character offset to start reading from (for continuing long pages). Pass the `end` value returned by a previous call.", minimum: 0 })),
    }),
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const u = (args.url ?? "").trim();
      const display = u ? normalizeUrl(u) : theme.fg("toolOutput", "...");
      text.setText(theme.fg("toolTitle", theme.bold("Fetch: ")) + display);
      return text;
    },
    renderResult(result, options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const full = result.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");
      // Expanded (or empty): show everything.
      if (options.expanded || !full) {
        text.setText(theme.fg("toolOutput", full));
        return text;
      }
      // Collapsed: preview the first lines, with a hint to expand.
      const lines = full.split("\n");
      const shown = lines.slice(0, FETCH_PREVIEW_LINES);
      const hidden = lines.length - shown.length;
      let body = shown.map((l) => theme.fg("toolOutput", l)).join("\n");
      if (hidden > 0) {
        body += `${theme.fg("muted", `\n... (${hidden} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
      }
      text.setText(body);
      return text;
    },
    async execute(_id, params) {
      const url = (params.url || "").trim();
      if (!url) return errorResult("❌ URL must not be empty");

      const maxChars = params.max_length || FETCH_MAX_CHARS;
      const offset = params.offset || 0;
      let slice: TextSlice;

      try {
        slice = await jinaReader(url, offset, maxChars);
      } catch (e: any) {
        // Jina Reader unreachable → fall back to a direct fetch
        try {
          slice = await directFetch(url, offset, maxChars);
        } catch (e2: any) {
          return errorResult(`❌ Fetch failed (${url}): ${e2.message || e.message || e2}`);
        }
      }

      let note = "";
      if (slice.total > 0 && slice.hasNext) {
        note = `\n\n✂️ [Read ${slice.start}–${slice.end} of ${slice.total} chars. To continue, set offset=${slice.end}]`;
      } else if (slice.start > 0 && slice.content === "") {
        note = `\n\nℹ️ offset=${offset} is past the end of the document (${slice.total} chars); nothing more to read.`;
      } else if (slice.start > 0) {
        note = `\n\n✅ [Read ${slice.start}–${slice.end} of ${slice.total} chars; reached the end]`;
      }

      return {
        content: [{
          type: "text",
          text: `${slice.content}${note}`,
        }],
        details: {
          url: normalizeUrl(url),
          total: slice.total,
          offset: slice.start,
          end: slice.end,
          hasNext: slice.hasNext,
          returned: slice.content.length,
        },
      };
    },
  });

  // ── /web command ───────────────────────────────────────────

  pi.registerCommand("web", {
    description: "🌐 Quick web search (local SearXNG or Wikipedia)",
    handler: async (args, ctx) => {
      const query = (args || "").trim();
      if (!query) {
        ctx.ui.notify("Usage: /web <query>", "info");
        return;
      }
      const backend = searxngCmd() ? "SearXNG" : "Wikipedia";
      ctx.ui.setStatus("web-search", `Searching (${backend})…`);
      try {
        const result = await searchWeb(query, DEFAULT_NUM);
        if (result.hits.length === 0) {
          ctx.ui.notify(`🔍 No results found`, "info");
        } else {
          const lines = result.hits
            .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}`)
            .join("\n");
          ctx.ui.notify(`🔍 "${query}" (${result.backend})\n\n${lines}`, "info");
        }
      } catch (e: any) {
        ctx.ui.notify(`❌ Search failed: ${e.message || e}`, "error");
      } finally {
        ctx.ui.setStatus("web-search", "");
      }
    },
  });
}

# web-search

A [pi](https://pi.dev) extension that gives the agent **read-only web access** — no API keys, no paid subscriptions.

It exposes two tools and one command:

| Capability | What it does | Backend |
|---|---|---|
| `web_search` | Find relevant links for a query (`title`, `url`, `snippet`) | Local **SearXNG** CLI + **Wikipedia** API (multi-source) |
| `fetch_url` | Read a URL's content as clean markdown | **Jina Reader** → direct-fetch + `cheerio` fallback |
| `/web <query>` | Quick search from the TUI command line | same as `web_search` |

The key idea: **search only returns links; reading the page is a separate, trivial step.** Pi's own LLM is the reasoning layer — there is no second provider to pay for.

---

## Why these backends?

Most public search endpoints (Google/Bing/DDG scraping, public SearXNG instances, paid search APIs) block headless clients or require keys. A **locally-running SearXNG** is the one reliable, keyless path to real web search. Jina Reader and the Wikipedia API are keyless sources that keep working when SearXNG is absent or its engines are blocked.

Everything here is **keyless by design**.

---

## Tools

### `web_search`

> Search the web for a query and return a list of results (`title`, `url`, `snippet`).

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | string | yes | — | Search query |
| `num` | integer | no | `5` | Max results (1–20) |
| `lang` | string | no | `en` | Wikipedia language edition (e.g. `zh`, `en`). |

**Backend selection (multi-source):** Wikipedia is always queried; when a SearXNG CLI is reachable, real web + developer engines are queried too and the hits are merged. There is no fallback cascade — a failing source simply contributes nothing, so one going down never hides the others. With no SearXNG configured, only Wikipedia is used.

### `fetch_url`

> Retrieve a web page as clean markdown. Free, no API key.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | string | yes | — | URL to fetch (`http`/`https`). Bare domains are prefixed with `https://`. |
| `max_length` | integer | no | `20000` | Max characters returned per chunk (500–100000). |
| `offset` | integer | no | `0` | Character offset to start reading from — pass the `end` value from a previous call to page through long pages. |

Long pages are returned in chunks snapped to paragraph boundaries (never cut mid-paragraph or mid-code-block). When more content remains, the result includes a note like:

```
✂️ [Read 0–20000 of 48213 chars. To continue, set offset=20000]
```

If the primary backend (Jina Reader) is unreachable, the tool falls back to fetching the page directly and extracting text with `cheerio` (HTML stripped to readable markdown with resolved links, heading prefixes, and list/table formatting).

---

## `/web` command

```
/web <query>
```

Runs a quick search from the pi command line and pops the results in a notification. Uses the same backend logic as the `web_search` tool.

---

## Configuration

The extension works out of the box (Wikipedia + Jina Reader). To enable **full web search**, install a local SearXNG CLI.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SEARXNG_CMD` | *(auto: `searxng` on `PATH`)* | Full command prefix to invoke the SearXNG CLI. Examples: `searxng`, `uv run searxng`, `grun /path/to/searxng`. |
| `SEARXNG_ENGINES` | `google,duckduckgo,bing` | Comma-separated engine list passed to `searxng search --engines` (general category). |
| `SEARXNG_IT_ENGINES` | `github,stackoverflow` | Developer engines run via the `it` category as a second search and merged in. SearXNG filters engines by one category per call, so these cannot be mixed into `SEARXNG_ENGINES`. Set empty to disable. |

Set these in your shell environment (e.g. `~/.bashrc`, `~/.zshrc`) or in pi's settings before launch.

### Installing a SearXNG CLI

Any CLI that implements `searxng search "<query>" --format json --engines <list>` and emits SearXNG's standard JSON schema (`{ results: [{ title, url, content }] }`) will work.

The recommended one is **[searxng-ai-kit](https://github.com/nikvdp/searxng-ai-kit)** — a privacy-respecting metasearch CLI with MCP server support (AGPL-3.0). This extension invokes it as `searxng`, so the executable must be on your `PATH` under that name.

**Method 1 — pre-built binary (recommended).** Download the binary for your platform from the [releases page](https://github.com/nikvdp/searxng-ai-kit/releases), make it executable, and install it as `searxng`:

```bash
chmod +x searxng-ai-kit-*
mv searxng-ai-kit-* ~/.local/bin/searxng
searxng --help
```

**Method 2 — build from source (advanced).** Requires Python 3.11+ and [uv](https://docs.astral.sh/uv/):

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
git clone https://github.com/nikvdp/searxng-ai-kit
cd searxng-ai-kit
uv run python dev-setup.py   # build the pinned SearXNG wheel
uv tool install .
searxng --help
```

Verify detection: run a search; the first line names the backends, e.g. `SearXNG (local, google,duckduckgo,bing, github,stackoverflow) + Wikipedia (en)`.

### Routing SearXNG through a proxy

SearXNG ignores `HTTP_PROXY` / `HTTPS_PROXY` (it builds its own `httpx` transports), so engines blocked on your network silently return 0 results. Route through a proxy by adding one to `/etc/searxng/settings.yml` (auto-detected — no env var needed):

```bash
sudo mkdir -p /etc/searxng
sudo tee /etc/searxng/settings.yml >/dev/null <<'YAML'
use_default_settings: true
outgoing:
  proxies:
    all://:
      - http://127.0.0.1:8080   # ← your proxy
YAML
```

`use_default_settings: true` makes this a pure overlay on the bundled defaults. No `sudo`? Put the file anywhere and `export SEARXNG_SETTINGS_PATH` to it. The proxy restores *connectivity* only — it does not defeat anti-bot scraping (`google` CAPTCHAs, `duckduckgo` rate-limits), which is inherent to keyless scraping-based search.

---

## Installation as a pi extension

pi discovers the root `index.ts` automatically (no manifest needed) and installs `cheerio` for you.

```bash
pi install git:github.com/Youpen-y/web-search   # install permanently
pi -e git:github.com/Youpen-y/web-search        # try for this session only
pi list                                          # / pi remove ...
```

After installing (or `/reload`), the `web_search` / `fetch_url` tools and `/web` command are available.

> **Manual placement:** drop the directory under `~/.pi/agent/extensions/web-search/` (global) or `.pi/extensions/web-search/` (project-local); run `npm install` inside first.
>
> **Security:** extensions run with your full system permissions — only install from sources you trust.

---

## Dependencies

| Package | In | Why |
|---|---|---|
| [`cheerio`](https://www.npmjs.com/package/cheerio) | `dependencies` | Runtime: HTML→text extraction in the direct-fetch fallback. |
| `typebox` | `peerDependencies` | Schema builder for tool parameters. **Provided by pi at runtime** — pi injects its own bundled copy into extensions, so the extension always shares pi's instance. |
| `@earendil-works/pi-coding-agent` | `peerDependencies` | The pi host itself; provides the `ExtensionAPI` type. |
| `@types/node`, `typebox`, `@earendil-works/pi-coding-agent` | `devDependencies` | Local type-checking / IDE support only (not shipped at runtime). |

---

## Notes

- **Keyless.** No API keys are required or read. SearXNG, the Wikipedia API, and Jina Reader's free tier are all keyless.
- **Read-only.** This extension never sends data to the web; it only reads.

---

## License

MIT

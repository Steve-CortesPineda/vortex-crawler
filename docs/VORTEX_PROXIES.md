# Reviving walled search engines with VORTEX_PROXIES

Over plain `fetch()` from this box's IP, only **Bing** (and the logged-in **google-session** via the
VANTA extension) reliably answer. **Brave, Startpage, Mojeek, and DuckDuckGo are bot-walled** (403/429/202)
from a datacenter/home IP — so `web_search` fusion is effectively 2 engines instead of 6.

Routing engine fetches through a **residential proxy** revives all of them, restoring true multi-engine
fusion (stronger relevance, more cross-engine agreement, better diversity).

## How to enable

Set `VORTEX_PROXIES` to a comma-separated list of proxy URLs (rotated round-robin):

```
export VORTEX_PROXIES="http://user:pass@resi-host:port,http://user:pass@resi-host2:port"
```

Then restart the daemon (or the MCP server). What changes, automatically:

- **Engine pool widens.** `search.ts` switches `DEFAULT_ENGINES → PROXY_ENGINES`
  (`startpage, bing, brave, duckduckgo, mojeek`) via `proxiesConfigured()`.
- **Fetches route through the proxy.** `fetchHtml()` attaches an undici `ProxyAgent` dispatcher
  (`nextProxy()` rotates the list).
- The per-engine **circuit breaker** still applies — a proxy that gets an engine blocked just cools that
  engine down and the others carry on.

No code change needed — it's all env-gated and inert when unset (the fast lean path is unchanged).

## Verifying

```
# with a working proxy set, a search should show brave/startpage/mojeek/ddg as ok in engineReports:
curl -s -X POST 127.0.0.1:4477/search -d '{"query":"rust async runtime"}' \
  | python3 -c "import sys,json;[print(e['engine'],e['status']) for e in json.load(sys.stdin)['result']['engineReports']]"
```

If they still show `blocked`, the proxy isn't residential enough (many datacenter proxies are also walled)
or the credentials are wrong. A dead proxy makes ALL engines error (proves the dispatcher is applied).

## Cost note

Per Steve's rules (prefer free/owned): **google-session already covers the "strong index" need for free**
when you're logged in. Add a paid residential proxy only if you specifically want the *independent* indexes
(Brave/Mojeek find things Google buries). It's optional, not required for good results.

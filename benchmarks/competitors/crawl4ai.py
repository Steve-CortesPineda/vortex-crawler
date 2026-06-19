# Crawl4AI runner — sequential. Prints JSON {tool, crawl_ms, results}.
import asyncio, time, json, os
from crawl4ai import AsyncWebCrawler

URLS = json.load(open(os.path.join(os.path.dirname(os.path.dirname(__file__)), "urls.json")))

def md_len(r):
    md = getattr(r, "markdown", "") or ""
    if hasattr(md, "raw_markdown"):
        md = md.raw_markdown or ""
    return len(md)

async def main():
    results = []
    start = time.time()
    async with AsyncWebCrawler(verbose=False) as crawler:
        for url in URLS:
            t = time.time()
            try:
                r = await crawler.arun(url=url)
                results.append({"url": url, "ms": round((time.time() - t) * 1000), "chars": md_len(r), "ok": bool(getattr(r, "success", True))})
            except Exception as e:
                results.append({"url": url, "ms": round((time.time() - t) * 1000), "chars": 0, "ok": False, "err": str(e)[:80]})
    print(json.dumps({"tool": "crawl4ai", "crawl_ms": round((time.time() - start) * 1000), "results": results}))

asyncio.run(main())

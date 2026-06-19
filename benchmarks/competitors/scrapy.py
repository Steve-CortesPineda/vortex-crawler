# Scrapy runner — sequential (CONCURRENT_REQUESTS=1), HTTP-only (no JS). Prints JSON {tool, crawl_ms, results}.
import time, json, os, sys
import scrapy
from scrapy.crawler import CrawlerProcess

URLS = json.load(open(os.path.join(os.path.dirname(os.path.dirname(__file__)), "urls.json")))
results = []
start = time.time()

class BenchSpider(scrapy.Spider):
    name = "bench"
    start_urls = URLS
    custom_settings = {
        "CONCURRENT_REQUESTS": 1, "LOG_ENABLED": False, "ROBOTSTXT_OBEY": False,
        "DOWNLOAD_TIMEOUT": 30, "RETRY_ENABLED": False,
        "USER_AGENT": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
    }
    def parse(self, response):
        try:
            text = " ".join(t.strip() for t in response.css("body *::text").getall() if t.strip())
            results.append({"url": response.url, "chars": len(text), "ok": True})
        except Exception as e:
            results.append({"url": response.url, "chars": 0, "ok": False, "err": str(e)[:80]})

p = CrawlerProcess()
p.crawl(BenchSpider)
p.start()  # blocks until done
print(json.dumps({"tool": "scrapy", "crawl_ms": round((time.time() - start) * 1000), "results": results}))

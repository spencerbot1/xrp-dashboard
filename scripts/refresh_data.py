#!/usr/bin/env python3
"""Refresh the cached snapshot in data/dashboard.json.

Uses only the Python standard library. Intended to run on a schedule
(GitHub Actions cron, launchd, or manually) so the dashboard has a
fallback when the browser can't reach the live APIs, and so the
committed JSON always carries a recent as-of date.

Curated fields (score, monthly series) are left untouched — those are
replaced by the XRPL ingestion pipeline when it exists.
"""
import email.utils
import json
import re
import ssl
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timezone
from pathlib import Path

DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "dashboard.json"
RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"
RLUSD_HEX = "524C555344000000000000000000000000000000"
CTX = ssl.create_default_context()


def get_json(url: str, payload=None):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode() if payload else None,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "xrp-fundamentals-dashboard/1.0",
            "Accept": "application/json",
        },
        method="POST" if payload else "GET",
    )
    with urllib.request.urlopen(req, timeout=30, context=CTX) as res:
        return json.loads(res.read())


RELEVANT = re.compile(r"\bXRP\b|\bRLUSD\b", re.IGNORECASE)
RIPPLE_CTX = re.compile(r"\bripple\b", re.IGNORECASE)
CRYPTO_CTX = re.compile(
    r"crypto|token|stablecoin|SEC\b|ledger|price|ETF|escrow|Garlinghouse|payment|custody|bank",
    re.IGNORECASE,
)


def fetch_news(max_items: int = 8):
    """XRP headlines from Google News RSS, last 72h, relevance-filtered."""
    url = (
        "https://news.google.com/rss/search"
        "?q=XRP%20OR%20Ripple%20OR%20RLUSD%20when:3d&hl=en-US&gl=US&ceid=US:en"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "xrp-fundamentals-dashboard/1.0"})
    with urllib.request.urlopen(req, timeout=30, context=CTX) as res:
        root = ET.fromstring(res.read())

    now = datetime.now(timezone.utc)
    stories, seen = [], set()
    for item in root.findall(".//item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub = item.findtext("pubDate")
        source = (item.findtext("{*}source") or item.findtext("source") or "").strip()
        if not title or not pub:
            continue
        # relevance: XRP/RLUSD in the title, or Ripple-the-company in crypto context
        if not (RELEVANT.search(title) or (RIPPLE_CTX.search(title) and CRYPTO_CTX.search(title))):
            continue
        published = email.utils.parsedate_to_datetime(pub)
        age_h = (now - published).total_seconds() / 3600
        if age_h > 72:
            continue
        # Google News appends " - Source" to titles; strip it (and fill source if empty)
        if " - " in title:
            base, tail = title.rsplit(" - ", 1)
            if not source or tail.strip().lower() == source.lower():
                title = base
                source = source or tail.strip()
        key = re.sub(r"\W+", "", title.lower())[:60]
        if key in seen:
            continue
        seen.add(key)
        stories.append({
            "title": title.strip(),
            "source": source.strip(),
            "url": link,
            "publishedAt": published.astimezone(timezone.utc).isoformat(timespec="seconds"),
        })
    stories.sort(key=lambda s: s["publishedAt"], reverse=True)
    return stories[:max_items]


def main() -> int:
    data = json.loads(DATA_FILE.read_text())
    cached = data.setdefault("cached", {})
    ok = True

    try:
        markets = get_json(
            "https://api.coingecko.com/api/v3/coins/markets"
            "?vs_currency=usd&ids=ripple,ripple-usd"
        )
        by_id = {row["id"]: row for row in markets}
        xrp = by_id.get("ripple", {})
        rlusd = by_id.get("ripple-usd", {})
        cached.update(
            xrpPrice=xrp.get("current_price"),
            xrpMarketCap=xrp.get("market_cap"),
            xrpVolume24h=xrp.get("total_volume"),
            rlusdTotalSupply=rlusd.get("circulating_supply"),
        )
        print(f"CoinGecko ok — XRP ${xrp.get('current_price')}")
    except Exception as exc:  # noqa: BLE001
        ok = False
        print(f"CoinGecko failed: {exc}", file=sys.stderr)

    try:
        gw = get_json(
            "https://s1.ripple.com:51234/",
            {
                "method": "gateway_balances",
                "params": [{"account": RLUSD_ISSUER, "ledger_index": "validated"}],
            },
        )
        obligations = gw["result"].get("obligations", {})
        supply = obligations.get(RLUSD_HEX)
        if supply is not None:
            cached["rlusdOnXrpl"] = float(supply)
            print(f"XRPL ok — RLUSD on ledger: {float(supply):,.0f}")
    except Exception as exc:  # noqa: BLE001
        ok = False
        print(f"XRPL gateway_balances failed: {exc}", file=sys.stderr)

    try:
        data["news"] = fetch_news()
        print(f"News ok — {len(data['news'])} stories in the last 72h")
    except Exception as exc:  # noqa: BLE001
        ok = False
        print(f"News fetch failed: {exc}", file=sys.stderr)

    cached["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    data["asOf"] = date.today().isoformat()
    DATA_FILE.write_text(json.dumps(data, indent=2) + "\n")
    print(f"Wrote {DATA_FILE}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

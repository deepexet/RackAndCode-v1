"""Search for official equipment documentation (PDFs, manuals) via DuckDuckGo.

No external dependencies — uses stdlib urllib only.
Designed for ICT/low-voltage/security equipment documentation lookup.
"""
import html as html_mod
import re
import threading
import urllib.parse
import urllib.request
from typing import Any

_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
_TIMEOUT = 8


def search_docs(query: str, max_results: int = 6) -> list[dict[str, Any]]:
    """Search for official manuals and PDFs for the given equipment query.

    Returns list of {url, title, snippet, isPdf, displayUrl} sorted by relevance
    (PDF links first, then guides, then general).
    """
    results_pdf: list[dict] = []
    results_docs: list[dict] = []

    def _fetch_pdf():
        results_pdf.extend(_ddg_search(f"{query} installation manual filetype:pdf", 4))

    def _fetch_docs():
        results_docs.extend(_ddg_search(f"{query} user guide technical documentation specifications", 4))

    # Parallel searches
    t1 = threading.Thread(target=_fetch_pdf, daemon=True)
    t2 = threading.Thread(target=_fetch_docs, daemon=True)
    t1.start(); t2.start()
    t1.join(timeout=_TIMEOUT + 2)
    t2.join(timeout=_TIMEOUT + 2)

    # Merge: PDFs first, then deduplicate
    seen: set[str] = set()
    merged: list[dict] = []
    for r in results_pdf + results_docs:
        url = r["url"]
        if url and url not in seen:
            seen.add(url)
            merged.append(r)

    # Sort: PDF > contains "manual"/"guide" in URL/title > rest
    def _score(r: dict) -> int:
        score = 0
        if r["isPdf"]:
            score += 3
        t_lower = r["title"].lower()
        u_lower = r["url"].lower()
        for kw in ("manual", "guide", "datasheet", "installation", "specification"):
            if kw in t_lower or kw in u_lower:
                score += 1
        return -score  # negative for ascending sort

    merged.sort(key=_score)
    return merged[:max_results]


def _ddg_search(query: str, max_results: int) -> list[dict[str, Any]]:
    if max_results <= 0:
        return []
    encoded = urllib.parse.quote_plus(query)
    url = f"https://html.duckduckgo.com/html/?q={encoded}&ia=web"
    req = urllib.request.Request(url, headers={
        "User-Agent": _UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
    })
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            content = resp.read().decode("utf-8", errors="replace")
    except Exception:
        return []
    return _parse_ddg(content, max_results)


def _parse_ddg(html_text: str, max_results: int) -> list[dict[str, Any]]:
    results: list[dict] = []

    # Each result block starts with class="result "
    blocks = re.split(r'(?=<div[^>]+class="result )', html_text)

    for block in blocks:
        if 'result__a' not in block:
            continue

        title_m = re.search(r'class="result__a"[^>]*>(.*?)</a>', block, re.DOTALL)
        href_m  = re.search(r'class="result__a"[^>]+href="([^"]+)"', block)
        snip_m  = re.search(r'class="result__snippet"[^>]*>(.*?)</a>', block, re.DOTALL)
        durl_m  = re.search(r'class="result__url"[^>]*>(.*?)</a>', block, re.DOTALL)

        if not title_m or not href_m:
            continue

        title    = _clean(title_m.group(1))
        href_raw = href_m.group(1)
        snippet  = _clean(snip_m.group(1))[:260] if snip_m else ""
        durl     = _clean(durl_m.group(1)) if durl_m else ""

        # Resolve DDG redirect
        if "/l/?" in href_raw:
            uddg = re.search(r"uddg=([^&\"]+)", href_raw)
            href = urllib.parse.unquote(uddg.group(1)) if uddg else durl
        else:
            href = href_raw

        if not title or not href or href.startswith("/") or href.startswith("javascript"):
            continue

        is_pdf = href.lower().endswith(".pdf") or "%2fpdf" in href.lower()
        display_url = durl or re.sub(r"https?://", "", href).split("/")[0]

        results.append({
            "url": href,
            "title": title,
            "snippet": snippet,
            "isPdf": is_pdf,
            "displayUrl": display_url,
        })

        if len(results) >= max_results:
            break

    return results


def _clean(s: str) -> str:
    return html_mod.unescape(re.sub(r"<[^>]+>", "", s)).strip()

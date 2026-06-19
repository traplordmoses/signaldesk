# Lark thread summary — paste-ready

_(Condensed from LEGAL_REDLINE_INTEGRATION.md for the Probly Social × Legal thread. Code-free.)_

---

**Probly X News Bot × Legal Redline Bot — News-Bot side is ready**

The News Bot (SignalDesk) side of the integration is scoped and **pre-built**, so we can plug in the moment the Legal Agent API is live — no manual copy-paste of drafts.

**Flow:** News Bot drafts a post → sends `{text [+ image], context}` to the Legal Redline Bot → gets back `{verdict, risk, redline, rationale}` → the verdict shows on the Lark review card *before* a human posts.

**Status (News Bot side):** built behind a feature flag and running today against a local stub, so the end-to-end flow already works before the real API exists. Going live = pointing it at the Legal Agent endpoint. It's **fail-open** — a Legal Agent outage never blocks posting.

**Scope boundaries:** fact-checking stays on our side (separate, since real-world events change). The Legal Agent reviews content as-provided and doesn't fetch context, so we pass everything it needs — text, image, headline, category, sources, and our own risk tags.

**What we need from @John Tang to flip to live:**
1. Endpoint + auth
2. Request/response schema (we've proposed one — happy to align to yours)
3. Image input format — URL, base64, or upload?
4. Sync or async, and the latency/throughput we should design for (~5 posts/hr, bursty)
5. Fail behavior on timeout (we default to fail-open + flag)
6. Does it return a redline (suggested edit) or just a verdict?
7. Comments vs main content — it reviews content as a whole today; if commentary needs separate rules (per @Nancy Yi), we'd define those with Legal.

Full spec doc available on request.

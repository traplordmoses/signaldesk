# Probly X News Bot × Legal Redline Bot — Integration Scope & Handoff

**News Bot side:** SignalDesk (Benjamin, builder/owner) · **Legal Agent side:** John Tang's team · **Status:** scoping (pre-API) · **Date:** 2026-06-16

> **Scope note.** "Probly X News Bot" = the **SignalDesk** service: news feeds + prediction-market signal → cluster → score → draft tweet(s) with Claude → Lark review card → a human posts on X. This document covers **only the News Bot side** of the integration. We are *scoping and handing off* — not building the Legal Agent. Where the Legal Agent's behavior is referenced it's per John Tang's notes (image-based visual input only for now; reviews submitted content as a whole; does not retrieve external context; assesses regulatory/legal/policy compliance).

---

## 1. Objective

Automate the chain **News Bot → Legal Redline Bot → risk/redline output** so every generated post gets a legal/compliance pass **before a human posts it**, with zero manual copy-paste.

**Why now:** Probly X targets ~**5 posts/hour** (far above BloFin / TxFlow volume). Manually routing each draft into a separate Legal Redline Bot doesn't scale — it has to be a step in the pipeline.

## 2. Current state (News Bot)

```
fetch (68 sources) → cluster → score (relevance + lightweight riskLevel/riskReasons)
   → Claude drafts 1–N variants per cluster → Lark review card → human clicks "Post on X"
```

- Posts are **text-only today**. The bot already tags each cluster with a coarse `riskLevel` (low/medium/high) + `riskReasons` (e.g. `["nuclear"]`) — a useful signal to pass downstream, but **not** a legal review.
- There is **no legal/compliance step** in the flow today. That's the gap this integration fills.
- Lark is "link mode" (outbound-only): the review card carries a "Post on X" link; the human is the final gate.

## 3. Target flow

```
Claude drafts a variant
        │
        ▼
  ┌─────────────────────────────┐
  │  Legal Redline Bot (John)   │  ← News Bot POSTs {text [+ image], context}
  │  reviews as-provided        │  → returns {verdict, risk, redline, rationale}
  └──────────────┬──────────────┘
        │
        ▼
  attach the legal verdict to the Lark review card
        │
        ▼
  human reads the legal feedback → edits in the X composer / skips / posts
```

Phase 1 is **advisory**: the legal verdict is shown on the card; the human still decides. Phase 2 can optionally **hard-gate** (suppress a draft the Agent marks `block`).

## 4. Where it plugs into the News Bot (concrete)

- In `src/lib/cron/scheduler.ts` (`runAutoGenerate`), **after** `generateSmartPosts(cluster)` and **before** `sendClusterToLark(...)`: call the Legal Agent once per draft, persist the verdict.
- Render the verdict inside `buildReviewCard` in `src/lib/lark/messages.ts` (a "⚖️ Legal review" block per draft: verdict badge + risk + rationale + any redline).
- New columns on `generated_posts`: `legal_verdict`, `legal_risk`, `legal_redline`, `legal_rationale`, `legal_reviewed_at`.
- Ship behind a **feature flag** (`LEGAL_REVIEW_ENABLED`) so the plumbing can land — stubbed — before John's API exists and before the gating policy is finalized.

## 5. Contract — what the News Bot SENDS (per draft)

Because the Legal Agent **reviews exactly what it's given and does not fetch context**, we pass everything it needs to judge in one shot:

| Field | Notes |
|---|---|
| `id` | News Bot post id — correlates the (possibly async) response + audit |
| `text` | the full tweet text that would post |
| `image` | image(s) when present — Phase 2 for news; needed for event/probability-visual posts. Format per the Legal Agent's supported input (see §7) |
| `post_type` | `news` \| `platform_event` \| `meme` — different risk profiles |
| `context` | cluster headline, category, topics, source names + 1-line summaries, content_mode, market/event link, **the News Bot's own `riskLevel` + `riskReasons`** |

## 6. Contract — what we need BACK

Machine-readable JSON so the News Bot can render and (later) gate automatically:

| Field | Notes |
|---|---|
| `verdict` | `pass` \| `flag` \| `block` |
| `risk_level` | `low` \| `medium` \| `high` |
| `categories` | e.g. `["regulatory","political","ethical","legal"]` |
| `redline` | suggested edits / a corrected version, **if** the Agent produces one |
| `rationale` | short human-readable explanation (shown on the Lark card) |
| `review_id`, `reviewed_at` | for audit / correlation |

## 7. Open questions for John Tang's team (the handoff asks)

1. **Endpoint + auth** — URL, auth scheme (token? mTLS?), environment (per-bot creds?).
2. **Request/response schema** — confirm/adjust §5–§6; is the response JSON as above?
3. **Image input mechanism** — URL reference, base64 inline, or upload-then-reference? (John: image-based input is the only supported visual format today.)
4. **Sync vs async** — does the call return the verdict inline, or accept-then-callback? If async, what's the callback/poll contract?
5. **Latency / SLA + throughput** — we generate in bursts (≤2 drafts/cluster, multiple clusters per 5-min tick; ~5 posts/hr published but more *reviewed*). What round-trip time + rate limits should we design for?
6. **Failure behavior** — on timeout/5xx, should the News Bot **fail-open** (post advisory "legal review unavailable") or **fail-closed** (hold the draft)? Our default proposal: fail-open + flag in Phase 1.
7. **Redline vs verdict-only** — does the Agent return suggested edits, or only a pass/flag/block + rationale?
8. **Comments vs main content** — John notes the Agent reviews content *as a whole* and doesn't separate accompanying commentary. Nancy wants commentary checked too. If comments need **distinct** rules, that's a rule-definition task with the Legal team — flag whether the current whole-content review is sufficient for Phase 1.
9. **Audit / versioning** — is each decision versioned (rule-set version, model version) so we can reproduce why a post was flagged?

## 8. Policy decisions for the Probly team (Nancy / Charles — not John)

- **Advisory vs hard gate.** Proposal: Phase 1 advisory (verdict on the card, human decides); Phase 2 optional auto-suppress on `block`.
- **Who owns the rule definitions** for commentary + visuals (per John, defined *with* the Legal team).
- **Retention/audit** policy for legal decisions.

## 9. Scope boundaries (what this is NOT)

- **Fact-checking is out.** The Probly team fact-checks separately because real-world events change (per Nancy). The Legal Agent doesn't retrieve context and is not a fact-checker — accuracy is handled upstream.
- **Whole-content review only.** The Agent doesn't distinguish main text vs comments today; separate comment rules are a Legal-team rule task, not a News-Bot change.
- **Visuals:** image-based supported now; other visual formats (e.g. native probability charts) are a Phase-2 item on the Legal Agent side. News posts are text-only today, so text review is the Phase-1 path; image review activates when event/probability-visual posts ship.

## 10. Phasing

- **Now (pre-API):** lock §5–§6 with John; build the News-Bot shim behind `LEGAL_REVIEW_ENABLED` against a stub; design the Lark-card legal block; add the `legal_*` schema. None of this needs John's API to exist.
- **When John exposes the API (next week):** wire the real endpoint, run cross-agent tests on live drafts, evaluate review quality, then decide advisory → gate.

## 11. Dependencies & next actions

| Item | Owner | When |
|---|---|---|
| "How other agents interact with the Legal Agent" doc | John Tang | Monday |
| Legal Agent API/interface exposed for testing | John Tang | next week |
| Agree the contract (§5–§6) + image-input format | News Bot ↔ John | after Monday's doc |
| News-Bot shim + card UI + `legal_*` schema (flagged, stubbed) | News Bot (Benjamin) | this week, in parallel |
| Gating policy (advisory vs block) | Probly team (Nancy / Charles) | before go-live |
| Comment / visual rule definitions | Legal team ↔ Nancy | as needed |

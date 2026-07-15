# OfferVault — AI Product Requirements Document
**Version:** 1.0  
**Date:** 2026-06-29  
**Author:** AI Senior Product Manager  
**Status:** Active Development — Iteration 1

---

## 1. Executive Summary

OfferVault is an AI-powered personal coupon intelligence layer that passively manages, surfaces, and activates savings at the exact moment a user is physically near a relevant store. It eliminates the three core failures of existing coupon apps: (1) users forget to look, (2) coupons expire unnoticed, and (3) savings are only recalled post-purchase. OfferVault flips this by being ambient — it watches, remembers, and notifies without the user doing anything after the initial setup.

---

## 2. Problem Statement

### The Pain
Americans leave an estimated $500+ billion in unredeemed coupons on the table each year. The failure isn't desire — it's friction and memory. Coupons arrive in email inboxes, text messages, paper receipts, and loyalty apps. The user's job is to remember which coupon exists, where it is, whether it's expired, and to recall it at the right moment in a store. That's four cognitive steps that fail under real-world conditions.

### The Status Quo
- **Honey / Capital One Shopping:** Browser extension focused on online checkout. Useless at physical retail.
- **Ibotta / Fetch:** Requires user to scan receipts *after* purchase to earn cashback. Reactive, not proactive.
- **Manufacturer apps (Walgreens, CVS):** Siloed — each requires a separate app, login, and manual activation.
- **Google Wallet / Apple Wallet:** Stores passes but has no intelligence layer to surface them contextually.

### The Insight
The moment of maximum coupon value is *before* the purchase decision, when the user is walking toward or into a store. No current solution operates at that moment for physical retail.

---

## 3. Target User

### Primary Persona: "The Organized Saver"
- Age 28–45, household income $60K–$120K
- Clips coupons mentally but loses track of them across channels
- Gets loyalty emails, texts from brands, has receipt-based coupons
- Shops at 5–10 recurring physical retailers (grocery, coffee, pharmacy, clothing)
- Uses iPhone or Android, comfortable with app permissions

### Secondary Persona: "The Deal Maximizer"
- More intentional coupon user, already uses Ibotta/Fetch
- Frustrated by the manual effort and post-purchase cashback model
- Wants proactive, at-the-moment reminders
- Slightly higher tech comfort — will grant location permissions

### Anti-Persona (not building for now)
- Enterprise/B2B procurement
- Extreme couponers managing 100+ offers simultaneously
- Users who never shop at physical retail

---

## 4. Product Goals

| Goal | Metric | Target (6 months) |
|------|--------|-------------------|
| Coupon extraction accuracy | % of valid coupons correctly parsed | > 92% |
| False positive notifications | Notifications for stores NOT nearby | < 5% |
| False negative rate | Missed nearby stores with active coupons | < 10% |
| Time-to-coupon | Seconds from opening app to viewing coupon | < 3s |
| Retention (D30) | Users still active at 30 days | > 40% |
| Notification opt-in rate | Users enabling location alerts | > 60% |

---

## 5. Feature Specification

### 5.1 Coupon Ingestion (Current)
**Text extraction:** User pastes email body or SMS text → Claude parses brand, discount, code, expiry, terms → structured coupon card created.

**Receipt OCR:** User uploads receipt image → Claude Vision identifies merchant, items, and any printed coupons/offers → coupon card created.

**Input formats supported:** Paste, file upload (any format via Canvas/heic2any conversion), live camera capture (getUserMedia), drag-and-drop, clipboard paste.

**Acceptance criteria:**
- Must handle HEIC, JPEG, PNG, WEBP, PDF screenshots
- Must extract: brand (required), discount amount (required), code (optional), expiry (optional), terms (optional)
- Must assign a canonical domain for logo lookup
- Must return `[]` gracefully on unrecognizable input — never hallucinate a coupon

### 5.2 Coupon Vault Display (Current)
- Card-per-coupon layout with brand logo (Google Favicons), discount headline, code, expiry
- Persistent across sessions via localStorage
- Smart search: Claude-powered semantic search, not just string match (e.g. "coffee" finds "Dunkin'")
- Copy-to-clipboard on coupon code tap

### 5.3 Location-Based Alerts (Current — partial)
- `navigator.watchPosition` tracks user location continuously when enabled
- On position change > 100m: query nearby stores matching saved brands
- Radius: 3 miles (4828m)
- Store lookup: Google Places API (primary) → Overpass/OpenStreetMap (fallback)
- On match: OS push notification + in-app banner with brand, discount, code
- Notification dedup: 1-hour cooldown per store+offer pair
- Throttle: minimum 30s between API queries

### 5.4 Authentication (Current)
- Google SSO via OAuth 2.0
- Session persisted in localStorage (JWT decoded client-side)
- User avatar + name displayed in header
- Sign-out clears session

---

## 6. AI Architecture

### 6.1 Models in Use
| Model | Role | Input | Output |
|-------|------|-------|--------|
| `claude-sonnet-4-6` | Coupon extraction from text | Raw email/SMS text | JSON array of coupon objects |
| `claude-sonnet-4-6` | Receipt parsing | Base64-encoded image | JSON array of coupon objects |
| `claude-sonnet-4-6` | Smart search | Query + offer list | Filtered/ranked JSON |

### 6.2 Prompt Design
All extraction prompts use strict output contracts: "Return ONLY a valid JSON array. No explanation. No markdown. If no offers found, return []."

This is a deliberate guardrail — it prevents Claude from returning prose, partial JSON, or markdown fences that break `JSON.parse()`. The system prompt defines the exact schema and field types.

### 6.3 Proxy Architecture
No API keys are exposed to the browser. All calls route through Vite's server-side proxy:
- `/api/anthropic` → `api.anthropic.com` with key injected by proxy
- `/api/places` → `maps.googleapis.com` with key injected by proxy

`origin` and `referer` headers are stripped to prevent API provider CORS rejections.

---

## 7. Guardrails

### 7.1 AI Output Guardrails

| Risk | Guardrail |
|------|-----------|
| Hallucinated coupons | Prompt explicitly says "If no offers found, return []" — never invent |
| Malformed JSON | `try/catch` on all `JSON.parse()` calls — surfaces error to user, never crashes |
| Injected prompt in coupon text | User-supplied text is input only, never injected into system prompt position |
| PII in coupon text (name, address) | System prompt instructs Claude to extract only offer-relevant fields — PII fields not in schema |
| Expired coupon surfaced as valid | Expiry parsed and stored; UI shows expiry date on card (filtering by expiry = next iteration) |
| Wrong brand associated to code | Brand field required — Claude asked to omit offer if brand is ambiguous |

### 7.2 Location & Notification Guardrails

| Risk | Guardrail |
|------|-----------|
| Continuous GPS drain | `enableHighAccuracy: false` — uses network/IP location, minimal battery impact |
| Notification spam | 1-hour per-store-per-offer dedup + 30s API query throttle |
| False positives from bad geo data | 100m movement minimum before re-query — avoids drift-based false triggers |
| Location data leaving device | Location coordinates only sent to Google Places or Overpass — never to Anthropic |

### 7.3 Security

| Risk | Mitigation |
|------|-----------|
| API key exposure in browser | Server-side proxy — keys never in client JS bundle |
| XSS via coupon content | React's JSX escaping — all coupon fields rendered as text nodes, not innerHTML |
| Image upload abuse | Images processed client-side (Canvas) before sending to Claude — no server stores the image |
| localStorage session hijack | OAuth JWT is read-only user profile data (name, email, avatar) — no financial or sensitive data stored |
| CORS bypass | Vite proxy removes `origin`/`referer` — if deployed to production, a real backend proxy (e.g. Next.js API routes or Express) must replace the Vite proxy |

**Critical production note:** Vite's proxy is development-only. Before any public deployment, API calls must route through a proper backend with rate limiting, authentication middleware, and secrets management (e.g. AWS Secrets Manager, Vercel environment variables).

---

## 8. Evals Framework

### 8.1 Extraction Accuracy Eval
**What to measure:** Given N ground-truth coupon inputs (emails, SMS texts, receipt images), does Claude extract the correct brand, discount, code, and expiry?

**Eval dataset to build:**
- 50 real promotional emails (sanitized)
- 20 SMS coupon texts
- 30 receipt images across categories (coffee, grocery, pharmacy, clothing)
- 10 adversarial inputs (no coupon, garbled text, competitor prices mistaken as coupons)

**Scoring:**
- Exact match on `code` field: binary (critical)
- Fuzzy match on `brand` field: >= 90% string similarity
- Discount value within ±5%: acceptable
- False positive (coupon created from non-coupon input): automatic failure

**Target:** >92% field-level accuracy, 0% false positives on adversarial set.

### 8.2 Search Relevance Eval
**What to measure:** Does semantic search surface the right coupon for a given user query?

**Eval pairs to build:**
- "coffee" → should surface Dunkin', Starbucks
- "shoes" → should surface Nike, Foot Locker
- "SAVE10" → should surface the offer with that exact code
- "expired" → should surface nothing (if expiry filtering added)

**Scoring:** Recall@3 — is the correct coupon in the top 3 results?

**Target:** >95% Recall@3.

### 8.3 Notification Precision Eval
**What to measure:** When a notification fires, is the store actually within the defined radius?

**Method:** Manual spot-check — enable alerts, walk to/from 5 known store locations, log: (a) was notification fired, (b) actual distance at time of notification.

**Target:** <5% false positives (notified when store >3 miles away), <10% false negatives (within 1 mile, no notification).

### 8.4 Latency Eval
**What to measure:** End-to-end time for coupon extraction.

| Operation | Target P50 | Target P95 |
|-----------|-----------|-----------|
| Text extraction | <3s | <6s |
| Receipt extraction | <5s | <10s |
| Smart search | <2s | <4s |
| Nearby store check | <3s | <5s |

---

## 9. Next Iteration Roadmap

### Iteration 2 (Next 4–6 weeks)

**P0 — Must ship**
1. **Expiry filtering** — Don't surface expired coupons. Add expiry badge + auto-hide when expired.
2. **Production backend** — Replace Vite proxy with a real server (Next.js API routes or Express). Required before any public URL share.
3. **Google Places integration** — The current Overpass fallback misses ~40% of commercial locations. Google Places dramatically improves notification accuracy.

**P1 — High value**
4. **Email auto-import** — Gmail API integration to scan inbox for coupon emails automatically, eliminating the paste step entirely.
5. **Coupon categories + tags** — Organize by category (Food, Retail, Pharmacy) + upcoming expiry sort.
6. **Notification history** — Log of every notification fired, so users can see what they acted on.

**P2 — Nice to have**
7. **Multi-device sync** — Replace localStorage with a real database (Supabase or Firebase) so coupons sync across devices.
8. **Share a coupon** — Let users share a coupon card via link or image.

### Iteration 3 (2–3 months)

1. **Apple/Google Wallet push** — Push coupon to native Wallet for barcode display at checkout.
2. **Automatic redemption tracking** — "Did you use this coupon?" prompt after location exit → builds personal savings dashboard.
3. **Brand deal intelligence** — "Starbucks tends to send 20% off codes in November — check your email" — pattern recognition across user's own history.
4. **Collaborative vaults** — Household sharing of coupon vault.

### Iteration 4 (4–6 months)

1. **Agent-based inbox watcher** — Background agent that monitors email/SMS and ingests new coupons without any user action.
2. **Deal score** — AI rates each coupon (is this actually a good deal vs. typical price?) using price history APIs.
3. **Push to POS** — Integration with retailers' loyalty APIs to apply coupon at checkout automatically.

---

## 10. Key Product Decisions & Trade-offs

### Decision 1: Single LLM for all AI tasks
**Chose:** Claude Sonnet for extraction, search, and receipt parsing.  
**Trade-off:** Could use a cheaper/faster model (Haiku) for structured extraction and reserve Sonnet for complex receipt parsing. Decision to use Sonnet everywhere prioritizes quality over cost at this stage.  
**Revisit when:** Monthly API spend exceeds $50 — at that point, route simple text extraction to Haiku.

### Decision 2: Client-side image processing
**Chose:** Canvas API + heic2any in the browser before sending to Claude.  
**Trade-off:** No server storage of user images (privacy win), but limits processing to what the browser can handle. Large RAW files or complex PDFs may fail.  
**Revisit when:** Adding PDF coupon books or multi-page receipt support.

### Decision 3: localStorage for persistence
**Chose:** localStorage for coupons and user session.  
**Trade-off:** Zero infrastructure cost, instant setup — but no cross-device sync, no backup, data lost if browser data cleared.  
**Revisit when:** Any second user signs up — immediately warrants a real DB.

### Decision 4: Overpass as location fallback
**Chose:** OpenStreetMap/Overpass as free fallback when no Google Places key.  
**Trade-off:** Free but incomplete — Overpass misses most US commercial locations that aren't mapped by the OSM community. False negative rate is high.  
**Fix:** Google Places API. The Vite proxy is already wired — just needs a key.

### Decision 5: No backend server
**Chose:** Vite dev server + client-side React only.  
**Trade-off:** Fastest path to working prototype, but fundamentally not deployable publicly. API keys secured only by Vite proxy (dev-time only).  
**Revisit:** Immediately, before sharing with anyone outside localhost.

---

## 11. Success Definition

OfferVault is successful in Iteration 1 when:
1. A user can paste a promotional email and have a coupon card appear in under 5 seconds.
2. A user walking within 1 mile of a store for which they have a coupon receives a notification before entering.
3. Zero API keys are exposed in the browser's network tab.
4. The user's coupon vault persists across browser sessions without re-entering data.

All four are true today on localhost.

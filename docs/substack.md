# I Built an AI That Reminds You About Coupons When You're Actually Near the Store
## What I learned shipping OfferVault — and why ambient AI is the most underbuilt product category right now

---

Last Tuesday I drove past a Dunkin' Donuts.

I had a 30% off coupon sitting in my inbox. Had it for two weeks. It expired that day at midnight. I didn't remember until I was back home, coffee in hand, full price paid.

That's not a memory problem. That's a product problem — one that $2 billion worth of coupon apps have somehow failed to solve. And I decided to spend a few weeks fixing it.

This is the story of building OfferVault: what I built, how the AI works, the trade-offs I made, and what I'd build next.

---

## The Problem Nobody Has Actually Solved

There are hundreds of coupon and cashback apps. Honey finds discount codes at online checkout. Ibotta gives you cashback after you scan a receipt. CVS and Walgreens have their own loyalty apps. Capital One Shopping checks prices when you're on Amazon.

Every single one of them has the same fundamental design failure: **they require you to remember they exist.**

You have to open Ibotta before you go shopping. You have to check Honey before you click buy. You have to remember the promo code that was in an email you got four days ago.

The moment of maximum coupon value — when you're physically standing near or walking into a store — is completely unserved. No app in 2026 will tap you on the shoulder and say: *"Hey, you have a 30% off coupon for the Dunkin' you're about to walk past."*

OfferVault does exactly that. And it was surprisingly buildable in a few weeks with modern AI tools.

---

## What OfferVault Actually Does

The core loop is simple:

1. **You paste a promo email, forward a text, or snap a receipt photo.** OfferVault uses AI to extract the brand, discount amount, coupon code, expiry date, and any terms. One tap, structured data.

2. **Your saved coupons live in a vault.** Card-based layout, brand logos, copy-to-clipboard on the code. Search works semantically — searching "coffee" surfaces Dunkin' and Starbucks even if you never typed those words.

3. **Turn on location alerts.** OfferVault watches your position in the background. When you move within 3 miles of a store you have a coupon for, your phone notifies you with the discount and code right there in the notification.

That's it. After the initial setup, you do nothing. The app works for you.

---

## The AI Architecture: Three Agents, One Thread

OfferVault uses three distinct AI invocations, each with a specific job. It's worth explaining each because they illustrate how LLMs can act as specialized agents inside a product rather than as one monolithic "the AI."

### Agent 1: The Coupon Extractor

When you paste text or upload a receipt image, this agent's entire job is structured data extraction.

The system prompt is precise and non-negotiable:

> *"You are a coupon extraction assistant. Extract ALL offers found. For each return: brand, discount, code, expiryDate, domain, terms. Return ONLY a valid JSON array. No explanation. No markdown. If no offers found, return []."*

The output contract is rigid by design. Claude is capable of returning beautifully written prose about a coupon. We don't want that. We want `[{"brand":"Dunkin'","discount":"30% off","code":"DUNK30","expiryDate":"2026-06-30"}]`. The prompt engineering enforces schema compliance.

For images (receipts, screenshots), the same agent receives a base64-encoded version of the image alongside the same structured prompt. Claude Vision handles OCR, layout understanding, and extraction in a single pass — no separate OCR step needed.

**What's novel here:** Before the image even reaches Claude, it goes through a client-side normalization pipeline. iPhone photos come as HEIC. Screenshots can be WEBP. Claude API only accepts JPEG, PNG, or WEBP. So we built a browser-side conversion layer using the Canvas API and a library called heic2any — every image is normalized to JPEG before it's analyzed. Users never think about file formats.

### Agent 2: The Search Agent

When you type in the search bar, you're not doing a string match — you're querying Claude with your natural language input alongside your entire coupon list.

The prompt says: *"Given these offers and this user query, return the subset that matches. Understand brand names, synonyms, product categories, and intent."*

This means:
- "coffee" surfaces Dunkin', Starbucks, Peet's
- "save 20" surfaces any 20%-off offer
- "expiring soon" could surface offers with near dates (with a little more prompt work)

A traditional search would fail on all three. The LLM gets them right because it understands language, not just strings. This is one of those places where using an AI model as a filter — not a generator — produces an experience that's qualitatively different from what a search index can do.

### Agent 3: The Location Intelligence Layer

This isn't a Claude agent — it's a geolocation pipeline. But it's worth describing as an "agent" because it operates autonomously and makes decisions.

`navigator.watchPosition()` calls a callback every time the device detects meaningful movement (>100 meters). That callback:
1. Checks if 30 seconds have passed since the last store query (rate limit)
2. Extracts the unique set of brands from your saved coupons
3. Queries Google Places or OpenStreetMap for each brand within a 3-mile radius
4. Matches results against your vault
5. Fires an OS push notification + in-app banner for each match (with a 1-hour dedup per store)

The "agent" here is not a language model — it's a deterministic decision tree running on a continuous sensor stream. This is an important design point: **not every AI-adjacent capability needs an LLM.** The location layer is geospatial logic. Using Claude to answer "is this store nearby?" would be slower, more expensive, and less accurate than a geocoordinate radius query.

Knowing which problems need LLMs and which don't is, honestly, the core skill of AI product management.

---

## The Security Architecture (and Why It Matters More Than You Think)

Every AI app that talks to an API has the same problem: the API key has to live somewhere. Put it in your frontend JavaScript and anyone who opens DevTools can steal it, rack up API bills on your account, and potentially access user data.

OfferVault solves this with a server-side proxy. All API calls from the browser go to `/api/anthropic` (our own server), which strips the browser's `origin` and `referer` headers, injects the real Anthropic API key, and forwards the request. The browser never sees the key.

Same pattern for Google Places: `/api/places` on our server, key injected, forwarded to Google.

This is not optional. It's table stakes for any AI product handling API keys. And it's one of the most commonly missed details in AI tutorials and starter kits, which tend to show `fetch("https://api.anthropic.com/v1/messages", { headers: { "x-api-key": process.env.REACT_APP_KEY } })` — which exposes your key in the browser bundle.

There are other security layers worth noting:

**No user data leaves the device for location.** Coordinates go to Google Places or OpenStreetMap to find store locations. They do not go to Claude. We don't send "user is at 41.74192, -88.21287" to any AI model.

**Images are processed client-side before transmission.** Your receipt photo is converted to JPEG in your browser. It's transmitted to Claude for analysis and then discarded — we don't store it on a server.

**XSS is handled by React's rendering model.** All coupon content (brand names, codes, terms) is rendered as text nodes, never as innerHTML. A coupon code that contains `<script>alert(1)</script>` will display literally, not execute.

---

## The Product Decisions I Made (and What I'd Change)

### Decision 1: One AI Model for Everything

I used Claude Sonnet for all three AI tasks: text extraction, image extraction, and search. Sonnet is capable and fast enough.

The trade-off: Haiku (Claude's smaller, cheaper model) would handle structured extraction from clean promo emails just fine — and at roughly 10x lower cost. The smarts of Sonnet are wasted when the input is "50% off, code SAVE50, expires July 4."

**What I'd do next:** Route simple text extraction to Haiku. Use Sonnet for complex receipt images and for search where semantic understanding matters. Estimated cost reduction: ~70% on extraction, same quality.

### Decision 2: localStorage for Everything

Coupons and user sessions live in localStorage. Zero infrastructure. Works on day one.

The trade-off: Data is device-locked. Clear your browser history and your vault is gone. Open the app on your phone and your coupons from your laptop aren't there. This is a fundamental limitation that becomes immediately painful for real users.

**What I'd do next:** Supabase (Postgres + Row Level Security + free tier) with the user's Google ID as the primary key. Each coupon row belongs to a user. Sync on login. Estimated time to implement: 2–3 days.

### Decision 3: Vite Dev Proxy as the "Backend"

The server-side proxy is implemented as a Vite development server configuration. This is elegant for local development but completely unusable in production — Vite's dev server is not a production web server.

**What I'd do next:** A Next.js app with API routes as the backend. `/pages/api/anthropic.js` and `/pages/api/places.js` become real server functions. Deploy to Vercel in 20 minutes. Environment variables managed through Vercel's dashboard.

### Decision 4: OpenStreetMap as Location Fallback

I used the Overpass API (which queries OpenStreetMap) as the store location source when no Google Places key is configured. OSM is free, open, and globally maintained.

The problem: OSM's commercial data is patchy. A Dunkin' Donuts at a specific strip mall may simply not be in the OSM database. We built it, tested it, and saw exactly this — zero results for a store that was demonstrably within half a mile.

**What I'd do next:** Google Places API is the obvious fix. Their commercial location database is orders of magnitude more complete. The proxy is already built; it needs a key and a billing account.

The deeper lesson here: **free data has real quality costs.** For a consumer product where location accuracy directly determines user trust, the cost of Google Places ($0.032 per search) is trivially small compared to the cost of a notification that doesn't fire when it should.

---

## The Iteration Roadmap: What a PM Should Build Next

If I were building OfferVault as a real product — not a prototype — here's what the next three sprints look like:

### Sprint 1: Make It Shippable
Before a single user can be onboarded, three things need to be true:
1. Real backend (Next.js API routes, not Vite proxy)
2. Expiry filtering (expired coupons shouldn't show up — this erodes trust fast)
3. Google Places enabled (notification accuracy is the core value prop — it has to work)

None of these are features. They're hygiene. Shipping without them would mean churning the first users you acquire.

### Sprint 2: Eliminate the Paste Step
The highest-friction moment in OfferVault is the onboarding: the user has to go find a promo email, copy the body, come back to the app, and paste it. Most users will do this once and then forget to do it again.

The fix: Gmail API integration. User grants read permission → app scans inbox for promotional emails → ingests coupons automatically, forever.

This is where the product becomes genuinely autonomous. You set it up once. It runs in the background. New Starbucks offer in your inbox at 9am → it's in your vault by 9:01.

### Sprint 3: Close the Loop on Redemption
Right now, OfferVault fires a notification but has no idea if you actually used the coupon. This means:
- No savings dashboard (users love seeing money saved)
- No expiry closure (the coupon stays in your vault forever after use)
- No learning (the app can't understand which notifications lead to redemption)

A simple post-notification prompt — "Did you use this coupon?" — unlocks all three. Store the response. Calculate total savings. Build a personal deal intelligence model over time.

### The Big Swing: Agentic Email Monitoring
The sprint-3 roadmap leads to an obvious longer-term product: a background agent that monitors your email continuously, extracts all offers, scores them ("is 15% off Nike actually a good deal this week?"), and sends you a weekly digest of your best available offers ranked by opportunity.

This is not a chatbot. It's not a prompt-response loop. It's a running AI agent with a defined task, a data store, and a scheduled execution model. It's the natural next step for a product that's already proven the extraction and notification loop.

---

## The Broader Pattern: Ambient AI

Most AI products are designed around a prompt-response loop. You ask, it answers. This is useful — but it's a small fraction of what AI can do as a product layer.

OfferVault is an example of a different pattern: **ambient AI.** The app:
- Watches a sensor (location)
- Maintains state (your coupon vault)
- Acts autonomously on triggers (store proximity)
- Requires no ongoing user input after setup

This pattern is underbuilt. Think about what else it applies to:
- A medication reminder that knows when you're home from the pharmacy
- A parking coupon that activates when your phone detects you're entering a downtown area
- A travel deal alert that fires when you're searching flights to a city where you have hotel points

All of these require: continuous sensor input, persistent structured state, AI-powered relevance matching, and ambient notification. The OfferVault architecture supports all four.

The apps that will matter in the next two years aren't the ones that answer your questions. They're the ones that already know what you need and tell you at the right moment — without being asked.

---

## What I'd Tell Any PM Building AI Products Right Now

**1. Decide early where LLMs belong and where they don't.**
Not every problem needs Claude. Location radius checks need math, not language models. Structured extraction from clean promo emails could use a smaller, cheaper model. Reserve your most capable AI for the tasks where understanding, not just processing, is required.

**2. Build the security layer before the first feature.**
The proxy architecture that keeps API keys off the client isn't an afterthought — it's the foundation. An AI product that leaks API keys is not a prototype; it's a liability.

**3. Output contracts are as important as model choice.**
Your prompts need to be as strict as a typed API schema. If Claude can return either a JSON array or a natural language paragraph, your app will fail in production. Define the contract. Enforce it in the prompt. Validate it in the catch block.

**4. Free data has quality costs that show up in user trust.**
OpenStreetMap is beautiful and free. It also missed a Dunkin' Donuts that was literally 0.8 miles away during testing. For consumer products, location data quality is not a nice-to-have — it's the product.

**5. Ambient AI is the next frontier.**
Prompt-response AI is the MVP of what AI products can be. The more interesting design space is: what does the AI watch, remember, and tell you — without you ever opening the app?

---

OfferVault took a few weeks to build and cost roughly $0 in infrastructure (a few dollars in Claude API calls during development). The core is working. Coupons get extracted. Notifications fire.

The Dunkin' coupon problem is solved. I just need to not forget to turn on location alerts.

---

*OfferVault is a personal project. Stack: React + Vite + Claude Sonnet + Google OAuth + Web Notifications + Geolocation API.*

*If you're building AI products or thinking about ambient AI as a product pattern — I'd love to hear what you're working on. Hit reply.*

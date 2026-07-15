# OfferVault — Project Context

## What this is
AI-powered coupon vault app. Single-page React app using Claude API to extract coupons from text/receipts, with location-based notifications when you're near a store you have a coupon for.

## Stack
- React 18 + Vite (port 3000)
- Anthropic Claude API (`claude-sonnet-4-6`) via Vite proxy at `/api/anthropic`
- Google OAuth SSO (`@react-oauth/google`) — client ID in `.env` as `VITE_GOOGLE_CLIENT_ID`
- Google Places API via Vite proxy at `/api/places` (key in `.env` as `GOOGLE_PLACES_API_KEY` — currently skipped, Overpass fallback active)
- heic2any + Canvas API for universal image format support
- Web Notifications + Geolocation for nearby store alerts

## Key files
- `coupon-vault.jsx` — entire app (single component)
- `main.jsx` — entry point, wraps app in `GoogleOAuthProvider`
- `vite.config.js` — dev server + two proxies (Anthropic, Google Places)
- `.env` — API keys (never commit this)
- `index.html` — entry HTML with Inter font

## Running
```bash
npm run dev   # starts on localhost:3000
```
Or just `./start.sh` (runs npm install first).

## Environment variables needed (.env)
```
ANTHROPIC_API_KEY=sk-ant-...
VITE_GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_PLACES_API_KEY=...   # optional — falls back to Overpass (OpenStreetMap) if missing
```

## Current state (as of last session)
- Google SSO login works — user stored in localStorage
- Coupon extraction from text and receipt images works
- Brand logos via Google Favicons
- Camera capture (getUserMedia), paste, drag-drop, file upload all work for receipts
- Location alerts: watches position, checks nearby stores, fires OS notification + in-app banner
- `checkNearbyStores` tries Google Places first, falls back to Overpass if no Places key
- Search radius: 3 miles (4828m = `NEARBY_RADIUS_M`)
- Overpass has 4-mirror rotation + 30s cooldown to avoid 429s

## Known limitations
- Mac has no GPS chip — location uses IP/WiFi, can be off by 0.5–1 mile
- OSM (Overpass) data is incomplete for many commercial locations (e.g. Dunkin')
- Google Places gives much better results but requires a paid API key
- OS notifications on Mac require Chrome to be allowed in System Settings → Notifications

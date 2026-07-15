# OfferVault

AI-powered coupon vault that extracts offers from emails, SMS, and receipt photos — then notifies you when you're near a store you have a coupon for.

## How it works

1. **Add coupons** — paste a promotional email or SMS, or upload/photograph a receipt. Claude extracts the brand, discount, code, and expiry automatically.
2. **Browse your vault** — all your offers in one place with brand logos, expiry dates, and copy-to-clipboard codes.
3. **Get notified at the store** — enable location alerts and OfferVault will send an OS notification when you're within 3 miles of a store you have an active coupon for.

## Stack

- React 18 + Vite
- [Claude API](https://www.anthropic.com) (`claude-sonnet-4-6`) for coupon extraction and receipt OCR
- Google OAuth for sign-in
- Google Places API for store proximity (falls back to OpenStreetMap/Overpass if no key)
- Web Notifications + Geolocation APIs
- heic2any + Canvas API for universal image format support (HEIC, WEBP, PNG, JPEG)

## Setup

**1. Clone and install**
```bash
git clone https://github.com/Sarukha2002/offervault.git
cd offervault
npm install
```

**2. Create a `.env` file**
```
ANTHROPIC_API_KEY=sk-ant-...
VITE_GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_PLACES_API_KEY=...   # optional — falls back to OpenStreetMap if omitted
```

- Get an Anthropic API key at [console.anthropic.com](https://console.anthropic.com)
- Get a Google OAuth client ID at [console.cloud.google.com](https://console.cloud.google.com) (enable the Google+ API and add `http://localhost:3000` as an authorized origin)
- Google Places key is optional — the app works without it using OpenStreetMap data

**3. Run**
```bash
npm run dev   # http://localhost:3000
```

Or use the helper script (runs `npm install` first):
```bash
./start.sh
```

## Input methods supported

| Method | How |
|--------|-----|
| Paste | Copy email/SMS text → paste into the text box |
| File upload | HEIC, JPEG, PNG, WEBP receipt photos |
| Camera | Live capture via browser camera access |
| Drag and drop | Drop an image onto the upload area |
| Clipboard paste | Ctrl/Cmd+V with an image in clipboard |

## Notes

- Coupon data is stored in `localStorage` — device-local, no backend.
- The Vite dev proxy handles API calls (Anthropic + Google Places). For production, route these through a proper backend with secrets management.
- Location on Mac uses IP/WiFi geolocation (no GPS chip) — accuracy can vary by 0.5–1 mile.
- OS notifications on Mac require Chrome to be allowed in System Settings → Notifications.

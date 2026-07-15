import { useState, useRef, useEffect } from "react";
import { GoogleLogin, googleLogout } from "@react-oauth/google";

// ─── Design tokens ───────────────────────────────────────────────
const T = {
  bg: "#FAFAF8",
  surface: "#FFFFFF",
  border: "#E8E6E1",
  borderLight: "#F0EEE9",
  text: "#1A1A18",
  textSub: "#6B6860",
  textMuted: "#A8A49D",
  accent: "#2D6A4F",       // forest green — trust, savings
  accentLight: "#EAF2ED",
  accentMid: "#52B788",
  warn: "#C0392B",
  warnLight: "#FDF0EF",
  yellow: "#B7791F",
  yellowLight: "#FFFBEB",
  radius: "10px",
  radiusSm: "6px",
  shadow: "0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
  shadowMd: "0 4px 12px rgba(0,0,0,0.08)",
};

const CATEGORIES = ["Food & Dining", "Fashion", "Grocery", "Beauty", "Travel", "Entertainment", "Retail", "Other"];

// ─── Claude API call ─────────────────────────────────────────────
async function extractWithClaude(text, mode = "text") {
  const systemPrompt = `You are a coupon and offer extraction agent. The user has shared ${mode === "receipt" ? "receipt text from a photo" : "email or SMS text"} containing offers, coupons, or rewards.

Extract ALL offers found. For each offer return a JSON array with objects containing:
- brand: string (store/restaurant name)
- category: one of [Food & Dining, Fashion, Grocery, Beauty, Travel, Entertainment, Retail, Other]
- offerTitle: short title (max 8 words)
- discount: string (e.g. "20% off", "$5 off", "Free item", "Points reward")
- code: string or null (promo code if present)
- expiryDate: string in YYYY-MM-DD format or null if not found
- conditions: string (any conditions, max 20 words, or "No conditions mentioned")
- source: "${mode === "receipt" ? "Receipt" : "Email/SMS"}"
- urgency: "high" (expires within 7 days or today only), "medium" (expires within 30 days), "low" (no expiry or far future)
- domain: string (brand's website domain e.g. "chipotle.com", or null if unknown)

Return ONLY a valid JSON array. No explanation. No markdown. If no offers found, return [].`;

  const response = await fetch("/api/anthropic/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: text }],
    }),
  });

  const data = await response.json();
  console.log("[OfferVault] API response", response.status, JSON.stringify(data).slice(0, 300));

  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${data.error?.message || JSON.stringify(data)}`);
  }

  const raw = data.content?.[0]?.text || "[]";
  try {
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch (e) {
    throw new Error(`Could not parse response: ${raw.slice(0, 100)}`);
  }
}

async function smartSearch(query, offers) {
  if (!query.trim() || offers.length === 0) return offers;

  const systemPrompt = `You are a smart coupon search agent. Given a user's search query and a list of saved offers, return the IDs of the most relevant offers, ranked by relevance.

User query: "${query}"

Return ONLY a JSON array of offer IDs (numbers) in order of relevance. If no offers match, return []. No explanation.`;

  const offerList = offers.map((o, i) => `ID ${i}: ${o.brand} - ${o.offerTitle} - ${o.discount} - ${o.category}`).join("\n");

  const response = await fetch("/api/anthropic/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      messages: [{ role: "user", content: `${systemPrompt}\n\nOffers:\n${offerList}` }],
    }),
  });

  const data = await response.json();
  const raw = data.content?.[0]?.text || "[]";
  try {
    const ids = JSON.parse(raw.replace(/```json|```/g, "").trim());
    return ids.map((id) => offers[id]).filter(Boolean);
  } catch {
    return offers;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────
function daysUntilExpiry(dateStr) {
  if (!dateStr) return null;
  const diff = Math.ceil((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24));
  return diff;
}

function expiryLabel(dateStr) {
  const days = daysUntilExpiry(dateStr);
  if (days === null) return null;
  if (days < 0) return { text: "Expired", color: T.textMuted };
  if (days === 0) return { text: "Expires today!", color: T.warn };
  if (days <= 7) return { text: `${days}d left`, color: T.warn };
  if (days <= 30) return { text: `${days}d left`, color: T.yellow };
  return { text: `${days}d left`, color: T.textSub };
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function formatDate(isoStr) {
  return new Date(isoStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function decodeJwt(token) {
  const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(base64));
}

function metersApart(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const NEARBY_RADIUS_M = 4828; // 3 miles

// ─── Image conversion ────────────────────────────────────────────
function canvasConvert(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (blob) => blob
          ? resolve(new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" }))
          : reject(new Error("Canvas export failed")),
        "image/jpeg", 0.92
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode failed")); };
    img.src = url;
  });
}

async function normalizeToJpeg(file) {
  const SUPPORTED = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  if (SUPPORTED.includes(file.type)) return file;

  try {
    return await canvasConvert(file);
  } catch {
    const isHeic = ["image/heic", "image/heif"].includes(file.type) ||
                   /\.(heic|heif)$/i.test(file.name);
    if (isHeic) {
      const heic2any = (await import("heic2any")).default;
      const result = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
      const blob = Array.isArray(result) ? result[0] : result;
      return new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" });
    }
    throw new Error("Could not convert this image. Please try a JPG or PNG.");
  }
}

// ─── Components ──────────────────────────────────────────────────
const AVATAR_COLORS = ["#2D6A4F","#1E40AF","#9D174D","#92400E","#5B21B6","#0369A1","#065F46","#991B1B"];
function avatarColor(brand) {
  let n = 0;
  for (let i = 0; i < brand.length; i++) n += brand.charCodeAt(i);
  return AVATAR_COLORS[n % AVATAR_COLORS.length];
}

function guessDomain(brand) {
  return brand.toLowerCase().replace(/[^a-z0-9]/g, "") + ".com";
}

function BrandLogo({ brand, domain }) {
  const [failed, setFailed] = useState(false);
  const src = `https://www.google.com/s2/favicons?domain=${domain || guessDomain(brand)}&sz=64`;
  const color = avatarColor(brand);

  if (failed) {
    return (
      <div style={{
        width: 36, height: 36, borderRadius: 8, flexShrink: 0,
        background: color, display: "flex", alignItems: "center", justifyContent: "center",
        fontWeight: 700, fontSize: 15, color: "#fff", userSelect: "none",
      }}>
        {brand[0].toUpperCase()}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={brand}
      onError={() => setFailed(true)}
      style={{
        width: 36, height: 36, borderRadius: 8, flexShrink: 0,
        objectFit: "contain",
      }}
    />
  );
}

function Badge({ text, color, bg }) {
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: "20px",
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: "0.02em",
      color: color || T.textSub,
      background: bg || T.borderLight,
    }}>{text}</span>
  );
}

function CouponCard({ offer, onDelete, onCopy, onMarkUsed }) {
  const [copied, setCopied] = useState(false);
  const expiry = expiryLabel(offer.expiryDate);
  const expired = offer.expiryDate && daysUntilExpiry(offer.expiryDate) < 0;

  const categoryColors = {
    "Food & Dining": { bg: "#FEF3C7", color: "#92400E" },
    "Fashion": { bg: "#FCE7F3", color: "#9D174D" },
    "Grocery": { bg: "#D1FAE5", color: "#065F46" },
    "Beauty": { bg: "#EDE9FE", color: "#5B21B6" },
    "Travel": { bg: "#DBEAFE", color: "#1E40AF" },
    "Entertainment": { bg: "#FEE2E2", color: "#991B1B" },
    "Retail": { bg: "#E0F2FE", color: "#0369A1" },
    "Other": { bg: T.borderLight, color: T.textSub },
  };
  const catStyle = categoryColors[offer.category] || categoryColors["Other"];

  return (
    <div style={{
      background: expired ? "#FAFAFA" : T.surface,
      border: `1px solid ${expired ? T.borderLight : T.border}`,
      borderRadius: T.radius,
      padding: "16px",
      boxShadow: expired ? "none" : T.shadow,
      opacity: expired ? 0.6 : 1,
      transition: "box-shadow 0.15s",
      position: "relative",
    }}>
      {/* Top row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div style={{ flex: 1, display: "flex", gap: 10, alignItems: "flex-start" }}>
          <BrandLogo brand={offer.brand} domain={offer.domain} />
          <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, fontSize: 15, color: T.text }}>{offer.brand}</span>
            <Badge text={offer.category} color={catStyle.color} bg={catStyle.bg} />
            <Badge text={offer.source} color={T.textSub} bg={T.borderLight} />
          </div>
          <div style={{ fontSize: 13, color: T.textSub }}>{offer.offerTitle}</div>
          </div>
        </div>
        <button
          onClick={() => onDelete(offer._id)}
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: T.textMuted, fontSize: 16, padding: "2px 6px",
            borderRadius: T.radiusSm, lineHeight: 1,
          }}
          title="Remove offer"
        >×</button>
      </div>

      {/* Discount highlight */}
      <div style={{
        background: expired ? T.borderLight : T.accentLight,
        borderRadius: T.radiusSm,
        padding: "8px 12px",
        marginBottom: 10,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        <span style={{ fontWeight: 700, fontSize: 17, color: expired ? T.textMuted : T.accent }}>
          {offer.discount}
        </span>
        {expiry && (
          <span style={{ fontSize: 12, fontWeight: 600, color: expiry.color }}>
            {expiry.text}
          </span>
        )}
        {!offer.expiryDate && (
          <span style={{ fontSize: 12, color: T.textMuted }}>No expiry listed</span>
        )}
      </div>

      {/* Code + conditions */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {offer.code && (
          <button
            onClick={() => {
              navigator.clipboard?.writeText(offer.code);
              onCopy(offer._id);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            style={{
              background: copied ? T.accentLight : T.surface,
              border: `1.5px dashed ${T.accent}`,
              borderRadius: T.radiusSm,
              padding: "4px 10px",
              fontSize: 13,
              fontWeight: 700,
              color: T.accent,
              cursor: "pointer",
              fontFamily: "monospace",
              letterSpacing: "0.05em",
              transition: "background 0.15s",
            }}
          >
            {copied ? "✓ Copied!" : `${offer.code} · tap to copy`}
          </button>
        )}
        <span style={{ fontSize: 12, color: T.textMuted, flex: 1 }}>{offer.conditions}</span>
        {onMarkUsed && (
          <button
            onClick={() => onMarkUsed(offer._id)}
            style={{
              background: "none", border: `1px solid ${T.border}`,
              borderRadius: T.radiusSm, padding: "3px 10px",
              fontSize: 11, color: T.textSub, cursor: "pointer",
              flexShrink: 0,
            }}
          >✓ Used</button>
        )}
      </div>
    </div>
  );
}

// ─── Compact offer row (inside brand groups) ─────────────────────
function CompactOfferRow({ offer, onDelete, onMarkUsed }) {
  const [copied, setCopied] = useState(false);
  const expiry = expiryLabel(offer.expiryDate);
  const expired = offer.expiryDate && daysUntilExpiry(offer.expiryDate) < 0;

  return (
    <div style={{ padding: "12px 16px", borderTop: `1px solid ${T.borderLight}`, opacity: expired ? 0.6 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
        <span style={{ fontSize: 13, color: T.textSub }}>{offer.offerTitle}</span>
        <button
          onClick={() => onDelete(offer._id)}
          style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 14, padding: "0 4px" }}
        >×</button>
      </div>
      <div style={{
        background: expired ? T.borderLight : T.accentLight,
        borderRadius: T.radiusSm, padding: "6px 10px",
        display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8,
      }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: expired ? T.textMuted : T.accent }}>{offer.discount}</span>
        {expiry && <span style={{ fontSize: 11, fontWeight: 600, color: expiry.color }}>{expiry.text}</span>}
        {!offer.expiryDate && <span style={{ fontSize: 11, color: T.textMuted }}>No expiry listed</span>}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {offer.code && (
          <button
            onClick={() => { navigator.clipboard?.writeText(offer.code); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
            style={{
              background: copied ? T.accentLight : T.surface,
              border: `1.5px dashed ${T.accent}`, borderRadius: T.radiusSm,
              padding: "3px 8px", fontSize: 12, fontWeight: 700, color: T.accent,
              cursor: "pointer", fontFamily: "monospace",
            }}
          >{copied ? "✓ Copied!" : `${offer.code} · tap to copy`}</button>
        )}
        <span style={{ fontSize: 11, color: T.textMuted, flex: 1 }}>{offer.conditions}</span>
        <button
          onClick={() => onMarkUsed(offer._id)}
          style={{
            background: "none", border: `1px solid ${T.border}`,
            borderRadius: T.radiusSm, padding: "3px 10px",
            fontSize: 11, color: T.textSub, cursor: "pointer", flexShrink: 0,
          }}
        >✓ Used</button>
      </div>
    </div>
  );
}

// ─── Brand group (multiple offers from same store) ────────────────
function BrandGroup({ brand, offers, onDelete, onMarkUsed }) {
  const [expanded, setExpanded] = useState(true);
  const urgentCount = offers.filter((o) => {
    const d = daysUntilExpiry(o.expiryDate);
    return d !== null && d >= 0 && d <= 7;
  }).length;

  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: T.radius, overflow: "hidden", boxShadow: T.shadow }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "14px 16px", background: T.surface,
          cursor: "pointer", userSelect: "none",
        }}
      >
        <BrandLogo brand={brand} domain={offers[0].domain} />
        <div style={{ flex: 1 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: T.text }}>{brand}</span>
          <span style={{ fontSize: 12, color: T.textSub, marginLeft: 8 }}>
            {offers.length} offers
          </span>
          {urgentCount > 0 && (
            <span style={{ fontSize: 11, fontWeight: 600, color: T.warn, marginLeft: 8 }}>
              ⏰ {urgentCount} expiring soon
            </span>
          )}
        </div>
        <span style={{ color: T.textMuted, fontSize: 11 }}>{expanded ? "▲" : "▼"}</span>
      </div>
      {expanded && offers.map((offer) => (
        <CompactOfferRow key={offer._id} offer={offer} onDelete={onDelete} onMarkUsed={onMarkUsed} />
      ))}
    </div>
  );
}

function PrivacyBanner() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div style={{
      background: T.accentLight,
      border: `1px solid #B7DFC8`,
      borderRadius: T.radius,
      padding: "12px 16px",
      display: "flex",
      gap: 10,
      alignItems: "flex-start",
      marginBottom: 20,
    }}>
      <span style={{ fontSize: 18 }}>🔒</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: T.accent, marginBottom: 2 }}>Your data stays with you</div>
        <div style={{ fontSize: 12, color: T.textSub, lineHeight: 1.5 }}>
          Text you paste is sent to Claude only for extraction — never stored on any server. Everything lives in your browser session. Closing this tab clears all data.
        </div>
      </div>
      <button
        onClick={() => setDismissed(true)}
        style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 16 }}
      >×</button>
    </div>
  );
}

// ─── Login screen ────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [err, setErr] = useState("");
  return (
    <div style={{
      minHeight: "100vh", background: T.bg,
      fontFamily: "'Inter', system-ui, sans-serif",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        background: T.surface, border: `1px solid ${T.border}`,
        borderRadius: 16, padding: "48px 40px", maxWidth: 380, width: "100%",
        boxShadow: T.shadowMd, textAlign: "center",
      }}>
        <div style={{ fontWeight: 800, fontSize: 28, color: T.text, letterSpacing: "-0.03em", marginBottom: 6 }}>
          <span style={{ color: T.accent }}>✦</span> OfferVault
        </div>
        <div style={{ fontSize: 14, color: T.textSub, marginBottom: 36 }}>
          Your offers. Your control.
        </div>

        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 13, color: T.textSub, marginBottom: 20, lineHeight: 1.6 }}>
            Sign in to save and manage your coupons, get nearby store alerts, and never miss a deal.
          </div>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <GoogleLogin
              onSuccess={(cr) => {
                try {
                  const p = decodeJwt(cr.credential);
                  onLogin({ name: p.name, email: p.email, picture: p.picture });
                } catch {
                  setErr("Sign-in failed — could not read profile.");
                }
              }}
              onError={() => setErr("Google sign-in failed. Please try again.")}
              theme="outline"
              size="large"
              shape="rectangular"
              text="signin_with_google"
            />
          </div>
          {err && <div style={{ fontSize: 12, color: T.warn, marginTop: 12 }}>{err}</div>}
        </div>

        <div style={{
          borderTop: `1px solid ${T.borderLight}`, paddingTop: 20,
          fontSize: 12, color: T.textMuted, lineHeight: 1.6,
        }}>
          🔒 Your coupons are stored only in this browser session. Nothing is shared or sold.
        </div>
      </div>
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────
export default function CouponVault() {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem("ov_user")); } catch { return null; }
  });
  const [offers, setOffers] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState(null);
  const [activeTab, setActiveTab] = useState("vault"); // vault | add
  const [addMode, setAddMode] = useState("paste"); // paste | receipt
  const [pasteText, setPasteText] = useState("");
  const [receiptQueue, setReceiptQueue] = useState([]); // [{id,name,status,count,error}]
  const [archivedOffers, setArchivedOffers] = useState([]);
  const [showArchive, setShowArchive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [filterCat, setFilterCat] = useState("All");
  const [dragOver, setDragOver] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [locationAlerts, setLocationAlerts] = useState(false);
  const [nearbyAlerts, setNearbyAlerts] = useState([]);
  const [locationError, setLocationError] = useState("");
  const fileRef = useRef();
  const videoRef = useRef();
  const streamRef = useRef();
  const searchTimer = useRef();
  const watchIdRef = useRef(null);
  const pendingFilesRef = useRef([]);
  const processingReceiptRef = useRef(false);
  const lastCheckPosRef = useRef(null);
  const lastOverpassRef = useRef(0);
  const overpassMirrorIdx = useRef(0);
  const notifiedRef = useRef(new Map());
  const offersRef = useRef([]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  // Keep offersRef current so geolocation callbacks always see latest offers
  useEffect(() => { offersRef.current = offers; }, [offers]);

  // Expiry notifications — fire OS alert when switching to the tab and an offer is due within 3 days
  useEffect(() => {
    const checkExpiry = () => {
      if (Notification.permission !== "granted" || !offers.length) return;
      offers.forEach((offer) => {
        const d = daysUntilExpiry(offer.expiryDate);
        if (d === null || d < 0 || d > 3) return;
        const key = `expiry-${offer._id}`;
        const last = notifiedRef.current.get(key) || 0;
        if (Date.now() - last < 20 * 60 * 60 * 1000) return; // once per ~20h per offer
        notifiedRef.current.set(key, Date.now());
        try {
          new Notification(
            `⏰ ${offer.brand} offer expires ${d === 0 ? "today" : `in ${d} day${d > 1 ? "s" : ""}`}!`,
            {
              body: `${offer.discount}${offer.code ? ` · Code: ${offer.code}` : ""}`,
              icon: `https://www.google.com/s2/favicons?domain=${offer.domain || guessDomain(offer.brand)}&sz=64`,
            }
          );
        } catch (e) { console.warn("[OfferVault] Expiry notification failed:", e); }
      });
    };
    const onVisibility = () => { if (document.visibilityState === "visible") checkExpiry(); };
    checkExpiry();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [offers]);

  // Stop camera stream when leaving receipt tab
  useEffect(() => {
    if (activeTab !== "add" || addMode !== "receipt") closeCamera();
  }, [activeTab, addMode]);

  // Global paste-to-receipt
  useEffect(() => {
    if (addMode !== "receipt") return;
    const onPaste = (e) => {
      const items = Array.from(e.clipboardData?.items || []);
      const imageItem = items.find((it) => it.type.startsWith("image/"));
      if (imageItem) { e.preventDefault(); addToQueue([imageItem.getAsFile()]); }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [addMode]);

  // Wire camera stream to video element after it mounts
  useEffect(() => {
    if (cameraOpen && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play();
    }
  }, [cameraOpen]);

  const openCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      setCameraOpen(true);
    } catch {
      setError("Camera access was denied. Please allow camera access in your browser settings, or use file upload instead.");
    }
  };

  const closeCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOpen(false);
  };

  const takePhoto = () => {
    const video = videoRef.current;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      addToQueue([new File([blob], "camera-photo.jpg", { type: "image/jpeg" })]);
      closeCamera();
    }, "image/jpeg", 0.92);
  };

  // Smart search with debounce
  useEffect(() => {
    clearTimeout(searchTimer.current);
    if (!searchQuery.trim()) { setSearchResults(null); return; }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      const results = await smartSearch(searchQuery, offers);
      setSearchResults(results);
      setSearching(false);
    }, 600);
    return () => clearTimeout(searchTimer.current);
  }, [searchQuery, offers]);

  const handlePasteExtract = async () => {
    if (!pasteText.trim()) { setError("Paste some email or SMS text first."); return; }
    setLoading(true); setError("");
    try {
      const extracted = await extractWithClaude(pasteText, "text");
      if (!extracted.length) { setError("No offers found in that text. Try pasting more of the email/SMS."); }
      else {
        const withIds = extracted.map((o) => ({ ...o, _id: uid() }));
        setOffers((prev) => [...withIds, ...prev]);
        setPasteText("");
        setActiveTab("vault");
        showToast(`✓ ${withIds.length} offer${withIds.length > 1 ? "s" : ""} saved`);
      }
    } catch (e) {
      setError(e.message || "Something went wrong. Please try again.");
    }
    setLoading(false);
  };

  const processOneReceipt = async (file) => {
    const imageFile = await normalizeToJpeg(file);
    const base64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result.split(",")[1]);
      r.onerror = rej;
      r.readAsDataURL(imageFile);
    });

    const response = await fetch("/api/anthropic/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: `You are a receipt OCR and coupon extraction agent. Look at this receipt image and extract any coupons, rewards, discount codes, or next-purchase offers printed on it.

Return ONLY a JSON array of offer objects with: brand, category (one of: Food & Dining, Fashion, Grocery, Beauty, Travel, Entertainment, Retail, Other), offerTitle, discount, code (or null), expiryDate (YYYY-MM-DD or null), conditions (max 20 words or "No conditions mentioned"), source: "Receipt", urgency ("high"/"medium"/"low"), domain (brand website domain e.g. "target.com" or null).

If nothing found, return []. No markdown, no explanation.`,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: imageFile.type, data: base64 } },
            { type: "text", text: "Extract all offers, coupons, and rewards from this receipt." }
          ]
        }],
      }),
    });

    const data = await response.json();
    console.log("[OfferVault] receipt API response", response.status, JSON.stringify(data).slice(0, 300));
    if (!response.ok) throw new Error(`API error ${response.status}: ${data.error?.message || JSON.stringify(data)}`);

    const raw = data.content?.[0]?.text || "[]";
    try {
      return JSON.parse(raw.replace(/```json|```/g, "").trim());
    } catch {
      throw new Error(`Could not parse response: ${raw.slice(0, 100)}`);
    }
  };

  const drainQueue = async () => {
    if (processingReceiptRef.current) return;
    processingReceiptRef.current = true;
    while (pendingFilesRef.current.length > 0) {
      const item = pendingFilesRef.current.shift();
      setReceiptQueue((prev) => prev.map((q) => q.id === item.id ? { ...q, status: "processing" } : q));
      try {
        const extracted = await processOneReceipt(item.file);
        const withIds = extracted.map((o) => ({ ...o, _id: uid() }));
        if (withIds.length) {
          setOffers((prev) => [...withIds, ...prev]);
          showToast(`✓ ${withIds.length} offer${withIds.length !== 1 ? "s" : ""} saved`);
        }
        setReceiptQueue((prev) => prev.map((q) => q.id === item.id ? { ...q, status: "done", count: withIds.length } : q));
      } catch (e) {
        setReceiptQueue((prev) => prev.map((q) => q.id === item.id ? { ...q, status: "error", error: e.message } : q));
      }
    }
    processingReceiptRef.current = false;
  };

  const addToQueue = (files) => {
    const newItems = Array.from(files)
      .filter((f) => f && (f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name)))
      .map((f) => ({ id: uid(), name: f.name, file: f }));
    if (!newItems.length) return;
    setReceiptQueue((prev) => [...prev, ...newItems.map(({ id, name }) => ({ id, name, status: "pending", count: 0, error: null }))]);
    pendingFilesRef.current = [...pendingFilesRef.current, ...newItems];
    drainQueue();
  };

  const deleteOffer = (id) => {
    setOffers((prev) => prev.filter((o) => o._id !== id));
    showToast("Offer removed");
  };

  const markAsUsed = (id) => {
    const offer = offers.find((o) => o._id === id);
    if (!offer) return;
    setOffers((prev) => prev.filter((o) => o._id !== id));
    setArchivedOffers((prev) => [{ ...offer, usedAt: new Date().toISOString() }, ...prev]);
    showToast(`✓ ${offer.brand} offer marked as used`);
  };

  const handleSignIn = (profile) => {
    setUser(profile);
    localStorage.setItem("ov_user", JSON.stringify(profile));
  };

  const handleSignOut = () => {
    googleLogout();
    setUser(null);
    localStorage.removeItem("ov_user");
    disableLocationAlerts();
  };

  if (!user) return <LoginScreen onLogin={handleSignIn} />;

  const OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://z.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];

  const checkNearbyStores = async (lat, lng) => {
    const current = offersRef.current;
    if (!current.length) return;
    const prev = lastCheckPosRef.current;
    if (prev && metersApart(lat, lng, prev.lat, prev.lng) < 100) return;

    const sinceLastQuery = Date.now() - lastOverpassRef.current;
    if (sinceLastQuery < 30_000) {
      console.log(`[OfferVault] Skipping — last query was ${Math.round(sinceLastQuery / 1000)}s ago (min 30s)`);
      return;
    }

    lastCheckPosRef.current = { lat, lng };
    lastOverpassRef.current = Date.now();
    console.log(`[OfferVault] Checking stores near ${lat.toFixed(5)},${lng.toFixed(5)}`);

    const brands = [...new Set(current.map((o) => o.brand))];
    const normBrand = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const matchesOffer = (name, offer) => {
      const a = normBrand(name), b = normBrand(offer.brand);
      return a.includes(b) || b.includes(a.slice(0, b.length));
    };

    const found = [];
    const notifyFor = (offer, storeName) => {
      found.push({ offer, storeName });
      const key = `places-${storeName}-${offer._id}`;
      const last = notifiedRef.current.get(key) || 0;
      if (Date.now() - last < 60 * 60 * 1000) return;
      notifiedRef.current.set(key, Date.now());
      try {
        new Notification(`📍 ${offer.brand} is nearby!`, {
          body: `${offer.discount}${offer.code ? ` · Code: ${offer.code}` : ""} — use it before you leave!`,
          icon: `https://www.google.com/s2/favicons?domain=${offer.domain || guessDomain(offer.brand)}&sz=64`,
        });
        console.log(`[OfferVault] Notification sent for ${offer.brand} @ ${storeName}`);
      } catch (ne) { console.warn("[OfferVault] OS notification failed:", ne); }
    };

    // ── Google Places (primary) ──────────────────────────────────
    let usedPlaces = false;
    for (const brand of brands) {
      try {
        const res = await fetch(`/api/places/nearbysearch/json?location=${lat},${lng}&radius=${NEARBY_RADIUS_M}&keyword=${encodeURIComponent(brand)}`);
        const data = await res.json();
        console.log(`[OfferVault] Places "${brand}":`, data.status, data.results?.length ?? 0, data.results?.map((r) => r.name));
        if (data.status === "REQUEST_DENIED") break; // no key — fall through to Overpass
        usedPlaces = true;
        if (data.status === "OK") {
          for (const place of data.results) {
            const matchedOffers = current.filter((o) => o.brand === brand && matchesOffer(place.name, o));
            matchedOffers.forEach((o) => notifyFor(o, place.name));
          }
        }
      } catch (e) { console.warn("[OfferVault] Places error:", e.message); }
    }

    // ── Overpass fallback ────────────────────────────────────────
    if (!usedPlaces) {
      const toRegex = (b) =>
        b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[^a-zA-Z0-9\\]/g, ".?");
      const conditions = brands.flatMap((b) => [
        `nwr["name"~"${toRegex(b)}",i](around:${NEARBY_RADIUS_M},${lat},${lng});`,
        `nwr["brand"~"${toRegex(b)}",i](around:${NEARBY_RADIUS_M},${lat},${lng});`,
      ]).join("\n");
      const query = `[out:json][timeout:15];\n(\n${conditions}\n);\nout center tags;`;
      console.log("[OfferVault] Overpass query:", query);

      let osmData = null;
      for (let attempt = 0; attempt < OVERPASS_MIRRORS.length; attempt++) {
        const url = OVERPASS_MIRRORS[(overpassMirrorIdx.current + attempt) % OVERPASS_MIRRORS.length];
        try {
          const res = await fetch(url, { method: "POST", body: query });
          if (res.status === 429) { console.warn(`[OfferVault] ${url} rate-limited`); continue; }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          osmData = await res.json();
          overpassMirrorIdx.current = (overpassMirrorIdx.current + attempt) % OVERPASS_MIRRORS.length;
          break;
        } catch (e) { console.warn(`[OfferVault] Overpass mirror failed:`, e.message); }
      }

      if (!osmData) {
        setLocationError("All map servers are busy — will retry on next position update.");
      } else {
        console.log(`[OfferVault] Overpass: ${osmData.elements?.length ?? 0} results`, osmData.elements?.map((e) => e.tags?.name));
        for (const el of osmData.elements || []) {
          const name = el.tags?.name || el.tags?.brand || "";
          current.filter((o) => matchesOffer(name, o)).forEach((o) => notifyFor(o, name));
        }
      }
    }

    setNearbyAlerts(found);
    setLocationError("");
  };

  const enableLocationAlerts = async () => {
    if (!("Notification" in window) || !("geolocation" in navigator)) {
      setError("Your browser doesn't support location alerts.");
      return;
    }
    const perm = await Notification.requestPermission();
    console.log("[OfferVault] Notification permission:", perm);
    if (perm !== "granted") {
      setError("Please allow notifications in your browser to use location alerts.");
      return;
    }
    // Test notification — if this doesn't appear, macOS is blocking the browser in
    // System Settings → Notifications. The in-app banner will still work.
    try {
      new Notification("OfferVault alerts enabled", {
        body: "You'll see a banner in the app and an OS notification when near a store.",
      });
    } catch (e) {
      console.warn("[OfferVault] Test notification failed — OS may be blocking:", e);
    }
    lastCheckPosRef.current = null; // always run a fresh check on enable
    setLocationAlerts(true);
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        console.log(`[OfferVault] Position: ${pos.coords.latitude.toFixed(5)},${pos.coords.longitude.toFixed(5)} ±${Math.round(pos.coords.accuracy)}m`);
        checkNearbyStores(pos.coords.latitude, pos.coords.longitude);
      },
      (err) => {
        console.warn("[OfferVault] Geolocation error:", err.code, err.message);
        setLocationError(
          err.code === 1
            ? "Location access denied — coordinates may be inaccurate. On Mac: System Settings → Privacy & Security → Location Services → enable your browser, then turn alerts off and on again."
            : `Location error: ${err.message}`
        );
      },
      { enableHighAccuracy: false, maximumAge: 30000 }
    );
  };

  const disableLocationAlerts = () => {
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    watchIdRef.current = null;
    lastCheckPosRef.current = null;
    setNearbyAlerts([]);
    setLocationAlerts(false);
    setLocationError("");
  };

  // Display logic
  let displayOffers = searchResults !== null ? searchResults : offers;
  if (filterCat !== "All") displayOffers = displayOffers.filter((o) => o.category === filterCat);
  const expiringSoon = offers.filter((o) => {
    const d = daysUntilExpiry(o.expiryDate);
    return d !== null && d >= 0 && d <= 7;
  });

  return (
    <div style={{ minHeight: "100vh", background: T.bg, fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Toast */}
      {toast && (
        <div style={{
          position: "fixed", top: 20, left: "50%", transform: "translateX(-50%)",
          background: T.text, color: "#fff", padding: "10px 20px",
          borderRadius: "20px", fontSize: 13, fontWeight: 500,
          zIndex: 9999, boxShadow: T.shadowMd,
        }}>{toast}</div>
      )}

      {/* Header */}
      <div style={{
        background: T.surface,
        borderBottom: `1px solid ${T.border}`,
        padding: "16px 20px",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ maxWidth: 680, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 18, color: T.text, letterSpacing: "-0.02em" }}>
              <span style={{ color: T.accent }}>✦</span> OfferVault
            </div>
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 1 }}>Your offers. Your control.</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ display: "flex", gap: 6 }}>
            {["vault", "add"].map((tab) => (
              <button
                key={tab}
                onClick={() => { setActiveTab(tab); setError(""); }}
                style={{
                  padding: "7px 16px",
                  borderRadius: "20px",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                  background: activeTab === tab ? T.accent : T.borderLight,
                  color: activeTab === tab ? "#fff" : T.textSub,
                  transition: "all 0.15s",
                }}
              >{tab === "vault" ? `My Offers (${offers.length})` : "+ Add Offers"}</button>
            ))}
            </div>
            {/* User avatar + sign out */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {user.picture
                ? <img src={user.picture} alt={user.name} style={{ width: 30, height: 30, borderRadius: "50%", border: `2px solid ${T.border}` }} />
                : <div style={{ width: 30, height: 30, borderRadius: "50%", background: T.accent, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700, fontSize: 13 }}>{user.name?.[0]}</div>
              }
              <button
                onClick={handleSignOut}
                style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 6, padding: "4px 10px", fontSize: 12, color: T.textSub, cursor: "pointer" }}
              >Sign out</button>
            </div>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 680, margin: "0 auto", padding: "24px 16px" }}>
        <PrivacyBanner />

        {/* Nearby store banner — in-app fallback that works even if OS notifications are blocked */}
        {nearbyAlerts.length > 0 && activeTab === "vault" && (
          <div style={{
            background: "#EFF6FF", border: "1px solid #BFDBFE",
            borderRadius: T.radius, padding: "12px 16px", marginBottom: 16,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 16 }}>📍</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#1E40AF" }}>
                You're near {nearbyAlerts.length === 1 ? "a store" : `${nearbyAlerts.length} stores`} with saved coupons!
              </span>
            </div>
            {nearbyAlerts.map(({ offer, storeName }, i) => (
              <div key={i} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                background: "#fff", borderRadius: T.radiusSm, padding: "8px 12px",
                marginTop: 6, border: "1px solid #BFDBFE",
              }}>
                <div>
                  <span style={{ fontWeight: 600, fontSize: 13, color: T.text }}>{storeName}</span>
                  <span style={{ fontSize: 12, color: T.textSub, marginLeft: 8 }}>{offer.discount}</span>
                </div>
                {offer.code && (
                  <span style={{
                    fontFamily: "monospace", fontSize: 12, fontWeight: 700,
                    color: T.accent, background: T.accentLight,
                    padding: "2px 8px", borderRadius: 4,
                  }}>{offer.code}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Expiring soon alert */}
        {expiringSoon.length > 0 && activeTab === "vault" && (
          <div style={{
            background: T.warnLight,
            border: `1px solid #FECACA`,
            borderRadius: T.radius,
            padding: "12px 16px",
            marginBottom: 16,
            display: "flex", gap: 10, alignItems: "center",
          }}>
            <span style={{ fontSize: 16 }}>⏰</span>
            <span style={{ fontSize: 13, color: T.warn, fontWeight: 500 }}>
              {expiringSoon.length} offer{expiringSoon.length > 1 ? "s" : ""} expiring within 7 days — use them before they're gone
            </span>
          </div>
        )}

        {/* ── VAULT TAB ── */}
        {activeTab === "vault" && (
          <>
            {/* Location alerts toggle */}
            {offers.length > 0 && (
              <div style={{
                background: locationAlerts ? T.accentLight : T.surface,
                border: `1px solid ${locationAlerts ? "#B7DFC8" : T.border}`,
                borderRadius: T.radius, padding: "10px 14px", marginBottom: 14,
              }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16 }}>{locationAlerts ? "📍" : "🔔"}</span>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: locationAlerts ? T.accent : T.text }}>
                        {locationAlerts ? "Location alerts on" : "Nearby store alerts"}
                      </div>
                      <div style={{ fontSize: 11, color: T.textMuted }}>
                        {locationAlerts
                          ? `Watching for ${[...new Set(offers.map((o) => o.brand))].length} brands within 3 miles`
                          : "Get notified when you're near a store you have a coupon for"}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    {locationAlerts && (
                      <button
                        onClick={() => {
                          lastCheckPosRef.current = null;
                          navigator.geolocation.getCurrentPosition(
                            (pos) => checkNearbyStores(pos.coords.latitude, pos.coords.longitude),
                            (err) => setLocationError(`Location error: ${err.message}`),
                            { enableHighAccuracy: false }
                          );
                        }}
                        style={{
                          padding: "6px 12px", borderRadius: "20px",
                          border: `1px solid ${T.accent}`, background: "transparent",
                          color: T.accent, fontSize: 12, fontWeight: 600, cursor: "pointer",
                        }}
                      >Check now</button>
                    )}
                    <button
                      onClick={locationAlerts ? disableLocationAlerts : enableLocationAlerts}
                      style={{
                        padding: "6px 14px", borderRadius: "20px", border: "none",
                        background: locationAlerts ? T.warn : T.accent,
                        color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer",
                      }}
                    >{locationAlerts ? "Turn off" : "Turn on"}</button>
                  </div>
                </div>
                {locationError && (
                  <div style={{
                    marginTop: 10, fontSize: 12, color: T.warn,
                    background: T.warnLight, borderRadius: T.radiusSm,
                    padding: "8px 12px", lineHeight: 1.5,
                  }}>
                    ⚠️ {locationError}
                  </div>
                )}
              </div>
            )}

            {/* Search */}
            <div style={{ position: "relative", marginBottom: 16 }}>
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search offers — try 'pizza discount' or 'fashion code expiring soon'…"
                style={{
                  width: "100%", padding: "12px 16px 12px 40px",
                  borderRadius: T.radius, border: `1.5px solid ${searchQuery ? T.accent : T.border}`,
                  fontSize: 14, background: T.surface, color: T.text,
                  outline: "none", boxSizing: "border-box",
                  boxShadow: T.shadow, transition: "border 0.15s",
                }}
              />
              <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontSize: 16, color: T.textMuted }}>
                {searching ? "⟳" : "⌕"}
              </span>
              {searchQuery && (
                <button
                  onClick={() => { setSearchQuery(""); setSearchResults(null); }}
                  style={{
                    position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                    background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 16,
                  }}
                >×</button>
              )}
            </div>

            {/* Category filter pills */}
            {offers.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
                {["All", ...CATEGORIES].map((cat) => {
                  const count = cat === "All" ? offers.length : offers.filter((o) => o.category === cat).length;
                  if (cat !== "All" && count === 0) return null;
                  return (
                    <button
                      key={cat}
                      onClick={() => setFilterCat(cat)}
                      style={{
                        padding: "5px 12px", borderRadius: "20px",
                        border: `1px solid ${filterCat === cat ? T.accent : T.border}`,
                        background: filterCat === cat ? T.accent : T.surface,
                        color: filterCat === cat ? "#fff" : T.textSub,
                        fontSize: 12, fontWeight: 500, cursor: "pointer",
                      }}
                    >{cat} {count > 0 && <span style={{ opacity: 0.7 }}>({count})</span>}</button>
                  );
                })}
              </div>
            )}

            {/* Offers list — grouped by brand */}
            {displayOffers.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {searchResults !== null && (
                  <div style={{ fontSize: 12, color: T.textSub, marginBottom: 4 }}>
                    Showing {searchResults.length} result{searchResults.length !== 1 ? "s" : ""} for "{searchQuery}"
                  </div>
                )}
                {Object.entries(
                  displayOffers.reduce((acc, o) => { (acc[o.brand] = acc[o.brand] || []).push(o); return acc; }, {})
                ).map(([brand, brandOffers]) =>
                  brandOffers.length === 1 ? (
                    <CouponCard key={brandOffers[0]._id} offer={brandOffers[0]} onDelete={deleteOffer} onCopy={() => {}} onMarkUsed={markAsUsed} />
                  ) : (
                    <BrandGroup key={brand} brand={brand} offers={brandOffers} onDelete={deleteOffer} onMarkUsed={markAsUsed} />
                  )
                )}
              </div>
            ) : offers.length === 0 ? (
              <div style={{
                textAlign: "center", padding: "60px 20px",
                border: `1.5px dashed ${T.border}`, borderRadius: T.radius,
                background: T.surface,
              }}>
                <div style={{ fontSize: 36, marginBottom: 12 }}>🏷️</div>
                <div style={{ fontWeight: 600, color: T.text, marginBottom: 6 }}>No offers saved yet</div>
                <div style={{ fontSize: 13, color: T.textSub, marginBottom: 20 }}>
                  Paste an email, SMS, or upload a receipt to extract your offers
                </div>
                <button
                  onClick={() => setActiveTab("add")}
                  style={{
                    background: T.accent, color: "#fff", border: "none",
                    borderRadius: T.radius, padding: "10px 24px",
                    fontSize: 14, fontWeight: 600, cursor: "pointer",
                  }}
                >Add your first offer →</button>
              </div>
            ) : (
              <div style={{ textAlign: "center", padding: 40, color: T.textMuted, fontSize: 13 }}>
                No offers match your search
              </div>
            )}

            {/* ── Archive ── */}
            {archivedOffers.length > 0 && (
              <div style={{ marginTop: 28 }}>
                <button
                  onClick={() => setShowArchive(!showArchive)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    width: "100%", background: "none", border: "none",
                    cursor: "pointer", padding: "8px 0", borderTop: `1px solid ${T.borderLight}`,
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: 600, color: T.textSub }}>
                    🗂 Used Offers ({archivedOffers.length})
                  </span>
                  <span style={{ fontSize: 11, color: T.textMuted, marginLeft: "auto" }}>
                    {showArchive ? "▲ hide" : "▼ show"}
                  </span>
                </button>
                {showArchive && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                    {archivedOffers.map((offer) => (
                      <div key={offer._id} style={{
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "10px 14px", background: T.surface,
                        border: `1px solid ${T.borderLight}`, borderRadius: T.radiusSm,
                        opacity: 0.65,
                      }}>
                        <BrandLogo brand={offer.brand} domain={offer.domain} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{offer.brand}</div>
                          <div style={{ fontSize: 12, color: T.textSub }}>{offer.discount}</div>
                        </div>
                        <div style={{ fontSize: 11, color: T.textMuted, textAlign: "right", flexShrink: 0 }}>
                          Used<br />{formatDate(offer.usedAt)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* ── ADD TAB ── */}
        {activeTab === "add" && (
          <div>
            {/* Mode toggle */}
            <div style={{
              display: "flex", gap: 0, marginBottom: 20,
              border: `1px solid ${T.border}`, borderRadius: T.radius,
              overflow: "hidden", background: T.surface,
            }}>
              {[["paste", "📋 Paste Email or SMS"], ["receipt", "📸 Upload Receipt Photo"]].map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => { setAddMode(mode); setError(""); }}
                  style={{
                    flex: 1, padding: "12px 8px", border: "none",
                    cursor: "pointer", fontSize: 13, fontWeight: 600,
                    background: addMode === mode ? T.accent : T.surface,
                    color: addMode === mode ? "#fff" : T.textSub,
                    transition: "all 0.15s",
                  }}
                >{label}</button>
              ))}
            </div>

            {error && (
              <div style={{
                background: T.warnLight, border: `1px solid #FECACA`,
                borderRadius: T.radiusSm, padding: "10px 14px",
                fontSize: 13, color: T.warn, marginBottom: 16,
              }}>{error}</div>
            )}

            {/* Paste mode */}
            {addMode === "paste" && (
              <div>
                <div style={{ fontSize: 13, color: T.textSub, marginBottom: 8 }}>
                  Copy the full text of a promotional email or SMS and paste it below. Claude will extract all offers automatically.
                </div>
                <textarea
                  value={pasteText}
                  onChange={(e) => { setPasteText(e.target.value); setError(""); }}
                  placeholder={"Paste your email or SMS text here…\n\nExample:\n\"Hi! As a valued customer, enjoy 25% off your next purchase with code THANKS25. Valid through December 31. Shop now at zara.com\""}
                  style={{
                    width: "100%", minHeight: 200, padding: "14px",
                    borderRadius: T.radius, border: `1.5px solid ${pasteText ? T.accent : T.border}`,
                    fontSize: 13, color: T.text, background: T.surface,
                    resize: "vertical", outline: "none", lineHeight: 1.6,
                    fontFamily: "inherit", boxSizing: "border-box",
                    transition: "border 0.15s",
                  }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
                  <div style={{ fontSize: 12, color: T.textMuted }}>
                    🔒 Text is sent to Claude for extraction only — not stored anywhere
                  </div>
                  <button
                    onClick={handlePasteExtract}
                    disabled={loading || !pasteText.trim()}
                    style={{
                      background: loading || !pasteText.trim() ? T.borderLight : T.accent,
                      color: loading || !pasteText.trim() ? T.textMuted : "#fff",
                      border: "none", borderRadius: T.radius,
                      padding: "10px 24px", fontSize: 14, fontWeight: 600,
                      cursor: loading || !pasteText.trim() ? "not-allowed" : "pointer",
                      transition: "all 0.15s",
                    }}
                  >
                    {loading ? "Extracting…" : "Extract Offers →"}
                  </button>
                </div>
              </div>
            )}

            {/* Receipt mode */}
            {addMode === "receipt" && (
              <div>
                <div style={{ fontSize: 13, color: T.textSub, marginBottom: 12 }}>
                  Upload receipt photos and offers are extracted automatically. Select multiple at once or drop a batch.
                </div>

                {cameraOpen ? (
                  <div style={{ borderRadius: T.radius, overflow: "hidden", background: "#000", position: "relative" }}>
                    <video ref={videoRef} autoPlay playsInline muted
                      style={{ width: "100%", maxHeight: 340, display: "block", objectFit: "cover" }} />
                    <div style={{ display: "flex", gap: 8, padding: 12, background: "rgba(0,0,0,0.6)" }}>
                      <button
                        onClick={closeCamera}
                        style={{
                          flex: 1, padding: "10px", borderRadius: T.radius,
                          border: "none", background: "rgba(255,255,255,0.15)",
                          color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer",
                        }}
                      >Cancel</button>
                      <button
                        onClick={takePhoto}
                        style={{
                          flex: 2, padding: "10px", borderRadius: T.radius,
                          border: "none", background: T.accent,
                          color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer",
                        }}
                      >📸 Take photo</button>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Drop zone — always visible */}
                    <div
                      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                      onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={(e) => {
                        e.preventDefault(); setDragOver(false);
                        addToQueue(Array.from(e.dataTransfer.files));
                      }}
                      style={{
                        border: `2px dashed ${dragOver ? T.accent : T.border}`,
                        borderRadius: T.radius,
                        padding: receiptQueue.length > 0 ? "18px 20px" : "32px 20px",
                        textAlign: "center",
                        background: dragOver ? T.accentLight : T.surface,
                        transition: "all 0.15s",
                      }}
                    >
                      <div style={{ fontSize: receiptQueue.length > 0 ? 24 : 32, marginBottom: 6 }}>
                        {dragOver ? "⬇️" : "📸"}
                      </div>
                      <div style={{ fontWeight: 600, color: T.text, marginBottom: 4, fontSize: receiptQueue.length > 0 ? 13 : 14 }}>
                        {dragOver ? "Drop to scan" : receiptQueue.length > 0 ? "Drop more receipts" : "Drop receipt photos here"}
                      </div>
                      {receiptQueue.length === 0 && (
                        <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 16 }}>
                          HEIC, JPG, PNG, WebP — multiple files supported
                        </div>
                      )}
                      <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", marginTop: receiptQueue.length > 0 ? 8 : 0 }}>
                        <button
                          onClick={() => fileRef.current?.click()}
                          style={{
                            padding: "8px 16px", borderRadius: T.radius,
                            border: `1.5px solid ${T.border}`, background: T.surface,
                            color: T.text, fontSize: 13, fontWeight: 600, cursor: "pointer",
                          }}
                        >📁 {receiptQueue.length > 0 ? "Add more" : "Browse files"}</button>
                        <button
                          onClick={openCamera}
                          style={{
                            padding: "8px 16px", borderRadius: T.radius,
                            border: `1.5px solid ${T.accent}`, background: T.accentLight,
                            color: T.accent, fontSize: 13, fontWeight: 600, cursor: "pointer",
                          }}
                        >📷 Camera</button>
                      </div>
                      {receiptQueue.length === 0 && (
                        <div style={{ fontSize: 12, color: T.textMuted, marginTop: 12 }}>
                          or paste with{" "}
                          <kbd style={{ background: T.borderLight, border: `1px solid ${T.border}`, borderRadius: 4, padding: "1px 5px", fontSize: 11, fontFamily: "monospace" }}>⌘V</kbd>
                          {" / "}
                          <kbd style={{ background: T.borderLight, border: `1px solid ${T.border}`, borderRadius: 4, padding: "1px 5px", fontSize: 11, fontFamily: "monospace" }}>Ctrl+V</kbd>
                        </div>
                      )}
                    </div>

                    {/* Processing queue */}
                    {receiptQueue.length > 0 && (
                      <div style={{ marginTop: 12 }}>
                        {receiptQueue.map((item) => (
                          <div key={item.id} style={{
                            display: "flex", alignItems: "center", gap: 10,
                            padding: "10px 14px",
                            background: T.surface,
                            border: `1px solid ${T.border}`,
                            borderRadius: T.radiusSm,
                            marginBottom: 6,
                          }}>
                            <span style={{ fontSize: 16, flexShrink: 0 }}>
                              {item.status === "done" && item.count > 0 ? "✅" :
                               item.status === "done" ? "⬜" :
                               item.status === "error" ? "❌" :
                               item.status === "processing" ? "⏳" : "🕐"}
                            </span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 500, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {item.name}
                              </div>
                              <div style={{ fontSize: 12, color:
                                item.status === "error" ? T.warn :
                                item.status === "done" && item.count > 0 ? T.accent :
                                T.textMuted
                              }}>
                                {item.status === "pending" ? "Queued" :
                                 item.status === "processing" ? "Extracting offers…" :
                                 item.status === "done" ? (item.count > 0 ? `${item.count} offer${item.count > 1 ? "s" : ""} found` : "No offers found") :
                                 item.error || "Failed"}
                              </div>
                            </div>
                          </div>
                        ))}
                        {receiptQueue.every((q) => q.status === "done" || q.status === "error") && (
                          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                            <button
                              onClick={() => { setReceiptQueue([]); setActiveTab("vault"); }}
                              style={{
                                flex: 1, padding: "10px", background: T.accent,
                                color: "#fff", border: "none", borderRadius: T.radius,
                                fontSize: 13, fontWeight: 600, cursor: "pointer",
                              }}
                            >View in vault →</button>
                            <button
                              onClick={() => setReceiptQueue([])}
                              style={{
                                padding: "10px 16px", background: T.surface,
                                color: T.textSub, border: `1px solid ${T.border}`,
                                borderRadius: T.radius, fontSize: 13, cursor: "pointer",
                              }}
                            >Clear</button>
                          </div>
                        )}
                      </div>
                    )}

                    <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }}
                      onChange={(e) => { addToQueue(Array.from(e.target.files)); e.target.value = ""; }} />
                  </>
                )}

                <div style={{ fontSize: 12, color: T.textMuted, marginTop: 10 }}>
                  🔒 Images are sent to Claude for extraction only — not stored anywhere
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

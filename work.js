// ============================================
// MP-TG-SubscribeBoard (Photo Dashboard Edition)
// - Dashboard is a SINGLE Telegram message forever
// - Prefer a PHOTO message so "代表图" is shown as image (no URL displayed)
// - Durable Object serializes updates (Cloudflare Free plan: SQLite-backed DO)
// - HTML parse_mode with safe escaping
// - Caption length guard (1024) + Telegram "too long" retry with shorter template
// - If existing dashboard is TEXT, can do a ONE-TIME upgrade to PHOTO (configurable)
// ============================================

const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const TV_LINE_PREFIX_RE = /^📺[\uFE0E\uFE0F]?/; // 📺︎ / 📺️ / 📺

// Telegram limits
const TG_TEXT_LIMIT = 4096;
const TG_CAPTION_LIMIT = 1024;

// Safety margins for retry
const CAPTION_SAFE_BUDGET = 900;
const CAPTION_AGGRESSIVE_BUDGET = 700;
const CAPTION_MIN_BUDGET = 420;

let _collatorZh = null;
let _collatorDefault = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");

    if (!token || token !== env.WEBHOOK_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (request.method === "GET") {
      return new Response("Worker OK", { status: 200 });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const payload = await request.json();
      const { text: rawText, image } = extractTextAndImage(payload);

      if (!isSubscribeReminder(rawText)) {
        return jsonResponse({ success: true, result: "Skipped: Not SubscribeReminder" });
      }

      const items = normalizeSubscribeContent(rawText);
      if (items.length === 0) {
        return jsonResponse({ success: true, result: "Skipped: No valid episode lines" });
      }

      if (!env.SUBSCRIBE_BOARD) throw new Error("Missing Durable Object binding: SUBSCRIBE_BOARD");
      if (!env.BOT_TOKEN || !env.CHAT_ID) throw new Error("Missing Env Vars: BOT_TOKEN / CHAT_ID");

      const timeZone = env.TIME_ZONE || DEFAULT_TIME_ZONE;
      const dateKey = formatDateKey(new Date(), timeZone);

      const doId = env.SUBSCRIBE_BOARD.idFromName(String(env.CHAT_ID));
      const stub = env.SUBSCRIBE_BOARD.get(doId);

      const doRes = await stub.fetch("https://do/aggregate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateKey, items, image }),
      });

      const result = await safeJson(doRes);
      if (!doRes.ok) return jsonResponse({ success: false, result }, doRes.status);

      return jsonResponse({ success: true, result }, 200);
    } catch (err) {
      console.error(err);
      return jsonResponse({ success: false, error: err?.message || String(err) }, 500);
    }
  },
};

// ============================================
// Durable Object
// ============================================
export class SubscribeBoardDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.queue = Promise.resolve();
  }

  async fetch(request) {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const input = await request.json();
    const task = this.queue.then(() => this.handleAggregate(input));
    this.queue = task.catch(() => {});

    try {
      const result = await task;
      return jsonResponse(result, 200);
    } catch (err) {
      console.error("DO error:", err);
      return jsonResponse({ ok: false, error: err?.message || String(err) }, 500);
    }
  }

  async handleAggregate(input) {
    const BOT_TOKEN = this.env.BOT_TOKEN;
    const CHAT_ID = this.env.CHAT_ID;
    const timeZone = this.env.TIME_ZONE || DEFAULT_TIME_ZONE;

    if (!BOT_TOKEN || !CHAT_ID) throw new Error("Missing Env Vars: BOT_TOKEN / CHAT_ID");

    const strict = (this.env.STRICT_SINGLE_MESSAGE ?? "1") !== "0"; // default ON
    const adoptPinned = (this.env.ADOPT_PINNED ?? "1") !== "0"; // default ON
    const autoPin = (this.env.AUTO_PIN ?? "0") === "1";

    const preferPhoto = (this.env.PREFER_PHOTO_MESSAGE ?? "1") !== "0"; // default ON
    const allowTextToPhotoUpgrade = (this.env.ALLOW_TEXT_TO_PHOTO_UPGRADE ?? "1") !== "0"; // default ON

    const { dateKey, items, image } = input || {};
    if (!dateKey || !Array.isArray(items)) throw new Error("Invalid payload to Durable Object");

    let state = (await this.state.storage.get("state")) || null;

    // init/back-compat
    if (!state || typeof state !== "object") {
      state = {
        messageId: null,
        messageKind: "unknown", // "photo" | "text" | "unknown"
        dateKey: null,
        content: [],
        // photoUrl: currently used photo in the dashboard message (if known / set by us)
        photoUrl: "",
        // dayImage: selected image for current day (used to update media at most once/day)
        dayImage: "",
      };
    } else {
      if (!Array.isArray(state.content)) state.content = [];
      if (!state.messageKind) state.messageKind = "unknown";
      if (typeof state.photoUrl !== "string") state.photoUrl = "";
      if (typeof state.dayImage !== "string") state.dayImage = "";
    }

    let changed = false;

    // Cross-day reset CONTENT only; keep messageId forever.
    // For photo: we keep photoUrl (so message always has an image), but reset dayImage for daily selection.
    if (state.dateKey !== dateKey) {
      state.dateKey = dateKey;
      state.content = [];
      state.dayImage = "";
      changed = true; // ensure first webhook updates dashboard
    }

    // Merge items
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const title = String(it.title || "").trim();
      const year = String(it.year || "").trim();
      const season = String(it.season || "").trim().toUpperCase();
      const episode = String(it.episode || "").trim().toUpperCase();
      if (!title || !year || !season || !episode) continue;

      const key = `${title}|${year}|${season}`;
      const idx = state.content.findIndex((v) => `${v.title}|${v.year}|${v.season}` === key);
      const normalized = { title, year, season, episode };

      if (idx === -1) {
        state.content.push(normalized);
        changed = true;
      } else if (String(episode).length > String(state.content[idx].episode || "").length) {
        state.content[idx] = normalized;
        changed = true;
      }
    }

    safeSortContent(state.content);

    // Daily representative image: pick the first valid http/https we receive today
    const safeIncoming = sanitizeHttpUrl(image);
    if (!state.dayImage && safeIncoming) {
      state.dayImage = safeIncoming;
      changed = true;
    }

    // If nothing changed and we already have a message, skip Telegram call
    if (!changed && state.messageId) {
      return { ok: true, skipped: true, reason: "No update needed", messageId: state.messageId };
    }

    const updatedAt = formatDateTime(new Date(), timeZone);

    // Build caption templates (no URL line; photo itself is the cover)
    const captionFull = buildCaptionHtml({
      dateKey: state.dateKey,
      updatedAt,
      content: state.content,
      budget: CAPTION_SAFE_BUDGET,
    });

    const captionAggressive = buildCaptionHtml({
      dateKey: state.dateKey,
      updatedAt,
      content: state.content,
      budget: CAPTION_AGGRESSIVE_BUDGET,
      aggressive: true,
    });

    const captionMinimal = buildCaptionHtml({
      dateKey: state.dateKey,
      updatedAt,
      content: state.content,
      budget: CAPTION_MIN_BUDGET,
      aggressive: true,
      minimal: true,
    });

    const action = await upsertPhotoDashboard({
      token: BOT_TOKEN,
      chatId: CHAT_ID,
      state,
      preferPhoto,
      allowTextToPhotoUpgrade,
      strict,
      adoptPinned,
      autoPin,
      captionFull,
      captionAggressive,
      captionMinimal,
    });

    await this.state.storage.put("state", state);
    return { ok: true, skipped: false, action, messageId: state.messageId, dateKey: state.dateKey };
  }
}

// ============================================
// Telegram: Always keep ONE message, prefer PHOTO
// ============================================
async function upsertPhotoDashboard({
  token,
  chatId,
  state,
  preferPhoto,
  allowTextToPhotoUpgrade,
  strict,
  adoptPinned,
  autoPin,
  captionFull,
  captionAggressive,
  captionMinimal,
}) {
  const tryAdopt = async () => {
    if (!adoptPinned) return null;
    const pinned = await tryGetPinnedMessage(token, chatId);
    if (!pinned) return null;

    const extracted = extractPinnedTextOrCaption(pinned);
    if (!extracted) return null;
    if (!looksLikeDashboard(extracted.text)) return null;

    return {
      messageId: pinned.message_id,
      messageKind: extracted.kind === "caption" ? "photo" : "text",
    };
  };

  // Adopt if needed
  if (!state.messageId) {
    const adopted = await tryAdopt();
    if (adopted) {
      state.messageId = adopted.messageId;
      state.messageKind = adopted.messageKind;
    }
  }

  // Decide intended mode
  const wantPhoto = preferPhoto;

  // If no message exists: create initial dashboard
  if (!state.messageId) {
    if (wantPhoto) {
      const photo = pickPhotoForSend(state);
      if (!photo) {
        // No photo available yet => fallback to text for first send (still one message).
        // Next time we can upgrade to photo if allowed.
        const msgId = await telegramCall(token, "sendMessage", {
          chat_id: chatId,
          text: stripAllTags(captionFull), // show clean text version
          parse_mode: "HTML",
          disable_notification: true,
        });
        state.messageId = msgId;
        state.messageKind = "text";
        if (autoPin) await bestEffortPin(token, chatId, msgId);
        return { type: "sendMessage", messageId: msgId, note: "no_photo_yet" };
      }

      const msgId = await telegramCall(token, "sendPhoto", {
        chat_id: chatId,
        photo,
        caption: captionFull,
        parse_mode: "HTML",
        disable_notification: true,
      });
      state.messageId = msgId;
      state.messageKind = "photo";
      state.photoUrl = photo;
      if (autoPin) await bestEffortPin(token, chatId, msgId);
      return { type: "sendPhoto", messageId: msgId };
    } else {
      const msgId = await telegramCall(token, "sendMessage", {
        chat_id: chatId,
        text: stripAllTags(captionFull),
        parse_mode: "HTML",
        disable_notification: true,
      });
      state.messageId = msgId;
      state.messageKind = "text";
      if (autoPin) await bestEffortPin(token, chatId, msgId);
      return { type: "sendMessage", messageId: msgId };
    }
  }

  // If we want PHOTO but current is TEXT, we need one-time upgrade (sendPhoto once)
  if (wantPhoto && state.messageKind === "text") {
    if (!allowTextToPhotoUpgrade) {
      if (strict) {
        throw new Error("PREFER_PHOTO_MESSAGE=1 but dashboard is text and ALLOW_TEXT_TO_PHOTO_UPGRADE=0 (strict).");
      }
      // non-strict: keep editing as text
      return await editTextDashboard(token, chatId, state, captionFull, captionAggressive, captionMinimal);
    }

    const photo = pickPhotoForSend(state);
    if (!photo) {
      // no photo available => keep as text for now
      return await editTextDashboard(token, chatId, state, captionFull, captionAggressive, captionMinimal);
    }

    // ONE-TIME upgrade: send a new photo dashboard message, then (optionally) pin it.
    const oldId = state.messageId;
    const newId = await telegramCall(token, "sendPhoto", {
      chat_id: chatId,
      photo,
      caption: captionFull,
      parse_mode: "HTML",
      disable_notification: true,
    });

    state.messageId = newId;
    state.messageKind = "photo";
    state.photoUrl = photo;

    if (autoPin) {
      await bestEffortPin(token, chatId, newId);
      await bestEffortUnpin(token, chatId, oldId);
    }

    return { type: "upgrade_text_to_photo", oldMessageId: oldId, newMessageId: newId, pinned: autoPin };
  }

  // If current is PHOTO: edit caption (and update media once/day if new dayImage exists)
  if (state.messageKind === "photo") {
    return await editPhotoDashboard(token, chatId, state, captionFull, captionAggressive, captionMinimal);
  }

  // Otherwise: edit as text
  return await editTextDashboard(token, chatId, state, captionFull, captionAggressive, captionMinimal);
}

function pickPhotoForSend(state) {
  // Prefer today's chosen image; otherwise keep existing photoUrl (so always has cover)
  const today = sanitizeHttpUrl(state.dayImage);
  if (today) return today;
  const old = sanitizeHttpUrl(state.photoUrl);
  if (old) return old;
  return "";
}

async function editPhotoDashboard(token, chatId, state, full, aggressive, minimal) {
  const desiredPhoto = pickPhotoForSend(state);
  const shouldUpdateMedia = desiredPhoto && desiredPhoto !== state.photoUrl && sanitizeHttpUrl(state.dayImage);

  // Try sequence: full -> aggressive -> minimal (too long / parse errors)
  const attempts = [full, aggressive, minimal];

  for (let i = 0; i < attempts.length; i++) {
    const cap = attempts[i];
    try {
      if (shouldUpdateMedia) {
        await telegramCall(
          token,
          "editMessageMedia",
          {
            chat_id: chatId,
            message_id: state.messageId,
            media: {
              type: "photo",
              media: desiredPhoto,
              caption: cap,
              parse_mode: "HTML",
            },
          },
          { allowNotModified: true }
        );
        state.photoUrl = desiredPhoto;
      } else {
        await telegramCall(
          token,
          "editMessageCaption",
          {
            chat_id: chatId,
            message_id: state.messageId,
            caption: cap,
            parse_mode: "HTML",
          },
          { allowNotModified: true }
        );
      }
      return { type: shouldUpdateMedia ? "editMessageMedia" : "editMessageCaption", messageId: state.messageId, attempt: i + 1 };
    } catch (e) {
      const msg = String(e?.message || e);
      if (i === attempts.length - 1) throw e;

      // If parse error, remove all tags and retry next attempt (still HTML-safe)
      if (isParseEntityError(msg)) {
        attempts[i + 1] = stripAllTags(attempts[i + 1]);
      }
      // If too long, just proceed to a shorter attempt
      continue;
    }
  }
}

async function editTextDashboard(token, chatId, state, full, aggressive, minimal) {
  // For text messages we send plain (no image), but user wants photo, so this is fallback-only.
  const textFull = stripAllTags(full);
  const textAgg = stripAllTags(aggressive);
  const textMin = stripAllTags(minimal);

  const attempts = [textFull, textAgg, textMin];

  for (let i = 0; i < attempts.length; i++) {
    const text = hardTrimToChars(attempts[i], Math.min(TG_TEXT_LIMIT, 3500));
    try {
      await telegramCall(
        token,
        "editMessageText",
        {
          chat_id: chatId,
          message_id: state.messageId,
          text,
          parse_mode: "HTML",
        },
        { allowNotModified: true }
      );
      return { type: "editMessageText", messageId: state.messageId, attempt: i + 1 };
    } catch (e) {
      if (i === attempts.length - 1) throw e;
      continue;
    }
  }
}

// ============================================
// Pinned adopt helpers
// ============================================
async function tryGetPinnedMessage(token, chatId) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId }),
    });
    const json = await safeJson(res);
    if (!json?.ok) return null;
    return json.result?.pinned_message || null;
  } catch {
    return null;
  }
}

function extractPinnedTextOrCaption(pinned) {
  if (typeof pinned?.text === "string" && pinned.text.trim()) return { kind: "text", text: pinned.text };
  if (typeof pinned?.caption === "string" && pinned.caption.trim()) return { kind: "caption", text: pinned.caption };
  return null;
}

function looksLikeDashboard(text) {
  const t = String(text || "");
  if (!t.includes("今日电视剧更新")) return false;
  if (!t.includes("📺")) return false;
  return true;
}

async function bestEffortPin(token, chatId, messageId) {
  try {
    await telegramCall(token, "pinChatMessage", {
      chat_id: chatId,
      message_id: messageId,
      disable_notification: true,
    });
  } catch {}
}

async function bestEffortUnpin(token, chatId, messageId) {
  try {
    await telegramCall(token, "unpinChatMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch {}
}

// ============================================
// Caption building (no URL line)
// ============================================
function buildCaptionHtml({ dateKey, updatedAt, content, budget, aggressive = false, minimal = false }) {
  // Cleaner layout: title + meta line + blank + list
  const header = `🎬 <b>今日电视剧更新</b>`;
  const meta = `🗓 <b>${escapeHtml(dateKey)}</b>  ·  ⏱ <i>${escapeHtml(updatedAt)}</i>`;

  const lines = (content || []).map(({ title, year, season, episode }) => {
    return `📺 <b>${escapeHtml(title)}</b> (${escapeHtml(year)}) ${escapeHtml(season)}${escapeHtml(episode)}`;
  });

  const placeholder = "（今日暂无更新）";
  const body = lines.length ? lines : [placeholder];

  if (minimal) {
    // extreme fallback: only show first few lines
    const prefix = [header, meta, ""];
    const suffix = [];
    return fitLinesToBudget(prefix, body, suffix, budget) || hardTrimVisible(`${header}\n${meta}`, budget);
  }

  const prefix = aggressive ? [header, meta, ""] : [header, meta, ""];
  const suffix = []; // no separators to keep it compact

  return fitLinesToBudget(prefix, body, suffix, budget) || hardTrimVisible(`${header}\n${meta}`, budget);
}

function fitLinesToBudget(prefixLines, bodyLines, suffixLines, budget) {
  const max = bodyLines.length;

  for (let n = max; n >= 0; n--) {
    const hidden = max - n;
    const lines = [...prefixLines, ...bodyLines.slice(0, n)];

    if (hidden > 0) lines.push(`<i>…以及 ${hidden} 条未显示</i>`);
    lines.push(...suffixLines);

    const html = lines.join("\n");
    if (visibleTextLength(html) <= budget) return html;
  }
  return null;
}

function visibleTextLength(html) {
  let t = String(html || "").replace(/<[^>]*>/g, "");
  t = t
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  t = t.replace(/&[#a-zA-Z0-9]+;/g, "X");
  return t.length;
}

function hardTrimVisible(html, budget) {
  let lines = String(html || "").split("\n");
  while (lines.length > 1 && visibleTextLength(lines.join("\n")) > budget) {
    lines.pop();
  }
  return lines.join("\n");
}

function stripAllTags(html) {
  // Keep HTML-escaped text; remove tags entirely
  return String(html || "").replace(/<[^>]*>/g, "");
}

function hardTrimToChars(text, maxChars) {
  const s = String(text || "");
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars - 20)) + "\n…";
}

// ============================================
// Telegram call + errors
// ============================================
function isParseEntityError(msg) {
  const m = String(msg || "").toLowerCase();
  return m.includes("can't parse entities") || m.includes("parse entities") || m.includes("entity") || m.includes("html");
}

async function telegramCall(token, method, body, opts = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await safeJson(res);

  if (!json || !json.ok) {
    const desc = json?.description || json?.error || json?.raw || `Telegram API error: ${method}`;
    if (opts.allowNotModified && typeof desc === "string" && desc.includes("message is not modified")) {
      return null;
    }
    throw new Error(desc);
  }

  if (json.result && typeof json.result.message_id === "number") return json.result.message_id;
  return json.result;
}

// ============================================
// Sorting (safe locale fallback)
// ============================================
function safeSortContent(arr) {
  if (!Array.isArray(arr)) return;

  const cmp = (a, b) => {
    const t = safeStringCompare(String(a.title || ""), String(b.title || ""));
    if (t !== 0) return t;

    const y = (Number(a.year) || 0) - (Number(b.year) || 0);
    if (y !== 0) return y;

    return safeStringCompare(String(a.season || ""), String(b.season || ""));
  };

  try {
    arr.sort(cmp);
  } catch {}
}

function safeStringCompare(a, b) {
  try {
    if (!_collatorZh) _collatorZh = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });
    return _collatorZh.compare(a, b);
  } catch {
    try {
      if (!_collatorDefault) _collatorDefault = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      return _collatorDefault.compare(a, b);
    } catch {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    }
  }
}

// ============================================
// Payload extraction / filter / normalize
// ============================================
function extractTextAndImage(payload) {
  let text = "";
  let image = "";

  if (payload && typeof payload === "object") {
    if (payload.data && typeof payload.data === "object") {
      text = payload.data.text || "";
      image = payload.data.image || "";
      const title = payload.data.title || "";
      if (title && typeof title === "string" && !String(text).includes(title)) {
        text = `${title}\n${text}`;
      }
    } else {
      text = `${payload.title || ""}\n${payload.text || payload.message || ""}`;
      image = payload.image || "";
    }
  }
  return { text: String(text || ""), image: String(image || "") };
}

function isSubscribeReminder(text) {
  if (!text) return false;
  if (!text.includes("电视剧更新")) return false;
  return String(text)
    .split("\n")
    .some((line) => TV_LINE_PREFIX_RE.test(String(line).trim()));
}

function normalizeSubscribeContent(rawText) {
  const lines = String(rawText || "").split("\n");
  const result = [];

  for (let line of lines) {
    line = String(line || "").trim();
    if (!TV_LINE_PREFIX_RE.test(line)) continue;

    const pure = line.replace(/^📺[\uFE0E\uFE0F]?\s*/, "");
    const match = pure.match(/^(.+?)\s*\((\d{4})\)\s*(S\d+)\s*E?(\d+(?:-E?\d+)?)$/i);
    if (!match) continue;

    result.push({
      title: match[1].trim(),
      year: match[2],
      season: match[3].toUpperCase(),
      episode: "E" + String(match[4]).toUpperCase(),
    });
  }

  return result;
}

// ============================================
// Helpers
// ============================================
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function safeJson(res) {
  const raw = await res.text();
  try {
    return JSON.parse(raw);
  } catch {
    return { ok: false, raw, status: res.status };
  }
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sanitizeHttpUrl(url) {
  const s = String(url || "").trim();
  if (!s) return "";
  if (s.length > 2048) return "";
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return "";
  }
}

function formatDateKey(date, timeZone) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatDateTime(date, timeZone) {
  const str = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  return str.replace(/\u200E/g, "");
}

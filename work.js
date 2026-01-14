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

      const classified = classifyEvent(rawText);
      if (classified.type === "skip") {
        return jsonResponse({ success: true, result: `Skipped: ${classified.reason || "Not target message"}` });
      }

      const event = classified.type; // "subscribe" | "library"
      const items = event === "subscribe" ? normalizeSubscribeContent(rawText) : normalizeLibraryContent(rawText);

      if (items.length === 0) {
        return jsonResponse({ success: true, result: `Skipped: No valid items (${event})` });
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
        body: JSON.stringify({ dateKey, event, items, image: event === "subscribe" ? image : "" }),
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

    const { dateKey, event = "subscribe", items, image } = input || {};
    const eventType = event === "library" ? "library" : "subscribe"; // default to subscribe (back-compat)
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
        // pendingLibrary: buffered "已入库" events keyed by dateKey (to handle early / cross-day events safely)
        pendingLibrary: {},
      };
    } else {
      if (!Array.isArray(state.content)) state.content = [];
      if (!state.messageKind) state.messageKind = "unknown";
      if (typeof state.photoUrl !== "string") state.photoUrl = "";
      if (typeof state.dayImage !== "string") state.dayImage = "";
      if (!state.pendingLibrary || typeof state.pendingLibrary !== "object") state.pendingLibrary = {};
    }

    // Upgrade legacy content items (back-compat: {episode:'E13-E14'} -> range fields)
    state.content = Array.isArray(state.content) ? state.content.map(upgradeContentItem).filter(Boolean) : [];
    safeSortContent(state.content);

    let changed = false;

    if (eventType === "library") {
      // Cross-day: do NOT reset dashboard by library events.
      // Buffer them and apply only when today's "电视剧更新" arrives.
      const readyForToday = state.dateKey === dateKey && Array.isArray(state.content) && state.content.length > 0 && state.messageId;

      if (!readyForToday) {
        bufferLibraryItems(state, dateKey, items);
        await this.state.storage.put("state", state);
        return {
          ok: true,
          skipped: true,
          reason: state.dateKey === dateKey ? "Buffered: dashboard not ready yet" : "Buffered: cross-day library event",
          dateKey,
          pendingCount: (state.pendingLibrary?.[dateKey] || []).length,
        };
      }

      const libChanged = applyLibraryItemsToContent(state.content, items);
      if (!libChanged) {
        await this.state.storage.put("state", state);
        return { ok: true, skipped: true, reason: "Library: no matching episodes in today's list", dateKey, messageId: state.messageId };
      }
      changed = true;
    } else {
      // Subscribe reminder: this is the ONLY thing that can "start" a new day on dashboard
      if (state.dateKey !== dateKey) {
        state.dateKey = dateKey;
        state.content = [];
        state.dayImage = "";
        // keep pending only for today (if exists)
        const keep = state.pendingLibrary?.[dateKey];
        state.pendingLibrary = keep ? { [dateKey]: keep } : {};
        changed = true; // ensure first webhook updates dashboard
      }

      // Merge subscribe items into state.content
      const subChanged = mergeSubscribeItems(state.content, items);
      if (subChanged) changed = true;

      safeSortContent(state.content);

      // Daily representative image: pick the first valid http/https we receive today (only from subscribe reminder)
      const safeIncoming = sanitizeHttpUrl(image);
      if (!state.dayImage && safeIncoming) {
        state.dayImage = safeIncoming;
        changed = true;
      }

      // Apply buffered library items for today (if any)
      const pending = Array.isArray(state.pendingLibrary?.[dateKey]) ? state.pendingLibrary[dateKey] : [];
      if (pending.length) {
        const applied = applyLibraryItemsToContent(state.content, pending);
        if (applied) changed = true;
        delete state.pendingLibrary[dateKey];
      }
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

  const lines = (content || []).map((it) => {
    const title = String(it?.title || "").trim();
    const year = String(it?.year || "").trim();
    const season = String(it?.season || "").trim().toUpperCase();

    const episodeText = formatEpisodeWithProgress(it);
    return `📺 <b>${escapeHtml(title)}</b> (${escapeHtml(year)}) ${escapeHtml(season)}${escapeHtml(episodeText)}`;
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

// Classify MoviePilot webhook message type
function classifyEvent(text) {
  const t = String(text || "");
  if (!t.trim()) return { type: "skip", reason: "Empty text" };

  // "已入库" is the only required keyword for library notifications
  if (t.includes("已入库")) return { type: "library" };

  // Ignore download start notifications
  if (t.includes("开始下载")) return { type: "skip", reason: "Start download (ignored)" };

  // Subscribe reminder (电视剧更新)
  if (isSubscribeReminder(t)) return { type: "subscribe" };

  return { type: "skip", reason: "Not SubscribeReminder / Not Library" };
}

// Normalize title for matching keys (also used for display)
function normalizeTitleKey(title) {
  return String(title || "")
    .trim()
    .replace(/\s+/g, " ");
}

function makeShowKey(title, year, season) {
  return `${normalizeTitleKey(title)}|${String(year || "").trim()}|${String(season || "").trim().toUpperCase()}`;
}

function parseEpisodePart(part) {
  const s = String(part || "").trim().toUpperCase();
  const nums = s.match(/\d+/g) || [];
  if (nums.length === 0) return null;

  const fromStr = nums[0];
  const toStr = nums.length >= 2 ? nums[nums.length - 1] : nums[0];

  const from = Number.parseInt(fromStr, 10);
  const to = Number.parseInt(toStr, 10);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;

  let epFrom = from;
  let epTo = to;
  let epFromStr = fromStr;
  let epToStr = toStr;

  if (epTo < epFrom) {
    // swap
    [epFrom, epTo] = [epTo, epFrom];
    [epFromStr, epToStr] = [epToStr, epFromStr];
  }

  return { epFrom, epTo, epFromStr, epToStr };
}

function defaultPadEpisode(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "00";
  if (num >= 0 && num < 10) return "0" + String(num);
  return String(num);
}

function formatEpisodeDisplay(it) {
  const epFrom = Number(it?.epFrom);
  const epTo = Number(it?.epTo);

  const fromStr = typeof it?.epFromStr === "string" && it.epFromStr ? it.epFromStr : defaultPadEpisode(epFrom);
  const toStr = typeof it?.epToStr === "string" && it.epToStr ? it.epToStr : defaultPadEpisode(epTo);

  if (Number.isFinite(epFrom) && Number.isFinite(epTo) && epFrom !== epTo) {
    return `E${fromStr}-E${toStr}`;
  }
  return `E${fromStr}`;
}

// SubscribeReminder: parse episode lines
function normalizeSubscribeContent(rawText) {
  const lines = String(rawText || "").split("\n");
  const result = [];

  for (let line of lines) {
    line = String(line || "").trim();
    if (!TV_LINE_PREFIX_RE.test(line)) continue;

    const pure = line.replace(/^📺[\uFE0E\uFE0F]?\s*/, "");
    const match = pure.match(/^(.+?)\s*\((\d{4})\)\s*(S\d+)\s*E?(\d+(?:\s*-\s*E?\d+)?)$/i);
    if (!match) continue;

    const title = match[1].trim();
    const year = match[2].trim();
    const season = match[3].trim().toUpperCase();

    const epParsed = parseEpisodePart(match[4]);
    if (!epParsed) continue;

    result.push({
      title: normalizeTitleKey(title),
      year,
      season,
      ...epParsed,
    });
  }

  return result;
}

// Library notification: parse "xxx (2022) S01E13 已入库" style line(s)
function normalizeLibraryContent(rawText) {
  const lines = String(rawText || "").split("\n");
  const result = [];

  for (let line of lines) {
    line = String(line || "").trim();
    if (!line || !line.includes("已入库")) continue;

    // Typical patterns:
    // "神印王座 (2022) S01 E193 已入库"
    // "神印王座 (2022) S01E193 已入库"
    // "神印王座 (2022) S01E13-E14 已入库"
    const match = line.match(/^(.+?)\s*\((\d{4})\)\s*(S\d+)\s*E?(\d+(?:\s*-\s*E?\d+)?)\s*已入库/i);
    if (!match) continue;

    const title = match[1].trim();
    const year = match[2].trim();
    const season = match[3].trim().toUpperCase();

    const epParsed = parseEpisodePart(match[4]);
    if (!epParsed) continue;

    result.push({
      title: normalizeTitleKey(title),
      year,
      season,
      ...epParsed,
    });
  }

  return result;
}

// Upgrade any incoming / stored item to the latest schema
function upgradeContentItem(it) {
  if (!it || typeof it !== "object") return null;

  const title = normalizeTitleKey(it.title);
  const year = String(it.year || "").trim();
  const season = String(it.season || "").trim().toUpperCase();
  if (!title || !year || !season) return null;

  let epFrom = it.epFrom;
  let epTo = it.epTo;
  let epFromStr = it.epFromStr;
  let epToStr = it.epToStr;

  const hasRange =
    Number.isFinite(Number(epFrom)) &&
    Number.isFinite(Number(epTo)) &&
    typeof epFromStr === "string" &&
    typeof epToStr === "string" &&
    epFromStr &&
    epToStr;

  if (!hasRange) {
    const legacy = String(it.episode || it.episodeDisplay || "").trim();
    const parsed = parseEpisodePart(legacy);
    if (parsed) {
      epFrom = parsed.epFrom;
      epTo = parsed.epTo;
      epFromStr = parsed.epFromStr;
      epToStr = parsed.epToStr;
    } else {
      // best-effort fallback
      epFrom = Number.parseInt(String(epFrom || "0"), 10) || 0;
      epTo = Number.parseInt(String(epTo || epFrom || "0"), 10) || epFrom;
      epFromStr = String(epFrom);
      epToStr = String(epTo);
    }
  }

  let done = [];
  if (Array.isArray(it.done)) {
    done = it.done
      .map((n) => Number.parseInt(String(n), 10))
      .filter((n) => Number.isFinite(n));
  }
  done = Array.from(new Set(done)).sort((a, b) => a - b);

  return { title, year, season, epFrom: Number(epFrom), epTo: Number(epTo), epFromStr: String(epFromStr), epToStr: String(epToStr), done };
}

// Merge subscribe reminder items into content (in-place)
function mergeSubscribeItems(content, incoming) {
  if (!Array.isArray(content) || !Array.isArray(incoming)) return false;

  let changed = false;

  for (const raw of incoming) {
    const it = upgradeContentItem(raw);
    if (!it) continue;

    const key = makeShowKey(it.title, it.year, it.season);
    const idx = content.findIndex((v) => makeShowKey(v.title, v.year, v.season) === key);

    if (idx === -1) {
      content.push({ ...it, done: Array.isArray(it.done) ? it.done : [] });
      changed = true;
      continue;
    }

    const existing = upgradeContentItem(content[idx]) || content[idx];

    // decide whether to replace episode range (prefer wider / more informative)
    const exLen = Math.max(1, Number(existing.epTo) - Number(existing.epFrom) + 1);
    const inLen = Math.max(1, Number(it.epTo) - Number(it.epFrom) + 1);

    const shouldReplace =
      inLen > exLen ||
      (inLen === exLen && Number(it.epTo) > Number(existing.epTo)) ||
      (inLen === exLen && Number(it.epFrom) < Number(existing.epFrom));

    if (shouldReplace) {
      const preservedDone = Array.isArray(existing.done)
        ? existing.done.filter((n) => n >= it.epFrom && n <= it.epTo)
        : [];
      content[idx] = { ...it, done: Array.from(new Set(preservedDone)).sort((a, b) => a - b) };
      changed = true;
    } else {
      // keep existing but ensure we have done array
      if (!Array.isArray(existing.done)) existing.done = [];
      content[idx] = existing;
    }
  }

  return changed;
}

// Apply library items to today's content (mark done episodes)
function applyLibraryItemsToContent(content, libItems) {
  if (!Array.isArray(content) || !Array.isArray(libItems)) return false;

  let changed = false;

  for (const raw of libItems) {
    const lib = upgradeContentItem(raw);
    if (!lib) continue;

    const key = makeShowKey(lib.title, lib.year, lib.season);
    const idx = content.findIndex((v) => makeShowKey(v.title, v.year, v.season) === key);
    if (idx === -1) continue;

    const item = upgradeContentItem(content[idx]) || content[idx];
    if (!Array.isArray(item.done)) item.done = [];

    const from = Math.max(Number(lib.epFrom), Number(item.epFrom));
    const to = Math.min(Number(lib.epTo), Number(item.epTo));

    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;

    for (let ep = from; ep <= to; ep++) {
      if (!item.done.includes(ep)) {
        item.done.push(ep);
        changed = true;
      }
    }

    if (changed) {
      item.done = Array.from(new Set(item.done)).sort((a, b) => a - b);
    }

    content[idx] = item;
  }

  return changed;
}

function bufferLibraryItems(state, dateKey, libItems) {
  if (!state || typeof state !== "object") return;
  if (!state.pendingLibrary || typeof state.pendingLibrary !== "object") state.pendingLibrary = {};

  const dk = String(dateKey || "").trim();
  if (!dk) return;
  if (!Array.isArray(state.pendingLibrary[dk])) state.pendingLibrary[dk] = [];

  const arr = state.pendingLibrary[dk];

  // Keep unique by show+season+range (avoid infinite growth)
  for (const raw of libItems || []) {
    const it = upgradeContentItem(raw);
    if (!it) continue;
    const sig = `${makeShowKey(it.title, it.year, it.season)}|${it.epFrom}-${it.epTo}`;

    const exists = arr.some((v) => {
      const u = upgradeContentItem(v);
      if (!u) return false;
      return `${makeShowKey(u.title, u.year, u.season)}|${u.epFrom}-${u.epTo}` === sig;
    });

    if (!exists) arr.push(it);
  }

  // hard cap
  if (arr.length > 200) {
    state.pendingLibrary[dk] = arr.slice(arr.length - 200);
  }
}

function formatEpisodeWithProgress(it) {
  const item = upgradeContentItem(it) || it;
  const episodeDisplay = formatEpisodeDisplay(item);

  const total = Math.max(1, Number(item.epTo) - Number(item.epFrom) + 1);
  const doneArr = Array.isArray(item.done) ? item.done : [];
  const doneCount = doneArr.filter((n) => Number.isFinite(Number(n)) && Number(n) >= Number(item.epFrom) && Number(n) <= Number(item.epTo)).length;

  if (!doneCount) return episodeDisplay;
  if (total <= 1) return `${episodeDisplay} ✅`;

  return `${episodeDisplay} (${doneCount}/${total}) ✅`;
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

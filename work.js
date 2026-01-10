// ============================================
// MP-TG-SubscribeBoard (Forever Single Dashboard Message, Free Plan Friendly)
//
// ✅ Telegram: parse_mode HTML + safe escaping
// ✅ Concurrency: Durable Object (SQLite-backed on Free plan) => strong consistency
// ✅ Forever single dashboard message: keep messageId; cross-day reset content only
// ✅ Adopt pinned dashboard message: supports pinned text OR pinned caption
// ✅ Strict mode: do NOT fallback-send new message (unless forced "caption->text upgrade")
// ✅ URL whitelist for <a href>: only http/https
// ✅ Length guard + Telegram "too long" retry shrink
// ✅ Caption trap: if adopted message is caption and hits 1024, auto-upgrade to text message
//    (best-effort pin new + unpin old; requires bot permissions)
//
// Env vars (recommended defaults):
//   TIME_ZONE=Asia/Shanghai
//   STRICT_SINGLE_MESSAGE=1
//   ADOPT_PINNED=1
//   AUTO_PIN=0 or 1
//   SHOW_IMAGE_LINK=1
//   ALLOW_CAPTION_UPGRADE=1
// ============================================

const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const TV_LINE_PREFIX_RE = /^📺[\uFE0E\uFE0F]?/; // 📺︎ / 📺️ / 📺

// Telegram limits (after entities parsing)
const TG_TEXT_LIMIT = 4096;
const TG_CAPTION_LIMIT = 1024;

// Retry shrink margin (to account for Telegram entity counting differences)
const SHRINK_MARGIN_TEXT = 600;
const SHRINK_MARGIN_CAPTION = 300;

// Collator cache for safe sorting
let _collatorZh = null;
let _collatorDefault = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");

    if (!token || token !== env.WEBHOOK_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (request.method === "GET") return new Response("Worker OK", { status: 200 });
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

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

      // One DO instance per chat
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
    this.queue = Promise.resolve(); // serialize tasks
  }

  async fetch(request) {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const input = await request.json();
    const task = this.queue.then(() => this.handleAggregate(input));
    this.queue = task.catch(() => {}); // keep queue alive

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
    const showImageLink = (this.env.SHOW_IMAGE_LINK ?? "1") !== "0"; // default ON
    const allowCaptionUpgrade = (this.env.ALLOW_CAPTION_UPGRADE ?? "1") !== "0"; // default ON

    const { dateKey, items, image } = input || {};
    if (!dateKey || !Array.isArray(items)) throw new Error("Invalid payload to Durable Object");

    let state = (await this.state.storage.get("state")) || null;

    // Init/back-compat normalize
    if (!state || typeof state !== "object") {
      state = {
        messageId: null,           // forever
        messageKind: "text",       // "text" | "caption"
        dateKey: null,
        content: [],
        image: "",
      };
    } else {
      if (!state.messageKind) state.messageKind = "text";
      if (!Array.isArray(state.content)) state.content = [];
      if (typeof state.image !== "string") state.image = "";
    }

    let changed = false;

    // Cross-day reset CONTENT only (keep messageId/kind)
    if (state.dateKey !== dateKey) {
      state.dateKey = dateKey;
      state.content = [];
      state.image = "";
      changed = true; // ensure first webhook of day updates
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
      } else {
        if (String(episode).length > String(state.content[idx].episode || "").length) {
          state.content[idx] = normalized;
          changed = true;
        }
      }
    }

    // Stable sort with safe locale fallback
    safeSortContent(state.content);

    // Daily cover: first valid http/https
    const safeImage = sanitizeHttpUrl(image);
    if (!state.image && safeImage) {
      state.image = safeImage;
      changed = true;
    }

    if (!changed && state.messageId) {
      return { ok: true, skipped: true, reason: "No update needed", messageId: state.messageId };
    }

    const updatedAt = formatDateTime(new Date(), timeZone);

    // Build HTML with budget based on message kind
    const kind = state.messageKind === "caption" ? "caption" : "text";
    const limit = kind === "caption" ? TG_CAPTION_LIMIT : TG_TEXT_LIMIT;

    const html = buildDashboardHtml({
      dateKey: state.dateKey,
      updatedAt,
      content: state.content,
      imageUrl: showImageLink ? state.image : "",
      budget: limit,
    });

    const shrinkBudget =
      kind === "caption"
        ? Math.max(200, TG_CAPTION_LIMIT - SHRINK_MARGIN_CAPTION)
        : Math.max(400, TG_TEXT_LIMIT - SHRINK_MARGIN_TEXT);

    const htmlShort = buildDashboardHtml({
      dateKey: state.dateKey,
      updatedAt,
      content: state.content,
      imageUrl: "", // aggressive: drop link
      budget: shrinkBudget,
      aggressive: true,
    });

    // Upsert Telegram
    const action = await upsertForeverSingleMessage({
      token: BOT_TOKEN,
      chatId: CHAT_ID,
      state,
      html,
      htmlShort,
      strict,
      adoptPinned,
      autoPin,
      allowCaptionUpgrade,
    });

    await this.state.storage.put("state", state);
    return { ok: true, skipped: false, action, messageId: state.messageId, dateKey: state.dateKey };
  }
}

// ============================================
// Telegram upsert (forever single dashboard message)
// ============================================
async function upsertForeverSingleMessage({
  token,
  chatId,
  state,
  html,
  htmlShort,
  strict,
  adoptPinned,
  autoPin,
  allowCaptionUpgrade,
}) {
  const tryAdopt = async () => {
    if (!adoptPinned) return null;
    const pinned = await tryGetPinnedMessage(token, chatId);
    if (!pinned) return null;

    const extracted = extractPinnedTextOrCaption(pinned);
    if (!extracted) return null;

    if (!looksLikeDashboard(extracted.text)) return null;
    return { messageId: pinned.message_id, messageKind: extracted.kind };
  };

  // 0) adopt pinned if no messageId
  if (!state.messageId) {
    const adopted = await tryAdopt();
    if (adopted) {
      state.messageId = adopted.messageId;
      state.messageKind = adopted.messageKind;
    }
  }

  // 1) create initial message if none (allowed even in strict)
  if (!state.messageId) {
    const messageId = await telegramCall(token, "sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      disable_notification: true,
    });
    state.messageId = messageId;
    state.messageKind = "text";

    if (autoPin) await bestEffortPin(token, chatId, messageId);
    return { type: "sendMessage", messageId, adoptedPinned: false };
  }

  // 2) edit forever
  const edit = async (payloadHtml) => {
    if (state.messageKind === "caption") {
      await telegramCall(
        token,
        "editMessageCaption",
        {
          chat_id: chatId,
          message_id: state.messageId,
          caption: payloadHtml,
          parse_mode: "HTML",
        },
        { allowNotModified: true }
      );
      return { type: "editMessageCaption", messageId: state.messageId };
    } else {
      await telegramCall(
        token,
        "editMessageText",
        {
          chat_id: chatId,
          message_id: state.messageId,
          text: payloadHtml,
          parse_mode: "HTML",
        },
        { allowNotModified: true }
      );
      return { type: "editMessageText", messageId: state.messageId };
    }
  };

  // Helper: upgrade caption -> text (creates ONE new dashboard message, then forever edits it)
  const upgradeCaptionToText = async (payloadHtml, reason) => {
    if (!allowCaptionUpgrade) {
      throw new Error(`Caption message hit limit but ALLOW_CAPTION_UPGRADE=0. Reason: ${reason}`);
    }

    const oldId = state.messageId;

    // send new text dashboard
    const newId = await telegramCall(token, "sendMessage", {
      chat_id: chatId,
      text: payloadHtml,
      parse_mode: "HTML",
      disable_notification: true,
    });

    // optionally pin new; best-effort unpin old
    if (autoPin) {
      await bestEffortPin(token, chatId, newId);
      await bestEffortUnpin(token, chatId, oldId);
    }

    state.messageId = newId;
    state.messageKind = "text";

    return { type: "upgrade_caption_to_text", oldMessageId: oldId, newMessageId: newId, pinned: autoPin };
  };

  // 2.1 normal edit attempt
  try {
    return await edit(html);
  } catch (err1) {
    const msg1 = String(err1?.message || err1);

    // 2.2 If Telegram says "too long" (or similar), retry with shorter HTML
    if (isTooLongError(msg1)) {
      try {
        return await edit(htmlShort);
      } catch (err2) {
        const msg2 = String(err2?.message || err2);

        // If caption trap: try upgrade
        if (state.messageKind === "caption" && isTooLongError(msg2)) {
          return await upgradeCaptionToText(htmlShort, msg2);
        }

        if (strict) {
          throw new Error(`STRICT_SINGLE_MESSAGE: edit failed (too long) and fallback-send disabled. Cause: ${msg2}`);
        }
        // non-strict fallback (not recommended)
        return await fallbackSendNewText(token, chatId, state, htmlShort, autoPin);
      }
    }

    // 2.3 If HTML parsing fails, retry without links (and then with htmlShort)
    if (isParseEntityError(msg1)) {
      const noLinks = stripLinksFromHtml(html);
      try {
        return await edit(noLinks);
      } catch (err3) {
        const msg3 = String(err3?.message || err3);

        // try shorter (no links already)
        try {
          const noLinksShort = stripLinksFromHtml(htmlShort);
          return await edit(noLinksShort);
        } catch (err4) {
          const msg4 = String(err4?.message || err4);

          // caption upgrade if caption parse keeps failing
          if (state.messageKind === "caption") {
            return await upgradeCaptionToText(stripLinksFromHtml(htmlShort), msg4);
          }

          if (strict) {
            throw new Error(`STRICT_SINGLE_MESSAGE: edit failed (parse) and fallback disabled. Cause: ${msg4}`);
          }
          return await fallbackSendNewText(token, chatId, state, stripLinksFromHtml(htmlShort), autoPin);
        }
      }
    }

    // 2.4 maybe pinned changed: re-adopt once and retry
    const adopted = await tryAdopt();
    if (adopted && adopted.messageId && adopted.messageId !== state.messageId) {
      state.messageId = adopted.messageId;
      state.messageKind = adopted.messageKind;
      try {
        return await edit(html);
      } catch (err5) {
        const msg5 = String(err5?.message || err5);

        // if adopted caption causes issues, try upgrade
        if (state.messageKind === "caption" && (isTooLongError(msg5) || isParseEntityError(msg5))) {
          return await upgradeCaptionToText(htmlShort, msg5);
        }

        if (strict) throw new Error(`STRICT_SINGLE_MESSAGE: edit failed after re-adopt. Cause: ${msg5}`);
        return await fallbackSendNewText(token, chatId, state, htmlShort, autoPin);
      }
    }

    // 2.5 last: strict/no-strict
    if (state.messageKind === "caption" && (isTooLongError(msg1) || isParseEntityError(msg1))) {
      return await upgradeCaptionToText(htmlShort, msg1);
    }

    if (strict) throw new Error(`STRICT_SINGLE_MESSAGE: edit failed and fallback disabled. Cause: ${msg1}`);
    return await fallbackSendNewText(token, chatId, state, htmlShort, autoPin);
  }
}

async function fallbackSendNewText(token, chatId, state, html, autoPin) {
  const messageId = await telegramCall(token, "sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_notification: true,
  });
  state.messageId = messageId;
  state.messageKind = "text";
  if (autoPin) await bestEffortPin(token, chatId, messageId);
  return { type: "sendMessage", messageId, fallback: true };
}

async function bestEffortPin(token, chatId, messageId) {
  try {
    await telegramCall(token, "pinChatMessage", {
      chat_id: chatId,
      message_id: messageId,
      disable_notification: true,
    });
  } catch (e) {
    console.warn("AUTO_PIN failed:", e?.message || e);
  }
}

async function bestEffortUnpin(token, chatId, messageId) {
  try {
    // message_id is optional in some implementations; we pass explicitly for safety
    await telegramCall(token, "unpinChatMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch (e) {
    console.warn("AUTO_UNPIN failed:", e?.message || e);
  }
}

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
  if (typeof pinned?.text === "string" && pinned.text.trim()) {
    return { kind: "text", text: pinned.text };
  }
  if (typeof pinned?.caption === "string" && pinned.caption.trim()) {
    return { kind: "caption", text: pinned.caption };
  }
  return null;
}

function looksLikeDashboard(text) {
  const t = String(text || "");
  if (!t.includes("今日电视剧更新")) return false;
  if (!t.includes("更新于")) return false;
  if (!t.includes("═══════════════")) return false;
  const hasTv = t.split("\n").some((l) => String(l).trim().startsWith("📺"));
  return hasTv;
}

function stripLinksFromHtml(html) {
  return String(html || "").replace(/<a\s+href="[^"]*">([\s\S]*?)<\/a>/gi, "$1");
}

function isTooLongError(msg) {
  const m = String(msg || "").toLowerCase();
  return (
    m.includes("too long") ||
    m.includes("message is too long") ||
    m.includes("message_text is too long") ||
    m.includes("message caption is too long") ||
    m.includes("caption is too long")
  );
}

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
// Message building with budget + aggressive trimming
// ============================================
function buildDashboardHtml({ dateKey, updatedAt, content, imageUrl, budget, aggressive = false }) {
  const header = `🎬 <b>今日电视剧更新</b>`;
  const dateLine = `📅 <b>${escapeHtml(dateKey)}</b>`;
  const sep = `═══════════════`;
  const updatedLine = `⏳ <i>更新于: ${escapeHtml(updatedAt)}</i>`;

  const safeUrl = sanitizeHttpUrl(imageUrl);
  const imgLine = safeUrl ? `🖼 <a href="${escapeHtmlAttr(safeUrl)}">代表图</a>` : "";

  const bodyLines = (content || []).map(({ title, year, season, episode }) => {
    return `📺 <b>${escapeHtml(title)}</b> (${escapeHtml(year)}) ${escapeHtml(season)}${escapeHtml(episode)}`;
  });

  const placeholder = "（今日暂无更新）";
  const body = bodyLines.length ? bodyLines : [placeholder];

  const strategies = aggressive
    ? [
        { useDate: true, useImg: false, useSep: true },
        { useDate: false, useImg: false, useSep: true },
        { useDate: false, useImg: false, useSep: false },
      ]
    : [
        { useDate: true, useImg: true, useSep: true },
        { useDate: true, useImg: false, useSep: true },
        { useDate: false, useImg: false, useSep: true },
      ];

  for (const s of strategies) {
    const prefix = [
      header,
      ...(s.useDate ? [dateLine] : []),
      ...(s.useImg && imgLine ? [imgLine] : []),
      ...(s.useSep ? [sep] : []),
      "",
    ];
    const suffix = ["", ...(s.useSep ? [sep] : []), updatedLine];

    const fitted = fitLinesToBudget(prefix, body, suffix, budget);
    if (fitted) return fitted;
  }

  // last resort minimal
  const minimal = `${header}\n${updatedLine}`;
  return hardTrimVisible(minimal, budget);
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

function hardTrimVisible(html, budget) {
  let lines = String(html || "").split("\n");
  while (lines.length > 1 && visibleTextLength(lines.join("\n")) > budget) {
    lines.pop();
  }
  return lines.join("\n");
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
  } catch (e) {
    // absolute fallback: no sort
    console.warn("Sort failed, skipping:", e?.message || e);
  }
}

function safeStringCompare(a, b) {
  // Prefer zh collator, fallback to default, then lexicographic
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
    const match = pure.match(
      /^(.+?)\s*\((\d{4})\)\s*(S\d+)\s*E?(\d+(?:-E?\d+)?)$/i
    );
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

function escapeHtmlAttr(text) {
  return escapeHtml(text)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  // YYYY-MM-DD
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

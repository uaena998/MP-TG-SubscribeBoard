// ============================================
// Cloudflare Worker: MoviePilot SubscribeReminder ONLY
// + URL Token Authentication
// + Daily Aggregation
// + Daily Random Cover Image
// ============================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    if (!token || token !== env.WEBHOOK_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }

    if (request.method === 'GET') {
      return new Response('Worker OK', { status: 200 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    try {
      const payload = await request.json();
      const result = await handleWebhook(payload, env);
      return new Response(JSON.stringify({ success: true, result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (err) {
      console.error(err);
      return new Response(
        JSON.stringify({ success: false, error: err.message }),
        { status: 500 }
      );
    }
  }
};

// ============================================
// Main Logic
// ============================================
async function handleWebhook(payload, env) {
  const { BOT_TOKEN, CHAT_ID, MP_KV: KV } = env;
  if (!BOT_TOKEN || !CHAT_ID || !KV) {
    throw new Error('Missing Env Vars');
  }

  let rawText = '';
  let image = '';

  if (payload?.data) {
    rawText = payload.data.text || '';
    image = payload.data.image || '';
    if (payload.data.title && !rawText.includes(payload.data.title)) {
      rawText = payload.data.title + '\n' + rawText;
    }
  } else {
    rawText =
      (payload.title || '') +
      '\n' +
      (payload.text || payload.message || '');
    image = payload.image || '';
  }

  if (!isSubscribeReminder(rawText)) {
    return 'Skipped: Not SubscribeReminder';
  }

  const cleanItems = normalizeSubscribeContent(rawText);
  if (cleanItems.length === 0) {
    return 'Skipped: No valid episode lines';
  }

  const today = new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai'
  });

  for (let i = 0; i < 15; i++) {
    if (await acquireLock(KV, today)) {
      try {
        return await updateDashboard(
          KV,
          BOT_TOKEN,
          CHAT_ID,
          today,
          cleanItems,
          image
        );
      } finally {
        await releaseLock(KV, today);
      }
    }
    await sleep(Math.random() * 800 + 200);
  }

  throw new Error('Lock timeout');
}

// ============================================
// Filter
// ============================================
function isSubscribeReminder(text) {
  if (!text) return false;
  if (!text.includes('电视剧更新')) return false;
  return text.split('\n').some(l => l.trim().startsWith('📺︎'));
}

// ============================================
// Normalize
// ============================================
function normalizeSubscribeContent(rawText) {
  const lines = rawText.split('\n');
  const result = [];

  for (let line of lines) {
    line = line.trim();
    if (!line.startsWith('📺︎')) continue;

    const pure = line.replace(/^📺︎\s*/, '');
    const match = pure.match(
      /^(.+?)\s*\((\d{4})\)\s*(S\d+)\s*E?(\d+(?:-E?\d+)?)$/i
    );
    if (!match) continue;

    const title = escapeMarkdown(match[1].trim());
    const year = match[2];
    const season = match[3].toUpperCase();
    const episode = 'E' + match[4];

    result.push(`📺 ${title} (${year}) ${season}${episode}`);
  }

  return result;
}

// ============================================
// Aggregation + Telegram Update
// ============================================
async function updateDashboard(
  KV,
  BOT_TOKEN,
  CHAT_ID,
  today,
  newItems,
  image
) {
  const key = `dashboard:${today}`;
  const raw = await KV.get(key);

  let state = raw
    ? JSON.parse(raw)
    : { date: today, messageId: null, content: [], image: '' };

  let changed = false;

  for (const item of newItems) {
    const keyPart = item.match(/^(.*S\d+)/)?.[1];
    const idx = state.content.findIndex(v => v.startsWith(keyPart));

    if (idx === -1) {
      state.content.push(item);
      changed = true;
    } else if (item.length > state.content[idx].length) {
      state.content[idx] = item;
      changed = true;
    }
  }

  // ============================================
  // 🎲 今日代表图（只选一次）
  // ============================================
  if (!state.image && image) {
    if (Math.random() < 0.3) {
      state.image = image;
      changed = true;
    }
  }

  if (!changed && state.messageId) {
    return 'Skipped: No update needed';
  }

  const text = buildMessageText(state.content);

  if (!state.messageId) {
    state.messageId = await sendTelegramMessage(
      BOT_TOKEN,
      CHAT_ID,
      text,
      state.image
    );
  } else {
    try {
      await updateTelegramMessage(
        BOT_TOKEN,
        CHAT_ID,
        state.messageId,
        text,
        state.image
      );
    } catch {
      state.messageId = await sendTelegramMessage(
        BOT_TOKEN,
        CHAT_ID,
        text,
        state.image
      );
    }
  }

  await KV.put(key, JSON.stringify(state), { expirationTtl: 172800 });
  return `Success: ${state.messageId}`;
}

// ============================================
// Message Format
// ============================================
function buildMessageText(content) {
  const time = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false
  });

  const lines = content.map(v =>
    v.replace(/(📺\s*)(.+?)(\s*\(\d{4}\))/g, '$1**$2**$3')
  );

  return `🎬 **今日电视剧更新**
═══════════════

${lines.join('\n')}

═══════════════
⏳ _更新于: ${time}_`;
}

// ============================================
// Utils
// ============================================
function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

async function acquireLock(KV, key) {
  const k = `lock:${key}`;
  const v = Date.now().toString();
  if (await KV.get(k)) return false;
  await KV.put(k, v, { expirationTtl: 60 });
  return (await KV.get(k)) === v;
}

async function releaseLock(KV, key) {
  await KV.delete(`lock:${key}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================
// Telegram API
// ============================================
async function sendTelegramMessage(token, chatId, text, image) {
  const method = image ? 'sendPhoto' : 'sendMessage';
  const body = {
    chat_id: chatId,
    parse_mode: 'Markdown',
    [image ? 'caption' : 'text']: text
  };
  if (image) body.photo = image;

  const res = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );
  const json = await res.json();
  if (!json.ok) throw new Error(json.description);
  return json.result.message_id;
}

async function updateTelegramMessage(token, chatId, msgId, text, image) {
  const method = image ? 'editMessageMedia' : 'editMessageText';
  const body = {
    chat_id: chatId,
    message_id: msgId,
    parse_mode: 'Markdown'
  };

  if (image) {
    body.media = {
      type: 'photo',
      media: image,
      caption: text,
      parse_mode: 'Markdown'
    };
  } else {
    body.text = text;
  }

  const res = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );
  const json = await res.json();
  if (!json.ok && !json.description.includes('not modified')) {
    throw new Error(json.description);
  }
}

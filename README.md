# MP-TG-SubscribeBoard

将 MoviePilot 的订阅提醒聚合为 Telegram 中一条可持续编辑的置顶消息：
📌 **「今日电视剧更新」看板**（只编辑、不刷屏）

> MP-TG-SubscribeBoard 是一个基于 **Cloudflare Workers + Durable Object** 的轻量级聚合服务，
> 用于接收 MoviePilot「订阅提醒（电视剧更新）」Webhook 并将其聚合成 Telegram 的单条消息。

---

## 1️⃣ 项目背景

在 MoviePilot 中，你可以使用「订阅提醒」插件获取电视剧、动画、国漫等更新通知。
但是存在几个问题：

- 一天的更新可能分页多条消息（每页最多 8 条），导致频道杂乱。
- 每天的通知重复发送或多个 Webhook 并发触发时，会发送多条消息。
- 用户希望每日只置顶一条「今日更新」消息，长期可持续编辑，而不是刷屏。
- 插件发送的入库 / 下载通知不需要处理，只需要关注「电视剧更新」。

**MP-TG-SubscribeBoard** 旨在解决以上问题，将订阅提醒聚合、去重，并发送到 Telegram 中的一条固定消息，实现：

- 每日只有一条置顶消息
- 多分页提醒自动合并
- 消息可持续编辑更新
- 完全静默地忽略非订阅提醒内容

---

## 2️⃣ 核心功能

- **严格筛选订阅提醒**
  - 只处理包含关键字「电视剧更新」的消息
  - 只处理以 `📺︎` 开头的剧集行
  - 信任 MoviePilot 插件的集数格式，不拆分 / 合并集数
- **聚合分页消息**
  - 当日多条订阅提醒（分页）自动合并
  - 不会重复发送多条消息
- **单条 Telegram 消息置顶编辑**
  - 首次发送 → 新建消息
  - 后续更新 → 编辑同一条消息
  - 消息内容每天自动刷新
- **每日代表图**
  - 第一次收到订阅提醒 → 采用首个有效图片链接
  - 当日内后续分页 → 保持同一张图片
  - 第二天重新选择
- **防并发、锁机制**
  - 使用 Durable Object 串行化处理
  - 避免多个 Webhook 同时触发重复发送
- **Webhook Token 身份验证**
  - URL 参数 `?token=xxx`
  - 防止未经授权访问

---

## 3️⃣ 工作流程

```
MoviePilot SubscribeReminder → Cloudflare Worker → Durable Object 聚合 → Telegram 消息
```

1. MoviePilot 订阅提醒插件触发 Webhook
2. Worker 校验 Token 和内容
3. 聚合当日所有「电视剧更新」
4. Telegram：
   - 首次 → 发送新消息
   - 后续 → 编辑同一条消息

> 非订阅提醒消息完全忽略，保持频道干净。

---

## 4️⃣ 技术细节

- **Cloudflare Workers**
  - 无服务器、低成本、全天候可用
- **Cloudflare Durable Object**
  - 存储每日聚合状态
  - 串行化更新防止并发重复发送
- **Telegram Bot API**
  - 发送 / 编辑消息
  - HTML parse_mode 支持
- **安全措施**
  - Webhook Token
  - 严格筛选剧集行

---

## 5️⃣ 配置与部署

### 安装依赖

需要安装 Wrangler：

```
npm install -g wrangler
```

### 本地运行

```
wrangler dev --local
```

默认监听 `http://localhost:8787`，用于调试 Webhook 请求。

### 部署到 Cloudflare

1. 登录并部署：

```
wrangler login
wrangler deploy
```

2. 默认入口文件为 `work.js`，Durable Object 绑定已在 `wrangler.toml` 中声明。

### 环境变量 / Secrets（Worker 中设置）

| 类型 | 名称 | 默认值 | 说明 |
| --- | --- | --- | --- |
| Secret | `WEBHOOK_TOKEN` | 无 | Webhook 鉴权 Token（URL 参数 `?token=`） |
| Secret | `BOT_TOKEN` | 无 | Telegram Bot API Token |
| Variable | `CHAT_ID` | 无 | Telegram 频道或群组 ID |
| Variable | `TIME_ZONE` | `Asia/Shanghai` | 日期与时间展示时区 |
| Variable | `STRICT_SINGLE_MESSAGE` | `1` | 严格保持单条消息（`0` 允许降级） |
| Variable | `ADOPT_PINNED` | `1` | 启动时尝试接管已置顶的看板消息 |
| Variable | `AUTO_PIN` | `0` | 发送新消息后自动置顶 |
| Variable | `PREFER_PHOTO_MESSAGE` | `1` | 优先使用图片消息（caption 形式） |
| Variable | `ALLOW_TEXT_TO_PHOTO_UPGRADE` | `1` | 允许将已有文本看板升级为图片看板 |

示例配置：

```
wrangler secret put WEBHOOK_TOKEN
wrangler secret put BOT_TOKEN
wrangler secret put CHAT_ID
wrangler deploy
```

### Webhook URL 示例

```
https://your-worker-url.workers.dev/?token=WEBHOOK_TOKEN
```

### Telegram Bot 设置

- 创建 Bot → 获取 Token
- 将频道 / 群组 ID 填入 `CHAT_ID`
- Worker 会自动发送 / 编辑每日消息

### Durable Object 注意事项

- 聚合状态保存在 Durable Object 的 SQLite 存储中
- 自动按日期切换聚合内容，消息 ID 会长期复用

---

## 6️⃣ 使用示例

### Webhook 请求示例

Worker 支持 MoviePilot 默认的 Webhook JSON：

```
{
  "data": {
    "title": "电视剧更新",
    "text": "📺︎长河落日 (2026) S01E17\n📺︎玉茗茶骨 (2025) S01E22",
    "image": "https://example.com/poster.jpg"
  }
}
```

使用 `curl` 触发：

```
curl -X POST "https://your-worker-url.workers.dev/?token=WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"data":{"title":"电视剧更新","text":"📺︎长河落日 (2026) S01E17\n📺︎玉茗茶骨 (2025) S01E22","image":"https://example.com/poster.jpg"}}'
```

### Telegram 展示效果

```
🎬 今日电视剧更新
🗓 2026-01-09  ·  ⏱ 2026/01/09 13:02:23

📺 长河落日 (2026) S01E17
📺 玉茗茶骨 (2025) S01E22
…
```

当收到第二页提醒 → 同一条消息自动更新，消息内容保持当天聚合，图片固定。

---

## 7️⃣ 项目目标与设计理念

- **简洁**：频道只有一条消息，永远置顶
- **聚合**：分页 / 多条提醒自动合并
- **安全**：Webhook Token，严格过滤
- **可扩展**：未来可加入入库打钩、质量标记等功能

**总结：**MP-TG-SubscribeBoard 是一个「今日剧集看板」，既避免刷屏，又确保每日聚合更新，让 Telegram 频道长期干净、整洁。

---

## 8️⃣ 项目结构

```
.
├── work.js         # Worker 入口 + Durable Object 逻辑
├── wrangler.toml   # Wrangler 配置与 DO 绑定
├── README.md       # 项目说明
└── LICENSE
```

## 📜 License

MIT License

---

## ⭐️ Star 支持一下！

如果这个项目对你有帮助，欢迎点个 Star ⭐

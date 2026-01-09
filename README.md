# MP-TG-SubscribeBoard

将 MoviePilot 的订阅提醒聚合为 Telegram 中一条可持续编辑的置顶消息：  
📌 **「今日电视剧更新」看板**（只编辑、不刷屏）

> MP-TG-SubscribeBoard 是一个基于 **Cloudflare Workers + KV** 的轻量级聚合服务  
> 用于接收 MoviePilot「订阅提醒（电视剧更新）」Webhook 并将其聚合成 Telegram 的单条消息。

---

## ✨ 解决的问题

MoviePilot 的订阅提醒在 Telegram 频道中常见痛点：

❌ 订阅提醒分页多 → 多条消息刷屏  
❌ 每天需要重复置顶 → 频道杂乱  
❌ Webhook 并发触发 → 重复发送  

本项目的目标是把订阅提醒从“通知流”变成“今日剧集看板”：

✅ **每天只有一条消息**  
✅ **多分页 / 重复提醒自动合并**  
✅ **后续只编辑不刷屏**  
✅ **一次置顶长期使用**

---

## 🧠 核心特性

- 📺 **仅处理** MoviePilot「订阅提醒 · 电视剧更新」
- 📦 多分页提醒自动聚合（合并成一个“今日更新列表”）
- 🕘 严格按天管理（跨天自动重置）
- 🔒 KV 锁机制：防并发导致重复发送
- 🖼️ 每日随机代表图（当天固定）
- 🔐 Webhook Token 身份验证
- ☁️ Serverless：Cloudflare Workers + KV，无需服务器

---

## 🧩 工作流程

1. MoviePilot 订阅提醒插件触发 Webhook  
2. Cloudflare Worker 校验来源 & 内容  
3. 聚合当日所有「电视剧更新」  
4. 推送到 Telegram：
   - 首次 → **发送新消息**
   - 后续 → **编辑同一条消息**

---

## 🎯 设计理念

这不是一个通知流，而是一个 **“今日剧集看板”**

✅ 不打扰  
✅ 不刷屏  
✅ 不重复  
✅ 永远只看一条  

---

## 🚀 Quick Start

> 以下内容示例，你可以根据实际环境补充（我也可以继续帮你完善）

### 1) 部署到 Cloudflare Workers

- 创建 Worker
- 绑定 KV Namespace（用于聚合与锁机制）
- 配置环境变量（见下方）

### 2) MoviePilot Webhook 配置

在 MoviePilot 的订阅提醒插件中设置 Webhook：

https://<your-worker-domain>/webhook/<TOKEN>

### 3) Telegram 侧配置

需要你创建一个 Bot，并让 Bot 在频道有权限：

- 发送消息
- 编辑消息
- 置顶消息（如果需要自动置顶）

---

## ⚙️ 配置项（Environment Variables）

| 变量名 | 说明 | 示例 |
|------|------|------|
| `TG_BOT_TOKEN` | Telegram Bot Token | `123456:ABC...` |
| `TG_CHAT_ID` | 频道 / 群组 ID | `-100xxxxxx` |
| `WEBHOOK_TOKEN` | Webhook 验证 Token | `your_secret_token` |
| `KV_NAMESPACE` | Cloudflare KV 命名空间绑定 | `MP_KV` |

---

## 📌 Todo / Roadmap（可选）

- [ ] 支持更多订阅提醒类型（电影/动画）
- [ ] 支持多频道/多订阅源
- [ ] 增加 Markdown/HTML 输出模板自定义
- [ ] Web UI 预览今日看板内容

---

## 📜 License

MIT License

---

## ⭐️ Star 支持一下！

如果这个项目对你有帮助，欢迎点个 Star ⭐  

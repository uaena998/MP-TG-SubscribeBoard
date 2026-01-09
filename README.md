# MP-TG-SubscribeBoard
将 MoviePilot 订阅提醒聚合为 Telegram 中的一条“今日电视剧更新”置顶消息。
MP-TG-SubscribeBoard 是一个基于 Cloudflare Workers 的轻量级聚合服务，用于将 MoviePilot 的「订阅提醒（电视剧更新）」 Webhook：
👉 聚合为 Telegram 中的一条可持续编辑的“今日电视剧更新”消息
✨ 解决的问题
❌ 订阅提醒分页多、消息多、刷频道
❌ 每天重复置顶、频道杂乱
❌ Webhook 并发导致重复发消息
✅ 每天只有一条消息
✅ 分页 / 重复提醒自动合并
✅ 只编辑，不刷屏
✅ 一次置顶，长期使用
🧠 核心特性
📺 仅处理 MoviePilot「订阅提醒 · 电视剧更新」
📦 多分页订阅提醒自动聚合
🕘 严格“按天”管理（跨天自动重置）
🔒 KV 锁机制，防并发重复发送
🖼️ 每日随机代表图（当日固定）
🔐 Webhook Token 身份验证
☁️ 无服务器（Cloudflare Workers + KV）
🧩 工作流程
MoviePilot 订阅提醒插件触发 Webhook
Cloudflare Worker 校验来源 & 内容
聚合当天所有「电视剧更新」
在 Telegram 中：
首次 → 发送新消息
后续 → 编辑同一条消息
🎯 设计理念
不是通知流，而是一个“今日剧集看板”
不打扰
不刷屏
不重复
永远只看一条

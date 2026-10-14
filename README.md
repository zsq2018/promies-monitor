# Promies 新码监控

监控 [Promies iOS 活动第一页](https://www.promies.net/promotions?platform=ios)：
**出现新活动** 或 **老活动补货** 时推送飞书，并判定该码**是否终身免费**。

## 当前生产部署

跑在 **Cloudflare Worker** 上（不是 GitHub Actions —— GitHub 对分钟级 cron 会丢弃）。

| 项目 | 值 |
|---|---|
| Worker | `promies-monitor` |
| 定时 | `*/10 * * * *`（每 10 分钟） |
| 状态 | R2 桶 `promies-monitor-state`，键 `promies-state.json` |
| 飞书 | webhook 内嵌在脚本里；该机器人开了**关键词校验**，消息必须含 `热点` |

## 目录

- `worker/worker.mjs` —— Worker 源码（抓取 / 解析 / 判定 / 飞书 / 告警 / 心跳）
- `worker/wrangler.toml` —— 部署配置（R2 绑定 + cron 触发器）
- `monitor.py` —— 早期 GitHub Actions 版本（已停用，保留备查）

## 部署 / 更新

```sh
export CLOUDFLARE_ACCOUNT_ID=f9d117055a48b1cf51ca34066eff65a2   # 主账号，务必设对
cd worker && wrangler deploy
```

> 不设 `CLOUDFLARE_ACCOUNT_ID` 会用环境里预置的另一个账号 → 报 Authentication error。

## 判定规则（6 档）

顺序很重要：**先判要不要付钱，再判期限，最后才认 lifetime**
（`... at 60% off for lifetime` 含 lifetime 但其实是付费）。

| 标签 | 判据 |
|---|---|
| ✅ 终身免费 | 现价 FREE/0 **且** offer 含 `lifetime`/`forever` |
| 🟡 免费（未标注期限） | 现价 FREE/0，没写终身 |
| ❌ 需付费 | 现价是具体金额 |
| ❌ 仅 1 年 | offer 含 `1 year`/`一年` |
| ❌ 试用/订阅 | offer 含 `trial`/`month` |
| ⚪ 信息不足 | 两者都没线索 |

## 可靠性设计

- **静默失败已消除**：抓取异常 / HTTP 非 200 / 解析到 0 张卡 → 推「⚠️ 监控异常」（6 小时限流一次）
- **每周一 09:00（北京）心跳**：推一条「监控正常」+ 当前活动统计
  → **没消息 = 真的没新码，不是掉线了**
- 冷启动保护：一次冒出 ≥8 个「新活动」视为首次运行，发简短基线而不刷屏

## 推送规则

- 🆕 新活动且有码 → 推送（按 ✅终身免费 / 🟡 / ⚪ 排序）
- ♻️ 已存在的活动余量**变多** → 推送
- 余量减少 / 活动消失 / 无变化 → **安静**
- 售罄的活动不触发提醒

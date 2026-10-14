# Promies 新码监控

监控 [Promies iOS 活动第一页](https://www.promies.net/promotions?platform=ios)：
**出现新活动** 或 **老活动补货** 时，推送飞书通知。

## 工作方式

- GitHub Actions 每 10 分钟抓一次活动列表（纯 HTTP，不用浏览器）
- 与 `state.json` 里的快照对比：
  - **新活动**：出现了没见过的 UUID，且有码 → 推送
  - **补货**：已存在的活动余量**变多**了 → 推送
  - 余量减少 / 活动消失 / 没变化 → 不推送（不打扰）
- 有变化就把新快照提交回本仓库

## 配置

仓库 Settings → Secrets and variables → Actions → New repository secret：

| 名称 | 值 |
|---|---|
| `FEISHU_WEBHOOK` | 飞书群自定义机器人的 Webhook 地址 |

命令行等价写法：

```sh
gh secret set FEISHU_WEBHOOK -R zsq2018/promies-monitor
```

## 手动触发

```sh
gh workflow run "Promies 新码监控" -R zsq2018/promies-monitor
```

## 本地跑

```sh
FEISHU_WEBHOOK="https://open.feishu.cn/open-apis/bot/v2/hook/xxx" python3 monitor.py
```

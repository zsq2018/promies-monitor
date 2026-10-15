// Promies 新码监控 —— Cloudflare Worker（定时 + 手动）
// 监控 https://www.promies.net/promotions?platform=ios 第一页
// 新活动 / 补货 → 推飞书；并判定是否「终身免费」

const LIST_URL = "https://www.promies.net/promotions?platform=ios";
const STATE_KEY = "promies-state.json";
const KEYWORD = "热点"; // 飞书机器人关键词校验要求
// 该机器人的 webhook（仅本 Worker 可见）
const FEISHU_WEBHOOK_FALLBACK = "https://open.feishu.cn/open-apis/bot/v2/hook/6395a008-1512-4bc6-bca9-6caa3d0c4932";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const CARD_SPLIT = /<div\s+class="card-container/g;
const H3_RE    = /<h3[^>]*>([\s\S]*?)<\/h3>/;
const CNT_RE   = /<span>\s*(\d{1,6})\s*<\/span>\s*<span>\s*\/\s*<\/span>\s*<span>\s*(\d{1,6})\s*<\/span>/;
const LINK_RE  = /href="\/promotion\/([a-f0-9-]{36})"/;
const BADGE_RE = /badge[^>]*>\s*([A-Za-z]{2,8})\s*</;
const STORE_RE = /href="(https:\/\/apps\.apple\.com\/[^"]+)"/;
const HOURS_RE = /(\d{1,5})\s*hours? left/;
const DESC_RE  = /text-gray-600 text-sm mb-3[^>]*>\s*([^<]{2,300}?)\s*</;
const BEFORE_RE= /line-through[^>]*>\s*([^<]{1,12}?)\s*</;
const AFTER_RE = /text-2xl font-bold[^>]*>\s*([^<]{1,12}?)\s*</;

const strip = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();

export function parseCards(html) {
  const out = [];
  for (const block of html.split(CARD_SPLIT).slice(1)) {
    const h3 = H3_RE.exec(block);
    if (!h3) continue;
    const cnt = CNT_RE.exec(block);
    const link = LINK_RE.exec(block);
    const badge = BADGE_RE.exec(block);
    const store = STORE_RE.exec(block);
    const hours = HOURS_RE.exec(block);
    const desc = DESC_RE.exec(block);
    const before = BEFORE_RE.exec(block);
    const after = AFTER_RE.exec(block);
    out.push({
      title: strip(h3[1]),
      platform: badge ? badge[1] : "?",
      left: cnt ? parseInt(cnt[1], 10) : null,
      total: cnt ? parseInt(cnt[2], 10) : null,
      uuid: link ? link[1] : null,
      store: store ? store[1] : null,
      hours_left: hours ? parseInt(hours[1], 10) : null,
      offer: desc ? strip(desc[1]) : "",
      price_before: before ? before[1].trim() : null,
      price_after: after ? after[1].trim() : null,
    });
  }
  return out;
}

export function priceVal(s) {
  if (!s) return null;
  const t = String(s).replace(/[$￥\s]/g, "").toLowerCase();
  if (t === "" || t === "?" || t === "-" || t === "—") return null;
  if (t.includes("free") || t.includes("免费") || t === "0" || t === "0.0" || t === "0.00") return 0;
  const m = t.replace(/[^0-9.]/g, "");
  if (!m) return null;
  const v = parseFloat(m);
  return Number.isNaN(v) ? null : v;
}

/** 判定这个码是不是「终身免费」；先判要不要付钱，再看期限，最后才认 lifetime */
export function classify(offer, before, after) {
  const d = String(offer || "").toLowerCase();
  const a = priceVal(after);
  // 证据串 = offer 文字 + 原价 + 现价（期限词常出现在价格里，如 "$4.99/month → 3 month FREE"）
  const ev = `${d} ${String(before || "").toLowerCase()} ${String(after || "").toLowerCase()}`;

  if (a !== null && a > 0) return ["paid", `❌ 需付费 ${after}`];
  // 订阅 / 试用 / 按月
  if (/trial|试用|per\s*month|\/\s*month|monthly|月度|订阅|subscription/.test(ev)) return ["trial", "❌ 试用/订阅"];
  if (/\d+\s*-?\s*(month|months|mo\b)/.test(ev) || /a\s+month|first\s+month|months?\s+(of\s+)?free|\d+\s*months?\s*free/.test(ev))
    return ["trial", "❌ 按月/限期"];
  if (/annual|yearly/.test(ev)) return ["oneyear", "❌ 仅 1 年（年度）"];
  // 按年
  if (/(^|[^0-9])(1|one|a)\s*-?\s*year|一年|1\s*年|12\s*month|twelve\s*month|year\s+subscription/.test(ev))
    return ["oneyear", "❌ 仅 1 年"];
  // 按天（90 天等）
  if (/\d+\s*-?\s*days?\b|(thirty|sixty|ninety)\s+days/.test(ev)) return ["trial", "❌ 限期（按天）"];
  // 终身
  if (/lifetime|forever|permanent|永久|终身/.test(d)) return ["lifetime", "✅ 终身免费"];
  if (a === 0) return ["free_unknown", "🟡 免费（未标注期限）"];
  return ["unknown", "⚪ 信息不足"];
}

const KIND_ORDER = { lifetime: 0, free_unknown: 1, unknown: 2 };

function bjParts() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return { ymd: t.toISOString().slice(0, 10), hour: t.getUTCHours(), dow: t.getUTCDay() };
}

function bjNow() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return t.toISOString().slice(5, 16).replace("T", " ");
}

async function pushFeishu(env, title, text) {
  const webhook = env.FEISHU_WEBHOOK || FEISHU_WEBHOOK_FALLBACK;
  if (!webhook) return "no-webhook";
  // 先在正文末尾拼上页脚（页脚自带关键词），再决定要不要额外补关键词 —— 避免出现多余的独立关键词行
  const body = `${text}\n\n———\n${KEYWORD}｜Promies 新码监控`;
  const content = body.includes(KEYWORD) ? body : `${KEYWORD}\n\n${body}`;
  const t = title.includes(KEYWORD) ? title : `${KEYWORD} · ${title}`;
  const card = {
    config: { wide_screen_mode: true },
    header: { template: "green", title: { tag: "plain_text", content: t } },
    elements: [{ tag: "div", text: { tag: "lark_md", content: content } }],
  };
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msg_type: "interactive", card }),
  });
  return await res.text();
}

async function loadState(env) {
  try {
    const obj = await env.STATE.get(STATE_KEY);
    if (!obj) return { campaigns: {} };
    return JSON.parse(await obj.text());
  } catch (e) {
    return { campaigns: {} };
  }
}

/** 异常告警：6 小时内只报一次，避免刷屏 */
async function alertFailure(env, state, reason) {
  const nowMs = Date.now();
  if (nowMs - (state.last_alert_at || 0) < 6 * 3600 * 1000) {
    return `FAIL(已告警过，静默): ${reason}`;
  }
  state.last_alert_at = nowMs;
  try { await env.STATE.put(STATE_KEY, JSON.stringify(state)); } catch (e) {}
  const fb = await pushFeishu(env, "⚠️ Promies 监控异常",
    `**监控可能已失效** · ${bjNow()}\n\n原因：${reason}\n\n请检查（网站改版 / 抓取被拦 / 飞书机器人被改）。`);
  return `FAIL(已告警): ${reason}\n[feishu] ${fb}`;
}

async function run(env) {
  const now = bjNow();
  let state = { campaigns: {} };
  try { state = await loadState(env); } catch (e) { state = { campaigns: {} }; }

  let html;
  try {
    const res = await fetch(LIST_URL, { headers: { "user-agent": UA, "accept-language": "zh-CN,zh;q=0.9" } });
    if (!res.ok) return await alertFailure(env, state, `抓取返回 HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    return await alertFailure(env, state, `抓取异常：${String(e).slice(0, 120)}`);
  }

  const cards = parseCards(html);
  if (!cards.length) return await alertFailure(env, state, "解析到 0 张卡片（网站结构可能已改版）");
  const known = state.campaigns || {};
  const fresh = [];
  const restocked = [];

  const skipped = [];
  for (const c of cards) {
    if (/android/i.test(c.platform)) continue;   // 只要 iOS / macOS
    const key = c.uuid || "store:" + (c.store || c.title);
    const [kind, label] = classify(c.offer, c.price_before, c.price_after);
    c.kind = kind;
    c.kind_label = label;
    const prev = known[key];
    const hasCodes = c.left !== null && c.left > 0;
    const wantIt = c.kind === "lifetime" || c.kind === "free_unknown";
    if (prev === undefined) {
      if (hasCodes && wantIt) fresh.push(c);
      else if (hasCodes) skipped.push(c);
    } else if (hasCodes && prev.left !== null && c.left > prev.left) {
      restocked.push([c, prev.left]);
    }
    known[key] = { title: c.title, left: c.left, total: c.total, uuid: c.uuid, store: c.store, offer: c.offer, kind, seen: now };
  }
  state.campaigns = known;
  state.updated = now;
  await env.STATE.put(STATE_KEY, JSON.stringify(state));

  // 每周一 09:00（北京）报一次平安，让"沉默"可被解释
  const bj = bjParts();
  let heartbeat = "";
  if (bj.dow === 1 && bj.hour === 9 && state.last_beat !== bj.ymd) {
    state.last_beat = bj.ymd;
    const lifeN = Object.values(known).filter((v) => v.kind === "lifetime").length;
    const freeN = Object.values(known).filter((v) => v.kind === "free_unknown").length;
    await env.STATE.put(STATE_KEY, JSON.stringify(state));
    const fb = await pushFeishu(env, "Promies 监控正常 ✅",
      `**每周自检** · ${now}\n\n· 当前 ${cards.length} 张卡\n· ✅ 终身免费 ${lifeN} 个\n· 🟡 免费未标注 ${freeN} 个\n\n没消息 = 真的没新码，不是掉线了。`);
    heartbeat = `\n[heartbeat] ${fb}`;
  }

  if (!fresh.length && !restocked.length) {
    return `无「终身/免费」新活动（${cards.length} 张卡；跳过 ${skipped.length} 个付费/试用/1年）${heartbeat}`;
  }

  // 冷启动保护：一次冒出一堆"新活动"说明是首次运行，发基线而不是刷屏
  if (fresh.length >= 8 && !restocked.length) {
    const byKind = {};
    for (const c of fresh) byKind[c.kind_label] = (byKind[c.kind_label] || 0) + 1;
    const brief = Object.entries(byKind).map(([k, v]) => `· ${k}：**${v}** 个`).join("\n");
    const text = `**Promies 监控已上线（Cloudflare 定时版）** · ${now}\n\n首次运行基线：抓到 **${cards.length}** 张卡（iOS **${fresh.length}** 个有码）\n\n${brief}\n\n之后只在新活动/补货时提醒。`;
    const fb = await pushFeishu(env, "Promies 监控已上线 ✅", text);
    return `BASELINE\n${text}\n[feishu] ${fb}`;
  }

  const lines = [`**Promies 有新码** · ${now}`];
  if (fresh.length) {
    lines.push(`\n🆕 **新活动 ${fresh.length} 个**`);
    fresh.sort((a, b) => (KIND_ORDER[a.kind] ?? 3) - (KIND_ORDER[b.kind] ?? 3));
    for (const c of fresh) {
      const left = c.left !== null ? `${c.left}/${c.total}` : "?";
      const url = c.uuid ? `https://www.promies.net/promotion/${c.uuid}` : c.store || "";
      lines.push(`· **${c.title}**  \`${c.platform}\`｜${c.kind_label}｜${c.price_before || "?"} → ${c.price_after || "?"}｜余 ${left}\n  ${c.offer || ""}\n  ${url}`);
    }
  }
  if (restocked.length) {
    lines.push(`\n♻️ **补货 ${restocked.length} 个**`);
    for (const [c, before] of restocked) {
      const url = c.uuid ? `https://www.promies.net/promotion/${c.uuid}` : "";
      lines.push(`· **${c.title}**  \`${c.platform}\`｜${c.kind_label}｜${before} → **${c.left}**\n  ${c.offer || ""}\n  ${url}`);
    }
  }
  const text = lines.join("\n");
  const fb = await pushFeishu(env, "Promies 有新码 🎁", text);
  return `PUSHED\n${text}\n[feishu] ${fb}${heartbeat}`;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.searchParams.get("test") === "1") {
      const fb = await pushFeishu(env, "Promies 监控已接入 ✅", `**${KEYWORD}｜测试消息** · ${bjNow()}\n\nCloudflare 定时版已上线。\n抓到新活动或补货时，会自动推送到这里。`);
      return new Response(`[test] ${fb}\n`, { headers: { "content-type": "text/plain;charset=utf-8" } });
    }
    const out = await run(env);
    return new Response(out + "\n", { headers: { "content-type": "text/plain;charset=utf-8" } });
  },
};

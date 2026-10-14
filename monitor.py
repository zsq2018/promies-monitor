#!/usr/bin/env python3
"""Promies 新码监控 —— 只看 iOS 活动第一页，发现新活动/补货就推飞书"""
import json, os, re, sys, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta

LIST_URL = "https://www.promies.net/promotions?platform=ios"
STATE = os.environ.get("STATE_FILE", "state.json")
WEBHOOK = os.environ.get("FEISHU_WEBHOOK", "").strip()
# 飞书自定义机器人开了「关键词校验」，消息必须含这个词才收得到
KEYWORD = os.environ.get("FEISHU_KEYWORD", "热点").strip()
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

CARD_SPLIT = re.compile(r'<div\s+class="card-container')
H3_RE   = re.compile(r'<h3[^>]*>(.*?)</h3>', re.S)
CNT_RE  = re.compile(r'<span>\s*(\d{1,6})\s*</span>\s*<span>\s*/\s*</span>\s*<span>\s*(\d{1,6})\s*</span>')
LINK_RE = re.compile(r'href="/promotion/([a-f0-9-]{36})"')
BADGE_RE= re.compile(r'badge[^>]*>\s*(iOS|Android)\s*<')
STORE_RE= re.compile(r'href="(https://apps\.apple\.com/[^"]+)"')
DESC_RE = re.compile(r'text-gray-600 text-sm mb-3[^>]*>\s*([^<]{2,300}?)\s*<')
BEFORE_RE = re.compile(r'line-through[^>]*>\s*([^<]{1,12}?)\s*<')
AFTER_RE  = re.compile(r'text-2xl font-bold[^>]*>\s*([^<]{1,12}?)\s*<')
HOURS_RE= re.compile(r'(\d{1,5})\s*hours? left')


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return r.read().decode("utf-8", "ignore")


def parse(html):
    """返回卡片列表；每张卡：title/platform/left/total/uuid/store/hours"""
    cards = []
    for block in CARD_SPLIT.split(html)[1:]:
        m = H3_RE.search(block)
        if not m:
            continue
        title = re.sub(r"<[^>]+>", "", m.group(1)).strip()
        title = title.replace("&amp;", "&").replace("&#39;", "'").replace("&quot;", '"')
        badge = BADGE_RE.search(block)
        cnt = CNT_RE.search(block)
        link = LINK_RE.search(block)
        store = STORE_RE.search(block)
        hrs = HOURS_RE.search(block)
        desc = DESC_RE.search(block)
        before = BEFORE_RE.search(block)
        after = AFTER_RE.search(block)
        cards.append({
            "title": title,
            "offer": (desc.group(1) if desc else "").replace("&amp;", "&").strip(),
            "price_before": before.group(1).strip() if before else None,
            "price_after": after.group(1).strip() if after else None,
            "platform": badge.group(1) if badge else "?",
            "left": int(cnt.group(1)) if cnt else None,
            "total": int(cnt.group(2)) if cnt else None,
            "uuid": link.group(1) if link else None,
            "store": store.group(1) if store else None,
            "hours_left": int(hrs.group(1)) if hrs else None,
        })
    return cards


def price_val(s):
    """把 'FREE' / '$0.99' / '9.99$' / '0' 归一化成数字；认不出返回 None"""
    if not s: return None
    t = str(s).replace("$", "").replace("￥", "").replace(" ", "").strip().lower()
    if t in ("", "?", "-", "—"): return None
    if "free" in t or "免费" in t or t in ("0", "0.0", "0.00"): return 0.0
    m = re.sub(r"[^0-9.]", "", t)
    try: return float(m)
    except ValueError: return None


def classify(offer, before, after):
    """判断这个码是不是「终身免费」—— 返回 (类别, 中文标签)

    规则顺序很重要：先看要不要付钱，再看期限，最后才认 lifetime
    （'at 60% off for lifetime' 含 lifetime 但其实是付费）
    """
    d = (offer or "").lower()
    a = price_val(after)

    if a is not None and a > 0:
        return "paid", f"❌ 需付费 {after}"
    if re.search(r"trial|试用|per\s*month|/\s*month|monthly|月度|订阅", d):
        return "trial", "❌ 试用/订阅"
    if re.search(r"(^|[^0-9])(1|one)\s*-?\s*year|一年|1\s*年", d):
        return "oneyear", "❌ 仅 1 年"
    if re.search(r"lifetime|forever|permanent|永久|终身", d):
        return "lifetime", "✅ 终身免费"
    if a == 0:
        return "free_unknown", "🟡 免费（未标注期限）"
    return "unknown", "⚪ 信息不足"


def load_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"campaigns": {}}


def save_state(st):
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=1, sort_keys=True)


def feishu(text, card=None):
    if not WEBHOOK:
        print("[warn] 未配置 FEISHU_WEBHOOK，跳过推送")
        return False
    if KEYWORD and KEYWORD not in text:
        text = f"{text}\n\n{KEYWORD}"
    if card and KEYWORD:
        t = card.get("header", {}).get("title", {})
        if KEYWORD not in (t.get("content") or ""):
            t["content"] = f"{KEYWORD} · {t.get('content', '')}".strip()
    payload = {"msg_type": "interactive", "card": card} if card else {"msg_type": "text", "content": {"text": text}}
    data = json.dumps(payload, ensure_ascii=False).encode()
    req = urllib.request.Request(WEBHOOK, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read().decode("utf-8", "ignore")
        print("[feishu]", body[:200])
        return '"code":0' in body.replace(" ", "") or '"StatusCode":0' in body.replace(" ", "")
    except Exception as e:
        print("[feishu error]", e)
        return False


def main():
    bj = timezone(timedelta(hours=8))
    now = datetime.now(bj).strftime("%m-%d %H:%M")

    # 测试推送：只发一条测试消息，不动快照
    if os.environ.get("TEST_PUSH", "").lower() in ("1", "true", "yes"):
        print("[test] 发送测试消息")
        card = {"config": {"wide_screen_mode": True},
                "header": {"template": "blue", "title": {"tag": "plain_text", "content": f"{KEYWORD} · Promies 监控已接入 ✅"}},
                "elements": [{"tag": "div", "text": {"tag": "lark_md",
                    "content": f"**{KEYWORD}｜测试消息** · {now}\n\nPromies 新码监控已配置成功。\n抓到新活动或补货时，会自动推送到这里。"}}]}
        ok = feishu("Promies 监控测试", card)
        print("[test] 推送结果:", "成功" if ok else "失败")
        return 0 if ok else 1
    try:
        cards = parse(fetch(LIST_URL))
    except Exception as e:
        print("抓取失败:", e)
        return 1
    print(f"解析到 {len(cards)} 张卡片")
    if not cards:
        print("解析结果为空，跳过（避免误报）")
        return 0

    st = load_state()
    known = st.get("campaigns", {})
    fresh, restocked = [], []

    for c in cards:
        if c["platform"] != "iOS":
            continue
        key = c["uuid"] or ("store:" + (c["store"] or c["title"]))
        prev = known.get(key)
        has_codes = c["left"] is not None and c["left"] > 0
        c["kind"], c["kind_label"] = classify(c.get("offer"), c.get("price_before"), c.get("price_after"))
        if prev is None:
            if has_codes:
                fresh.append(c)
        elif has_codes and prev.get("left") is not None and c["left"] > prev["left"]:
            restocked.append((c, prev["left"]))
        known[key] = {"title": c["title"], "left": c["left"], "total": c["total"],
                      "uuid": c["uuid"], "store": c["store"], "seen": now,
                      "offer": c.get("offer"), "kind": c.get("kind")}

    st["campaigns"] = known
    st["updated"] = now
    save_state(st)

    if not fresh and not restocked:
        print("无新活动/补货")
        return 0

    lines = [f"**Promies 有新码** · {now}"]
    if fresh:
        lines.append(f"\n🆕 **新活动 {len(fresh)} 个**")
        for c in sorted(fresh, key=lambda x: {"lifetime":0,"free_unknown":1,"unknown":2}.get(x["kind"],3)):
            left = f"{c['left']}/{c['total']}" if c["left"] is not None else "?"
            url = f"https://www.promies.net/promotion/{c['uuid']}" if c["uuid"] else (c["store"] or "")
            price = f"{c.get('price_before') or '?'} → {c.get('price_after') or '?'}"
            lines.append(f"· **{c['title']}**  {c['kind_label']}｜{price}｜余 {left}\n  {c.get('offer') or ''}\n  {url}")
    if restocked:
        lines.append(f"\n♻️ **补货 {len(restocked)} 个**")
        for c, before in restocked:
            url = f"https://www.promies.net/promotion/{c['uuid']}" if c["uuid"] else ""
            lines.append(f"· **{c['title']}**  {c['kind_label']}｜{before} → **{c['left']}**\n  {c.get('offer') or ''}\n  {url}")

    text = "\n".join(lines)
    print(text)
    card = {"config": {"wide_screen_mode": True},
            "header": {"template": "green", "title": {"tag": "plain_text", "content": f"{KEYWORD} · Promies 有新码 🎁"}},
            "elements": [{"tag": "div", "text": {"tag": "lark_md", "content": text + f"\\n\\n———\\n{KEYWORD}｜Promies 新码监控"}}]}
    feishu(text, card)
    return 0


if __name__ == "__main__":
    sys.exit(main())

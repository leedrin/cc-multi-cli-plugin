"""把 analyze.py 的报告 dict 渲染成离线单文件 HTML（内联 SVG，无外部依赖）。
单独使用：python report.py <报告.json>  → 同名 .html
"""
import html
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from analyze import MAIN_ROWS, delta, fmt, get_path  # noqa: E402

CSS = """
:root{--canvas:#f2f7fc;--surface:#fff;--subtle:#f7faff;--border:#e1eaf3;--ink:#172033;--ink2:#64748b;--muted:#94a3b8;
--brand:#16b884;--brand-soft:#e1f7ef;--info:#3b82f6;--info-soft:#e8f2ff;--warn:#d89018;--warn-soft:#fff3d8;--danger:#d95f6d;--danger-soft:#ffebee}
@media (prefers-color-scheme:dark){:root{--canvas:#0f1623;--surface:#172033;--subtle:#1c2740;--border:#2a3854;--ink:#e6edf7;--ink2:#9fb0c8;--muted:#6f829e;
--brand-soft:#123b30;--info-soft:#16284a;--warn-soft:#3a2d10;--danger-soft:#3d1b22}}
*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);
font:14px/1.55 Inter,"Segoe UI","Microsoft YaHei UI","Microsoft YaHei","PingFang SC",sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 10px}
.sub{color:var(--ink2);font-size:12px}.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;overflow-x:auto}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.kpi .v{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}.kpi .l{color:var(--ink2);font-size:12px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:6px 10px;border-bottom:1px solid var(--border);text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}th{color:var(--ink2);font-weight:600;font-size:12px}
.b{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600}
.ok{background:var(--brand-soft);color:var(--brand)}.part{background:var(--warn-soft);color:var(--warn)}.no{background:var(--danger-soft);color:var(--danger)}
.down{color:var(--brand)}.up{color:var(--danger)}ul{margin:0;padding-left:20px}svg text{fill:var(--ink2);font-size:11px}
"""


def e(s):
    return html.escape(str(s if s is not None else ""))


def badge(verdict):
    cls = "ok" if verdict.startswith("达到") else "part" if verdict.startswith("部分") else "no"
    return f'<span class="b {cls}">{e(verdict)}</span>'


def dcell(a, b, lower_better=True):
    d = delta(a, b)
    if d == "—":
        return "<td>—</td>"
    good = (b < a) == lower_better
    return f'<td class="{"down" if good else "up"}">{d}</td>'


def bars(rows, title, w=560):
    """rows: [(label, a, b)] 分组横向条形图，A 灰 B 绿。"""
    if not rows:
        return ""
    mx = max(max(a or 0, b or 0) for _, a, b in rows) or 1
    lh, lw = 34, 150
    h = lh * len(rows) + 30
    out = [f'<svg viewBox="0 0 {w} {h}" width="100%" role="img" aria-label="{e(title)}">']
    for i, (lab, a, b) in enumerate(rows):
        y = 20 + i * lh
        out.append(f'<text x="0" y="{y + 13}">{e(lab)[:18]}</text>')
        for j, (v, col) in enumerate(((a, "var(--muted)"), (b, "var(--brand)"))):
            if v is None:
                continue
            bw = (w - lw - 70) * (v / mx)
            out.append(f'<rect x="{lw}" y="{y + j * 12}" width="{bw:.1f}" height="10" rx="3" fill="{col}"/>'
                       f'<text x="{lw + bw + 4:.1f}" y="{y + j * 12 + 9}">{fmt(v)}</text>')
    out.append(f'<text x="{lw}" y="12">■ A（灰）  ■ B（绿）</text></svg>')
    return "".join(out)


def line(points, title, w=560, h=180):
    """points: [(label, value)] 版本时间线折线。"""
    pts = [(lab, v) for lab, v in points if v is not None]
    if len(pts) < 1:
        return ""
    mx = max(v for _, v in pts) or 1
    n = len(points)
    step = (w - 60) / max(n - 1, 1)
    xy = []
    out = [f'<svg viewBox="0 0 {w} {h}" width="100%" role="img" aria-label="{e(title)}"><text x="0" y="12">{e(title)}</text>']
    for i, (lab, v) in enumerate(points):
        x = 30 + i * step
        out.append(f'<text x="{x - 10:.0f}" y="{h - 4}">{e(lab)}</text>')
        if v is not None:
            y = h - 24 - (h - 50) * v / mx
            xy.append((x, y))
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3.5" fill="var(--info)"/><text x="{x + 5:.1f}" y="{y - 6:.1f}">{fmt(v)}</text>')
    if len(xy) > 1:
        out.insert(1, '<polyline fill="none" stroke="var(--info)" stroke-width="2" points="'
                   + " ".join(f"{x:.1f},{y:.1f}" for x, y in xy) + '"/>')
    out.append("</svg>")
    return "".join(out)


def render_html(r):
    A, B = r.get("a"), r["b"]
    H = [f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
         f'<title>{e(r["skill"])} 运行分析</title><style>{CSS}</style></head><body><main>',
         f'<h1>{e(r["skill"])}：{e(r["a_spec"] or "—")} → {e(r["b_spec"])}</h1>',
         f'<div class="sub">生成 {e(r["generated"])} · 归属 {e(r["attribution"])} · 平台 {e(r["platform"])}'
         + "".join(f' · {t} {e(m["span"][0])} ~ {e(m["span"][1])}（会话 {m["sessions"]}，单元 {m["units"]["touched"]}，纯新 {m["units"]["pure"]}）'
                   for t, m in (("A", A), ("B", B)) if m) + "</div>"]
    kp = [("每单元派单", "per_unit.dispatches"), ("每单元子等效输入", "per_unit.sub_cost"), ("每单元主调用", "per_unit.main_calls"),
          ("每单元主等效输入", "per_unit.main_cost"), ("每派单主调用", "main.calls_per_dispatch"), ("压缩/100 派单", "main.compact_per_100")]
    H.append('<h2>关键指标</h2><div class="grid">')
    for lab, p in kp:
        a, b = (get_path(A, p) if A else None), get_path(B, p)
        d = delta(a, b)
        H.append(f'<div class="card kpi"><div class="l">{e(lab)}</div><div class="v">{fmt(b)}</div>'
                 f'<div class="sub">A {fmt(a)} · {e(d)}</div></div>')
    H.append("</div>")
    if r.get("measures_b"):
        H.append('<h2>本版措施</h2><div class="card"><ul>' + "".join(f"<li>{e(m)}</li>" for m in r["measures_b"]) + "</ul></div>")
    if r["expectations"]:
        H.append('<h2>预期核对</h2><div class="card"><table><tr><th>预期</th><th>指标</th><th>目标</th><th>A</th><th>B</th><th>结论</th></tr>')
        for x in r["expectations"]:
            H.append(f'<tr><td>{e(x["desc"])}</td><td>{e(x["metric"])}</td><td>{e(x["op"])} {fmt(x["target"])}</td>'
                     f'<td>{fmt(x["a"])}</td><td>{fmt(x["b"])}</td><td>{badge(x["verdict"])}</td></tr>')
        H.append("</table></div>")
    H.append('<h2>主 agent 与总量</h2><div class="card"><table><tr><th>指标</th><th>A</th><th>B</th><th>变化</th></tr>')
    for name, p in MAIN_ROWS:
        a, b = (get_path(A, p) if A else None), get_path(B, p)
        H.append(f"<tr><td>{e(name)}</td><td>{fmt(a)}</td><td>{fmt(b)}</td>{dcell(a, b)}</tr>")
    H.append("</table></div>")
    cats = list(dict.fromkeys(list(B["cat"]) + list((A or {}).get("cat", {}))))
    H.append('<h2>子 agent：钱花在哪</h2><div class="grid" style="grid-template-columns:1fr 1fr">')
    H.append('<div class="card">' + bars([(k, (A or {}).get("cat", {}).get(k, {}).get("input") if A else None,
                                          B["cat"].get(k, {}).get("cost")) for k in cats], "各类别等效输入合计") + "</div>")
    H.append('<div class="card">' + bars([(k, (A or {}).get("cat", {}).get(k, {}).get("avg_cost") if A else None,
                                          B["cat"].get(k, {}).get("avg_cost")) for k in cats], "各类别单次等效输入") + "</div></div>")
    H.append('<div class="card" style="margin-top:12px"><table><tr><th>类别</th><th>次数</th><th>平均回合</th><th>输入</th><th>单次输入</th>'
             '<th>单次未缓存</th><th>单次等效</th><th>等效占比</th><th>A 单次等效</th><th>变化</th><th>模型</th></tr>')
    for k, v in B["cat"].items():
        va = (A or {}).get("cat", {}).get(k, {}).get("avg_cost") if A else None
        H.append(f'<tr><td>{e(k)}</td><td>{v["n"]}</td><td>{v["turns_avg"]:.1f}</td><td>{fmt(v["input"])}</td><td>{fmt(v["avg_input"])}</td>'
                 f'<td>{fmt(v["avg_fresh"])}</td><td>{fmt(v["avg_cost"])}</td><td>{v["cost_share"]:.0%}</td><td>{fmt(va)}</td>{dcell(va, v["avg_cost"])}'
                 f'<td>{e(", ".join(v["models"]))}</td></tr>')
    H.append("</table></div>")
    pk = list(dict.fromkeys(list(B["per_unit"]["by_cat"]) + list((A or {}).get("per_unit", {}).get("by_cat", {}))))
    H.append('<h2>每单元派单结构</h2><div class="card">' + bars(
        [(k, (A or {}).get("per_unit", {}).get("by_cat", {}).get(k) if A else None, B["per_unit"]["by_cat"].get(k)) for k in pk],
        "每单元各类派单次数") + f'<div class="sub">最深轮次分布：A {e((A or {}).get("per_unit", {}).get("rounds") if A else "—")}；'
        f'B {e(B["per_unit"]["rounds"])}</div></div>')
    H.append('<h2>诊断信号 → 优化杠杆</h2><div class="card"><ul>'
             + ("".join(f"<li><b>{e(s['lever'])}</b>：{e(s['signal'])}</li>" for s in r["signals"]) or "<li>无</li>")
             + '</ul><div class="sub">杠杆说明见技能 references/levers.md</div></div>')
    H.append('<h2>热点派单（B）</h2><div class="card"><table><tr><th>标签</th><th>类别</th><th>单元</th><th>输入</th><th>回合</th><th>模型</th></tr>')
    for h in B["hot_dispatches"]:
        H.append(f'<tr><td>{e(h["label"])}</td><td>{e(h["cat"])}</td><td>{e(h["unit"])}</td><td>{fmt(h["input"])}</td>'
                 f'<td>{e(h["turns"])}</td><td>{e(h["model"])}</td></tr>')
    H.append("</table></div>")
    tl = r["timeline"]
    if tl:
        H.append('<h2>版本时间线</h2><div class="grid" style="grid-template-columns:1fr 1fr">')
        for lab, p in (("每单元派单", "per_unit.dispatches"), ("每单元子 agent 等效输入", "per_unit.sub_cost"),
                       ("每单元主调用", "per_unit.main_calls"), ("每 100 次派单压缩", "main.compact_per_100")):
            H.append('<div class="card">' + line([(t["id"], get_path(t["m"], p) if t["m"] else None) for t in tl], lab) + "</div>")
        H.append('</div><div class="card" style="margin-top:12px"><table><tr><th>版本</th><th>生效</th><th>单元</th><th>措施</th></tr>')
        for t in tl:
            un = f'{len(t["m"]["units"]["basis_units"])}（{t["m"]["units"]["basis"]}）' if t["m"] else "—"
            H.append(f'<tr><td>{e(t["id"])}</td><td>{e(t["from"][:16])}</td><td>{e(un)}</td><td style="text-align:left;white-space:normal">'
                     f'{e("；".join(t["measures"]) or t["title"])}</td></tr>')
        H.append("</table></div>")
    if r["mismatch"]:
        H.append(f'<h2>归属告警</h2><div class="card sub">{len(r["mismatch"])} 次技能加载的指纹与时间段登记不一致或未登记，'
                 '详见 .md / .json。</div>')
    H.append('<p class="sub">口径：references/metrics.md。输入 = 未缓存输入 + 缓存读 + 缓存写；等效输入 = 按 cost_weights 折算成未缓存输入的价格当量。单元少于 3 个的期间结论不可靠。</p></main></body></html>')
    return "".join(H)


if __name__ == "__main__":
    p = Path(sys.argv[1])
    p.with_suffix(".html").write_text(render_html(json.loads(p.read_text(encoding="utf-8"))), encoding="utf-8")
    print(p.with_suffix(".html"))

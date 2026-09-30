"""分析：按版本或时间段对比主 agent 与子 agent 数据，核对预期，给出诊断信号，生成 json/md/html 报告。

用法：
  python analyze.py --skill S --a v4 --b v5                  # 两个版本对比
  python analyze.py --skill S --a 2026-09-20..2026-09-28T15:23:04 --b 2026-09-28T15:23:04..
  python analyze.py --skill S --b v5                         # 单期（无对比），仍出时间线
  可选：--attribution auto|load|time  --platform claude|codex|all  --name 报告名
口径见 references/metrics.md。
"""
import argparse
import collections
import glob
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import classify, load_json, load_profile, load_versions, repo_root, save_json, skill_dir, unit_of  # noqa: E402

DEFAULT_THRESHOLDS = {
    "fix_share": 0.30, "review_per_unit": 2.0, "rework_per_unit": 0.2, "accept_vs_exec": 0.5,
    "calls_per_dispatch": 2.2, "returned_avg": 1500, "prompt_avg": 1500, "compact_per_100": 3.0,
    "deep_round_share": 0.2, "clerical_per_unit": 1.0,
}
# 等效输入：把各类 token 折算成「未缓存输入」的价格倍数，profile.cost_weights 可覆盖
DEFAULT_WEIGHTS = {"in": 1.0, "cw": 1.25, "cr": 0.1, "out": 5.0}


# ------------------------------------------------------------------ 载入与归属
def load_sessions(root, skill, platform):
    out = []
    for f in sorted(glob.glob(str(skill_dir(root, skill) / "data" / "*.json"))):
        s = load_json(f)
        if s and (platform == "all" or s["platform"] == platform):
            out.append(s)
    return out


def version_by_time(versions, ts):
    cur = None
    for v in versions:
        if v["from"] <= (ts or ""):
            cur = v["id"]
    return cur


def attribute(sessions, versions, mode):
    """给每条主调用/事件/派单打上 version，并剔除技能加载前的活动。"""
    hmap = collections.defaultdict(list)
    for v in versions:
        for h in [*(v.get("body_hash") or {}).values(), *v.get("alias_hashes", [])]:
            hmap[h].append(v)
    items = {"calls": [], "events": [], "disp": []}
    mismatch = []
    for s in sessions:
        loads = sorted(s.get("skill_loads") or [], key=lambda x: x["ts"] or "")
        first = loads[0]["ts"] if loads else None
        seg = []  # (ts, version or None)
        for ld in loads:
            vv = [v for v in hmap.get(ld["hash"], []) if v["from"] <= ld["ts"]] or hmap.get(ld["hash"], [])
            vid = vv[-1]["id"] if vv else None
            tv = version_by_time(versions, ld["ts"])
            if vid and tv and vid != tv:
                mismatch.append({"session": s["session"], "ts": ld["ts"], "by_hash": vid, "by_time": tv})
            if not vid:
                mismatch.append({"session": s["session"], "ts": ld["ts"], "by_hash": None, "by_time": tv,
                                 "hash": ld["hash"]})
            seg.append((ld["ts"], vid))

        def ver(ts):
            if mode != "time" and seg:
                cur = None
                for t0, vid in seg:
                    if t0 <= (ts or ""):
                        cur = vid
                if cur:
                    return cur
                if mode == "load":
                    return None
            return version_by_time(versions, ts)

        for kind, key in (("calls", "main_calls"), ("events", "events"), ("disp", "dispatches")):
            for it in s.get(key, []):
                if first and (it.get("ts") or "") < first:
                    continue
                it = dict(it, session=s["session"], platform=s["platform"], version=ver(it.get("ts")))
                items[kind].append(it)
    return items, mismatch


def in_period(it, spec, versions):
    if spec in (None, "", "all"):
        return True
    ids = [v["id"] for v in versions]
    if ".." in spec:
        a, b = spec.split("..", 1)
        if (not a or a in ids) and (not b or b in ids):  # 版本区间，两端都含
            i, j = ids.index(a) if a else 0, ids.index(b) if b else len(ids) - 1
            return it.get("version") in ids[i:j + 1]
        ts = it.get("ts") or ""
        return (not a or ts >= a) and (not b or ts < b)
    if "," in spec:
        return it.get("version") in spec.split(",")
    return it.get("version") == spec


# ------------------------------------------------------------------ 指标
def cost_of(x, w):
    return sum((x.get(k) or 0) * w[k] for k in w)


def enrich(disp, prof):
    w = dict(DEFAULT_WEIGHTS, **(prof.get("cost_weights") or {}))
    for d in disp:
        text = (d.get("prompt_head") or "") + "\n" + "\n".join(d.get("prompt_kv") or [])
        d["cat"] = classify(prof, d.get("agent"), d.get("label"), text)
        d["unit"], d["round"] = unit_of(prof, d.get("label"), text)
        if d["cat"] not in role_cats(prof, "fix") | role_cats(prof, "review"):
            d["round"] = None  # 轮次只认修复/审查派单，文书等正文里的字母不算
        d["input"] = (d.get("in") or 0) + (d.get("cr") or 0) + (d.get("cw") or 0)
        d["fresh"] = (d.get("in") or 0) + (d.get("cw") or 0)
        d["cost"] = cost_of(d, w)


def role_cats(prof, role):
    return set((prof.get("roles") or {}).get(role, []))


def compute(items, spec, versions, prof, first_seen):
    C = [c for c in items["calls"] if in_period(c, spec, versions)]
    E = [e for e in items["events"] if in_period(e, spec, versions)]
    D = [d for d in items["disp"] if in_period(d, spec, versions)]
    ts = [x["ts"] for x in C + D if x.get("ts")]
    m = {"spec": spec, "span": [min(ts), max(ts)] if ts else [None, None],
         "sessions": len({x["session"] for x in C + D})}
    ev = collections.Counter(e["kind"] for e in E)
    main = {k: sum(c.get(k) or 0 for c in C) for k in ("in", "cr", "cw", "out")}
    w = dict(DEFAULT_WEIGHTS, **(prof.get("cost_weights") or {}))
    main.update(calls=len(C), ctx=main["in"] + main["cr"] + main["cw"], cost=cost_of(main, w),
                compact_auto=ev["compact_auto"], compact_manual=ev["compact_manual"],
                compactions=ev["compact_auto"] + ev["compact_manual"], interrupts=ev["interrupt"],
                user_msgs=ev["user_msg"], dispatches=len(D),
                prompt_chars=sum(d.get("prompt_chars") or 0 for d in D),
                returned_chars=sum(d.get("returned_chars") or 0 for d in D))
    nd = max(len(D), 1)
    main.update(calls_per_dispatch=len(C) / nd, prompt_avg=main["prompt_chars"] / nd,
                returned_avg=main["returned_chars"] / nd, compact_per_100=100 * main["compactions"] / nd,
                ctx_per_call=main["ctx"] / max(len(C), 1))
    m["main"] = main
    sub_total = sum(d["input"] for d in D)
    m["sub"] = {"n": len(D), "turns": sum(d.get("turns") or 0 for d in D), "input": sub_total,
                "fresh": sum(d["fresh"] for d in D), "cr": sum(d.get("cr") or 0 for d in D),
                "cost": sum(d["cost"] for d in D),
                "out": sum(d.get("out") or 0 for d in D), "sec": sum(d.get("sec") or 0 for d in D),
                "models": dict(collections.Counter(d.get("model") or "?" for d in D if d.get("model") != "<synthetic>"))}
    cats = collections.defaultdict(list)
    for d in D:
        cats[d["cat"]].append(d)
    m["cat"] = {}
    for name, ds in sorted(cats.items(), key=lambda kv: -sum(d["input"] for d in kv[1])):
        n = len(ds)
        turns = sum(d.get("turns") or 0 for d in ds)
        inp = sum(d["input"] for d in ds)
        cost = sum(d["cost"] for d in ds)
        m["cat"][name] = {"n": n, "turns_avg": turns / n, "input": inp, "avg_input": inp / n,
                          "fresh": sum(d["fresh"] for d in ds), "avg_fresh": sum(d["fresh"] for d in ds) / n,
                          "cost": cost, "avg_cost": cost / n, "cost_share": cost / max(m["sub"]["cost"], 1),
                          "input_per_turn": inp / max(turns, 1), "max_ctx": max(d.get("max_ctx") or 0 for d in ds),
                          "out": sum(d.get("out") or 0 for d in ds),
                          "sec_avg": sum(d.get("sec") or 0 for d in ds) / n,
                          "prompt_avg": sum(d.get("prompt_chars") or 0 for d in ds) / n,
                          "returned_avg": sum(d.get("returned_chars") or 0 for d in ds) / n,
                          "share": inp / max(sub_total, 1),
                          "models": dict(collections.Counter(d.get("model") or "?" for d in ds if d.get("model") != "<synthetic>"))}
    # 单元（工单）口径
    acc = role_cats(prof, "accept")
    units = collections.defaultdict(list)
    for d in D:
        if d["unit"]:
            units[d["unit"]].append(d)
    lo, hi = m["span"]
    pure = sorted(u for u, ds in units.items()
                  if lo and first_seen.get(u, "") >= lo and any(d["cat"] in acc for d in ds))
    basis = pure if len(pure) >= 3 else sorted(units)
    m["units"] = {"touched": len(units), "pure": len(pure), "basis": "pure" if basis is pure else "touched",
                  "basis_units": basis}
    nb = max(len(basis), 1)
    nt = max(len(units), 1)
    bd = [d for u in basis for d in units[u]]
    amort = [d for d in D if not d["unit"]]
    by_cat = collections.Counter(d["cat"] for d in bd)
    rounds = collections.Counter()
    for u in basis:
        rs = [d["round"] for d in units[u] if d["round"]]
        rounds[max(rs) if rs else "a"] += 1
    m["per_unit"] = {
        "dispatches": len(bd) / nb,
        "dispatches_amortized": len(bd) / nb + len(amort) / nt,
        "sub_input": sum(d["input"] for d in bd) / nb,
        "sub_input_amortized": sum(d["input"] for d in bd) / nb + sum(d["input"] for d in amort) / nt,
        "sub_fresh": sum(d["fresh"] for d in bd) / nb,
        "sub_cost": sum(d["cost"] for d in bd) / nb,
        "sub_cost_amortized": sum(d["cost"] for d in bd) / nb + sum(d["cost"] for d in amort) / nt,
        "main_cost": main["cost"] / nt,
        "main_calls": len(C) / nt, "main_ctx": main["ctx"] / nt, "main_out": main["out"] / nt,
        "by_cat": {k: v / nb for k, v in by_cat.most_common()},
        "rounds": dict(sorted(rounds.items())),
    }
    m["role_share"] = {}
    for role in ("first_exec", "review", "fix", "accept", "rework", "clerical"):
        rc = role_cats(prof, role)
        m["per_unit"][role] = sum(1 for d in bd if d["cat"] in rc) / nb
        m["role_share"][role] = sum(d["cost"] for d in D if d["cat"] in rc) / max(m["sub"]["cost"], 1)
    # 修复失控的单元占比：修复派单 ≥ fix_heavy_min 次（默认 3，即修到 d 轮及以后）
    fc = role_cats(prof, "fix")
    heavy = int((prof.get("thresholds") or {}).get("fix_heavy_min", 3))
    m["per_unit"]["fix_heavy_share"] = sum(
        1 for u in basis if sum(1 for d in units[u] if d["cat"] in fc) >= heavy) / nb
    # 升级效能：进入第 2 个修复轮的单元，从第 2 个修复轮开始（含之后的复审、验收）还花了多少。
    # 升级前的版本同样计算，作为「不升级」的对照。
    esc = []
    for u in basis:
        ds = sorted(units[u], key=lambda d: d.get("ts") or "")
        fx = [i for i, d in enumerate(ds) if d["cat"] in fc]
        if len(fx) >= 2:
            tail = ds[fx[1]:]
            esc.append({"unit": u, "fix_after": len(fx) - 1,
                        "cost_after": sum(d["cost"] for d in tail),
                        "cost_fix_after": sum(d["cost"] for d in tail if d["cat"] in fc)})
    ne = max(len(esc), 1)
    m["escalation"] = {
        "units": len(esc), "unit_share": len(esc) / nb,
        "fix_after_avg": sum(e["fix_after"] for e in esc) / ne,
        "closed_in_one": sum(1 for e in esc if e["fix_after"] == 1) / ne,
        "cost_after_avg": sum(e["cost_after"] for e in esc) / ne,
        "cost_per_fix_after": sum(e["cost_fix_after"] for e in esc) / max(sum(e["fix_after"] for e in esc), 1),
        "detail": esc,
    }
    m["hot_dispatches"] = [{"label": d.get("label"), "cat": d["cat"], "unit": d["unit"], "input": d["input"],
                            "turns": d.get("turns"), "model": d.get("model")}
                           for d in sorted(D, key=lambda d: -d["input"])[:10]]
    m["hot_units"] = sorted(({"unit": u, "dispatches": len(ds), "input": sum(d["input"] for d in ds),
                              "max_round": max([d["round"] for d in ds if d["round"]] or ["a"])}
                             for u, ds in units.items()), key=lambda x: -x["input"])[:10]
    return m


def get_path(m, path):
    cur = m
    for p in path.split("."):
        if not isinstance(cur, dict) or p not in cur:
            return None
        cur = cur[p]
    return cur if isinstance(cur, (int, float)) else None


OPS = {"<=": lambda x, t: x <= t, ">=": lambda x, t: x >= t, "<": lambda x, t: x < t,
       ">": lambda x, t: x > t, "==": lambda x, t: x == t}


def check_expectations(exps, ma, mb):
    out = []
    for e in exps:
        def val(m):
            # 本期没有派单，或没有进入第 2 修复轮的单元时，相关指标是空样本，不参与判定
            if not m or not m["sub"]["n"]:
                return None
            if e["metric"].startswith("escalation.") and not m["escalation"]["units"]:
                return None
            return get_path(m, e["metric"])
        vb, va = val(mb), val(ma)
        if vb is None:
            verdict = "无数据"
        elif OPS[e["op"]](vb, e["target"]):
            verdict = "达到"
        elif va is not None and va != 0 and ((e["op"] in ("<", "<=") and vb < va) or (e["op"] in (">", ">=") and vb > va)):
            verdict = f"部分达到（{(vb - va) / abs(va):+.0%}）"
        else:
            verdict = "未达到"
        out.append(dict(e, a=va, b=vb, verdict=verdict))
    return out


def diagnose(m, prof, ma=None):
    th = dict(DEFAULT_THRESHOLDS, **(prof.get("thresholds") or {}))
    pu, main, cat = m["per_unit"], m["main"], m["cat"]
    sig = []

    def add(lever, cond, msg):
        if cond:
            sig.append({"lever": lever, "signal": msg})
    fix_share = sum(v["cost_share"] for k, v in cat.items() if k in role_cats(prof, "fix"))
    add("L1 修复收敛", fix_share > th["fix_share"], f"修复轮占子 agent 等效输入 {fix_share:.0%}（阈值 {th['fix_share']:.0%}）")
    deep = sum(v for k, v in pu["rounds"].items() if k >= "d") / max(sum(pu["rounds"].values()), 1)
    add("L1 修复收敛", deep > th["deep_round_share"], f"{deep:.0%} 的单元修到 d 轮或更后")
    add("L2 复审触发", pu["review"] > th["review_per_unit"], f"每单元审查 {pu['review']:.2f} 次（阈值 {th['review_per_unit']}）")
    add("L3 边做边落盘", pu["rework"] > th["rework_per_unit"], f"每单元补录/返工派单 {pu['rework']:.2f} 次")
    acc = [v for k, v in cat.items() if k in role_cats(prof, "accept")]
    ex = [v for k, v in cat.items() if k in role_cats(prof, "first_exec")]
    if acc and ex:
        r = acc[0]["avg_input"] / max(ex[0]["avg_input"], 1)
        add("L4 验收少读", r > th["accept_vs_exec"], f"单次验收输入是首轮执行的 {r:.0%}（阈值 {th['accept_vs_exec']:.0%}）")
    add("L5 合并派单", main["calls_per_dispatch"] > th["calls_per_dispatch"],
        f"主 agent 每次派单 {main['calls_per_dispatch']:.2f} 次调用（阈值 {th['calls_per_dispatch']}）")
    add("L6 短回答", main["returned_avg"] > th["returned_avg"], f"子 agent 平均回传 {main['returned_avg']:.0f} 字符")
    add("L7 只给路径", main["prompt_avg"] > th["prompt_avg"], f"派单提示平均 {main['prompt_avg']:.0f} 字符")
    add("L8 上下文管理", main["compact_per_100"] > th["compact_per_100"] or main["compact_manual"] > 0,
        f"每 100 次派单压缩 {main['compact_per_100']:.1f} 次，其中手动 {main['compact_manual']}")
    add("L9 文书降级", pu["clerical"] > th["clerical_per_unit"], f"每单元文书 {pu['clerical']:.2f} 次")
    add("L10 中断与确认", main["interrupts"] > 0, f"用户中断 {main['interrupts']} 次")
    if ma:
        # 混杂因素：首轮执行几乎不受编排规则影响，它变贵多半是工单本身变难
        fa = [v for k, v in ma["cat"].items() if k in role_cats(prof, "first_exec")]
        if ex and fa and fa[0].get("avg_cost"):
            r = ex[0]["avg_cost"] / fa[0]["avg_cost"] - 1
            add("样本可比性", abs(r) > 0.3, f"首轮执行单次等效输入 {r:+.0%}，两期工单难度可能不同，对比结论要打折")
        for side, mm in (("A", ma), ("B", m)):
            n = len(mm["units"]["basis_units"])
            add("样本可比性", n < 5, f"{side} 期只有 {n} 个单元，结论不稳")
        for k, v in cat.items():
            va = ma["cat"].get(k)
            if va and va.get("avg_cost") and v["avg_cost"] > 1.5 * va["avg_cost"] and v["n"] >= 3:
                sig.append({"lever": "回归", "signal": f"「{k}」单次等效输入 {va['avg_cost'] / 1e3:.0f}K → {v['avg_cost'] / 1e3:.0f}K"})
    return sig


# ------------------------------------------------------------------ 输出
def fmt(v):
    if v is None:
        return "—"
    if isinstance(v, float) and abs(v) < 100:
        return f"{v:.2f}"
    v = float(v)
    for unit, d in (("M", 1e6), ("K", 1e3)):
        if abs(v) >= d:
            return f"{v / d:.2f}{unit}"
    return f"{v:.0f}"


def delta(a, b):
    if a in (None, 0) or b is None:
        return "—"
    return f"{(b - a) / abs(a):+.0%}"


MAIN_ROWS = [("主 agent 调用", "main.calls"), ("主 agent 上下文（输入+缓存读写）", "main.ctx"),
             ("主 agent 输出", "main.out"), ("每次派单的主调用", "main.calls_per_dispatch"),
             ("派单提示平均字符", "main.prompt_avg"), ("子 agent 回传平均字符", "main.returned_avg"),
             ("压缩（自动+手动）", "main.compactions"), ("每 100 次派单压缩", "main.compact_per_100"),
             ("用户中断", "main.interrupts"), ("子 agent 派单", "main.dispatches"),
             ("子 agent 输入合计（含缓存读）", "sub.input"), ("子 agent 未缓存输入", "sub.fresh"),
             ("子 agent 缓存读", "sub.cr"), ("子 agent 等效输入", "sub.cost"), ("主 agent 等效输入", "main.cost"),
             ("每单元派单（单元内）", "per_unit.dispatches"), ("每单元派单（含分摊）", "per_unit.dispatches_amortized"),
             ("每单元子 agent 输入", "per_unit.sub_input"), ("每单元子 agent 未缓存输入", "per_unit.sub_fresh"),
             ("每单元子 agent 等效输入", "per_unit.sub_cost"), ("每单元主 agent 等效输入", "per_unit.main_cost"), ("每单元主调用", "per_unit.main_calls"),
             ("每单元主上下文", "per_unit.main_ctx"), ("每单元审查", "per_unit.review"),
             ("每单元修复轮", "per_unit.fix"), ("每单元验收", "per_unit.accept"),
             ("修复轮等效占比", "role_share.fix"), ("修到 d 轮及以后的单元占比", "per_unit.fix_heavy_share"),
             ("进入第 2 修复轮的单元", "escalation.units"), ("其后平均再修几轮", "escalation.fix_after_avg"),
             ("其后一轮就收敛的比例", "escalation.closed_in_one"),
             ("其后平均等效输入（含复审验收）", "escalation.cost_after_avg"),
             ("其后每个修复轮等效输入", "escalation.cost_per_fix_after")]


def to_md(r):
    A, B = r.get("a"), r["b"]
    L = [f"# {r['skill']} 运行分析：{r['a_spec'] or '—'} → {r['b_spec']}", "",
         f"生成：{r['generated']}　归属方式：{r['attribution']}　平台：{r['platform']}", ""]
    for tag, m in (("A", A), ("B", B)):
        if m:
            L.append(f"- {tag} `{m['spec']}`：{m['span'][0]} ~ {m['span'][1]}，会话 {m['sessions']}，"
                     f"单元 触及 {m['units']['touched']} / 纯新 {m['units']['pure']}（按 {m['units']['basis']} 归一）")
    if r["expectations"]:
        L += ["", "## 预期核对", "", "| 预期 | 指标 | 目标 | A | B | 结论 |", "|---|---|---|---|---|---|"]
        for e in r["expectations"]:
            L.append(f"| {e['desc']} | `{e['metric']}` | {e['op']} {fmt(e['target'])} | {fmt(e['a'])} | {fmt(e['b'])} | {e['verdict']} |")
    L += ["", "## 主 agent 与总量", "", "| 指标 | A | B | 变化 |", "|---|---|---|---|"]
    for name, p in MAIN_ROWS:
        a = get_path(A, p) if A else None
        b = get_path(B, p)
        L.append(f"| {name} | {fmt(a)} | {fmt(b)} | {delta(a, b)} |")
    L += ["", "## 子 agent 按类别（B）", "", "| 类别 | 次数 | 平均回合 | 输入 | 单次输入 | 单次未缓存 | 每回合输入 | 等效占比 | A 单次输入 | 模型 |",
          "|---|---|---|---|---|---|---|---|---|---|"]
    for k, v in B["cat"].items():
        va = (A or {}).get("cat", {}).get(k) if A else None
        L.append(f"| {k} | {v['n']} | {v['turns_avg']:.1f} | {fmt(v['input'])} | {fmt(v['avg_input'])} | "
                 f"{fmt(v['avg_fresh'])} | {fmt(v['input_per_turn'])} | {v['cost_share']:.0%} | {fmt(va and va['avg_input'])} | "
                 f"{', '.join(v['models'])} |")
    L += ["", "## 每单元结构", "", "| 类别 | A 次/单元 | B 次/单元 |", "|---|---|---|"]
    keys = list(dict.fromkeys(list(B["per_unit"]["by_cat"]) + list(((A or {}).get("per_unit") or {}).get("by_cat", {}))))
    for k in keys:
        L.append(f"| {k} | {fmt((A or {}).get('per_unit', {}).get('by_cat', {}).get(k)) if A else '—'} | "
                 f"{fmt(B['per_unit']['by_cat'].get(k))} |")
    L.append("")
    L.append(f"修到的最深轮次分布：A {(A or {}).get('per_unit', {}).get('rounds', '—') if A else '—'}；B {B['per_unit']['rounds']}")
    L += ["", "## 诊断信号", ""]
    L += [f"- **{s['lever']}**：{s['signal']}" for s in r["signals"]] or ["- 无"]
    L += ["", "## 热点派单（B，按输入）", "", "| 标签 | 类别 | 单元 | 输入 | 回合 |", "|---|---|---|---|---|"]
    for h in B["hot_dispatches"]:
        L.append(f"| {h['label']} | {h['cat']} | {h['unit'] or ''} | {fmt(h['input'])} | {h['turns']} |")
    if r["mismatch"]:
        L += ["", f"## 归属告警（{len(r['mismatch'])} 条）", ""]
        L += [f"- {x['ts']} 会话 {x['session'][:8]}：指纹→{x['by_hash']}，时间→{x['by_time']}" for x in r["mismatch"][:10]]
    L += ["", "## 版本时间线", "", "| 版本 | 生效 | 单元（口径） | 派单/单元 | 子等效输入/单元 | 主调用/单元 | 压缩/100 派单 | 措施 |",
          "|---|---|---|---|---|---|---|---|"]
    for t in r["timeline"]:
        mm = t["m"]
        un = f"{len(mm['units']['basis_units'])}（{mm['units']['basis']}）" if mm else "—"
        L.append(f"| {t['id']} | {t['from'][:16]} | {un} | {fmt(mm and mm['per_unit']['dispatches'])} | "
                 f"{fmt(mm and mm['per_unit']['sub_cost'])} | {fmt(mm and mm['per_unit']['main_calls'])} | "
                 f"{fmt(mm and mm['main']['compact_per_100'])} | {'；'.join(t['measures'])} |")
    return "\n".join(L) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skill", required=True)
    ap.add_argument("--a")
    ap.add_argument("--b", required=True)
    ap.add_argument("--attribution", default="auto", choices=["auto", "load", "time"])
    ap.add_argument("--platform", default="all", choices=["claude", "codex", "all"])
    ap.add_argument("--name")
    args = ap.parse_args()
    root = repo_root()
    prof = load_profile(root, args.skill)
    versions = load_versions(root, args.skill)["versions"]
    sessions = load_sessions(root, args.skill, args.platform)
    if not sessions:
        raise SystemExit("没有采集数据，先跑 collect.py")
    items, mismatch = attribute(sessions, versions, args.attribution)
    enrich(items["disp"], prof)
    first_seen = {}
    for d in sorted(items["disp"], key=lambda d: d.get("ts") or ""):
        if d["unit"]:
            first_seen.setdefault(d["unit"], d.get("ts") or "")
    mb = compute(items, args.b, versions, prof, first_seen)
    ma = compute(items, args.a, versions, prof, first_seen) if args.a else None
    vb = next((v for v in versions if v["id"] == args.b), None)
    timeline = []
    for v in versions:
        mv = compute(items, v["id"], versions, prof, first_seen)
        timeline.append({"id": v["id"], "from": v["from"], "title": v.get("title", ""), "measures": v.get("measures", []),
                         "m": mv if mv["sub"]["n"] or mv["main"]["calls"] else None})
    report = {"skill": args.skill, "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
              "attribution": args.attribution, "platform": args.platform, "a_spec": args.a, "b_spec": args.b,
              "a": ma, "b": mb, "expectations": check_expectations((vb or {}).get("expectations", []), ma, mb),
              "signals": diagnose(mb, prof, ma), "mismatch": mismatch, "timeline": timeline,
              "measures_b": (vb or {}).get("measures", [])}
    name = args.name or re.sub(r"[^\w.\-]+", "_", f"{datetime.now():%Y%m%d-%H%M}_{args.a or 'none'}_vs_{args.b}")
    out = skill_dir(root, args.skill) / "reports" / name
    save_json(str(out) + ".json", report)
    Path(str(out) + ".md").write_text(to_md(report), encoding="utf-8", newline="\n")
    from report import render_html  # noqa: E402
    Path(str(out) + ".html").write_text(render_html(report), encoding="utf-8", newline="\n")
    print(f"报告：{out.relative_to(root)}.{{md,html,json}}")
    print(to_md(report).split("## 子 agent")[0][:4000])


if __name__ == "__main__":
    main()

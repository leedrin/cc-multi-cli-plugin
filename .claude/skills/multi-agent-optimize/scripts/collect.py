"""采集：把 Claude Code / Codex 本地会话记录解析成按会话一份的规范化数据。

用法：python collect.py --skill <技能名> [--since 2026-09-01] [--platform claude|codex|all] [--force]
输出：_skill-metrics/<技能>/data/<平台>-<会话id>.json（增量：源文件没变就跳过）
只存数字和短摘要（派单标签、提示前几行的「键：值」），不存完整提示与回答。
"""
import argparse
import collections
import glob
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import body_hash, load_profile, redact, repo_root, save_json, skill_dir, load_json  # noqa: E402

KV = re.compile(r"^\s*([^：:\n]{1,14})[：:]\s*(.{0,80})", re.M)


def prompt_digest(prompt):
    kv = [f"{k.strip()}：{v.strip()}" for k, v in KV.findall(prompt or "")[:20]]
    return redact((prompt or "")[:200]), [redact(x, 100) for x in kv]


def jl(path):
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def secs(a, b):
    try:
        return (datetime.fromisoformat(b[:19]) - datetime.fromisoformat(a[:19])).total_seconds()
    except (TypeError, ValueError):
        return 0


# ============================== Claude Code ==============================
def claude_project_dir(root):
    slug = re.sub(r"[:\\/._ ]", "-", str(root))
    return Path.home() / ".claude" / "projects" / slug


def usage4(u):
    u = u or {}
    return {k2: u.get(k1, 0) or 0 for k1, k2 in [("input_tokens", "in"), ("cache_read_input_tokens", "cr"),
                                                  ("cache_creation_input_tokens", "cw"), ("output_tokens", "out")]}


def parse_claude_sub(path):
    msgs, tools, models, ts = {}, 0, collections.Counter(), []
    for x in jl(path):
        if x.get("timestamp"):
            ts.append(x["timestamp"])
        if x.get("type") != "assistant":
            continue
        m = x["message"]
        msgs[m.get("id")] = usage4(m.get("usage"))
        models[m.get("model")] += 1
        tools += sum(1 for b in m.get("content", []) if isinstance(b, dict) and b.get("type") == "tool_use")
    tot = collections.Counter()
    for u in msgs.values():
        tot.update(u)
    return {"turns": len(msgs), **{k: tot[k] for k in ("in", "cr", "cw", "out")},
            "max_ctx": max((u["in"] + u["cr"] + u["cw"] for u in msgs.values()), default=0),
            "tools": tools, "model": models.most_common(1)[0][0] if models else None,
            "sec": secs(ts[0], ts[-1]) if ts else 0}


def collect_claude(root, skill, profile, since, force, out_dir):
    pdir = claude_project_dir(root)
    agent_rx = re.compile(profile.get("agent_match", "$^"))
    n_new = n_skip = 0
    for src in sorted(pdir.glob("*.jsonl")):
        sid = src.stem
        sub_dir = pdir / sid / "subagents"
        stamp = [src.stat().st_mtime, src.stat().st_size,
                 max((f.stat().st_mtime for f in sub_dir.glob("*")), default=0) if sub_dir.exists() else 0]
        dst = out_dir / f"claude-{sid}.json"
        old = load_json(dst)
        if old and old.get("stamp") == stamp and not force:
            n_skip += 1
            continue
        L = jl(src)
        loads, calls, events, disp, seen = [], [], [], {}, set()
        returned = collections.Counter()
        for x in L:
            ts = x.get("timestamp")
            t = x.get("type")
            if t == "system" and x.get("subtype") == "compact_boundary":
                trig = (x.get("compactMetadata") or {}).get("trigger", "auto")
                events.append({"ts": ts, "kind": f"compact_{trig}",
                               "pre_tokens": (x.get("compactMetadata") or {}).get("preTokens")})
            elif t == "user" and not x.get("isSidechain"):
                c = x["message"].get("content")
                txt = text_of(c)
                bd = re.match(r"\s*Base directory for this skill:\s*(\S+)", txt)
                if bd and Path(bd.group(1).rstrip("\\/")).name == skill:
                    body = txt.split("\n\n", 1)[1] if "\n\n" in txt else ""
                    body = re.split(r"\n+ARGUMENTS:", body)[0]
                    loads.append({"ts": ts, "hash": body_hash(body)})
                if "<task-notification>" in txt:
                    m = re.search(r"<tool-use-id>([^<]+)</tool-use-id>", txt)
                    if m and x.get("uuid") not in seen:
                        seen.add(x.get("uuid"))
                        returned[m.group(1)] += len(txt)
                elif "[Request interrupted by user" in txt:
                    events.append({"ts": ts, "kind": "interrupt"})
                elif not x.get("isMeta") and isinstance(c, str) and txt.strip() and not txt.lstrip().startswith("<"):
                    events.append({"ts": ts, "kind": "user_msg"})
                elif not x.get("isMeta") and isinstance(c, list) and any(
                        isinstance(b, dict) and b.get("type") == "text" for b in c) and not any(
                        isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
                    events.append({"ts": ts, "kind": "user_msg"})
                if isinstance(c, list):
                    for b in c:
                        if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("tool_use_id"):
                            returned[b["tool_use_id"]] += len(text_of(b.get("content")) if not isinstance(
                                b.get("content"), str) else b["content"])
                            if b["tool_use_id"] in disp and not disp[b["tool_use_id"]].get("end"):
                                disp[b["tool_use_id"]]["end"] = ts
            elif t == "assistant" and not x.get("isSidechain"):
                m = x["message"]
                if m.get("id") not in seen:
                    seen.add(m.get("id"))
                    calls.append({"ts": ts, "model": m.get("model"), **usage4(m.get("usage"))})
                for b in m.get("content", []):
                    if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") in ("Agent", "Task"):
                        inp = b.get("input") or {}
                        head, kv = prompt_digest(inp.get("prompt", ""))
                        disp[b["id"]] = {"id": b["id"], "ts": ts, "agent": inp.get("subagent_type") or "general-purpose",
                                         "label": redact(inp.get("description", ""), 80), "prompt_head": head,
                                         "prompt_kv": kv, "prompt_chars": len(inp.get("prompt", "")),
                                         "bg": bool(inp.get("run_in_background"))}
        # 子代理明细
        if sub_dir.exists():
            for mf in sub_dir.glob("*.meta.json"):
                meta = load_json(mf, {})
                d = disp.get(meta.get("toolUseId"))
                if not d:
                    continue
                d["agent"] = meta.get("agentType") or d["agent"]
                d.update(parse_claude_sub(str(mf)[: -len(".meta.json")] + ".jsonl"))
        for d in disp.values():
            d["returned_chars"] = returned.get(d["id"], 0)
        # 只保留用过本技能或派过本技能子代理的会话
        uses = loads or any(agent_rx.search(d["agent"] or "") for d in disp.values())
        if not uses:
            dst.unlink(missing_ok=True)  # 规则收紧后清掉自己早先误采的文件
            n_skip += 1
            continue
        first_ts = min([c["ts"] for c in calls if c["ts"]] or [""])
        if since and first_ts and first_ts < since and max([c["ts"] for c in calls] or [""]) < since:
            n_skip += 1
            continue
        save_json(dst, {"platform": "claude", "session": sid, "stamp": stamp, "source": str(src),
                        "skill_loads": loads, "main_calls": calls, "events": events,
                        "dispatches": sorted(disp.values(), key=lambda d: d["ts"] or "")})
        n_new += 1
    return n_new, n_skip


# ================================ Codex =================================
def codex_meta(path):
    try:
        with open(path, encoding="utf-8") as f:
            x = json.loads(f.readline())
        return x.get("payload") if x.get("type") == "session_meta" else None
    except (OSError, json.JSONDecodeError):
        return None


def codex_parent(meta):
    src = meta.get("source")
    if isinstance(src, dict) and isinstance(src.get("subagent"), dict):
        ts = src["subagent"].get("thread_spawn")
        if isinstance(ts, dict):
            return ts.get("parent_thread_id")
    return meta.get("parent_thread_id")


def parse_codex_thread(L):
    calls, events, tools, model, ts_all, last_msg = [], [], 0, None, [], ""
    for x in L:
        ts = x.get("timestamp")
        if ts:
            ts_all.append(ts)
        p = x.get("payload") or {}
        pt = p.get("type")
        if x.get("type") == "turn_context":
            model = p.get("model") or model
        elif pt == "token_count" and p.get("info"):
            u = p["info"].get("last_token_usage") or {}
            inp, cached = u.get("input_tokens", 0) or 0, u.get("cached_input_tokens", 0) or 0
            calls.append({"ts": ts, "model": model, "in": inp - cached, "cr": cached,
                          "cw": u.get("cache_write_input_tokens", 0) or 0, "out": u.get("output_tokens", 0) or 0})
        elif pt and "compact" in pt:
            events.append({"ts": ts, "kind": "compact_auto"})
        elif pt == "turn_aborted":
            events.append({"ts": ts, "kind": "interrupt"})
        elif pt == "user_message":
            events.append({"ts": ts, "kind": "user_msg"})
        elif pt == "function_call":
            tools += 1
        elif pt == "agent_message":
            last_msg = p.get("message") or ""
    return calls, events, tools, model, ts_all, last_msg


def collect_codex(root, skill, profile, since, force, out_dir):
    base = Path.home() / ".codex" / "sessions"
    files = glob.glob(str(base / "**" / "rollout-*.jsonl"), recursive=True)
    metas = {}
    for f in files:
        m = codex_meta(f)
        if m and m.get("id"):
            metas[m["id"]] = (f, m)
    children = collections.defaultdict(list)
    for tid, (f, m) in metas.items():
        par = codex_parent(m)
        if par:
            children[par].append(tid)
    rootp = str(root).lower().rstrip("\\/")
    n_new = n_skip = 0
    for tid, (f, m) in metas.items():
        if codex_parent(m) or str(m.get("cwd", "")).lower().rstrip("\\/") != rootp:
            continue
        if since and m.get("timestamp", "") < since:
            continue
        kids = children.get(tid, [])
        stamp = [os.path.getmtime(f), os.path.getsize(f)] + sorted(os.path.getmtime(metas[k][0]) for k in kids)
        dst = out_dir / f"codex-{tid}.json"
        old = load_json(dst)
        if old and old.get("stamp") == stamp and not force:
            n_skip += 1
            continue
        raw = open(f, encoding="utf-8").read()
        if skill not in raw:
            n_skip += 1
            continue
        L = [json.loads(line) for line in raw.splitlines() if line.strip()]
        calls, events, _, _, _, _ = parse_codex_thread(L)
        spawns = []
        for x in L:
            p = x.get("payload") or {}
            if p.get("type") == "function_call" and str(p.get("name", "")).endswith("spawn_agent"):
                try:
                    a = json.loads(p.get("arguments") or "{}")
                except json.JSONDecodeError:
                    a = {}
                spawns.append((x.get("timestamp"), a))
        disp = []
        used = set()
        for k in sorted(kids, key=lambda k: metas[k][1].get("timestamp", "")):
            kf, km = metas[k]
            KL = jl(kf)
            kc, _, ktools, kmodel, kts, klast = parse_codex_thread(KL)
            start = km.get("timestamp", "")
            cand = [i for i, (sts, _) in enumerate(spawns) if i not in used and (sts or "") <= start]
            a = {}
            if cand:
                used.add(cand[-1])
                a = spawns[cand[-1]][1]
            src = km.get("source") or {}
            sub = src.get("subagent") if isinstance(src, dict) else {}
            role = (sub or {}).get("other") or km.get("agent_role") or ((sub or {}).get("thread_spawn") or {}).get("agent_role")
            prompt = a.get("message") or ""
            head, kv = prompt_digest(prompt)
            tot = collections.Counter()
            for c in kc:
                tot.update({kk: c[kk] for kk in ("in", "cr", "cw", "out")})
            disp.append({"id": k, "ts": start, "end": kts[-1] if kts else None,
                         "agent": a.get("agent_type") or a.get("name") or role or "subagent",
                         "label": redact(a.get("task_name") or km.get("agent_nickname") or "", 80),
                         "prompt_head": head, "prompt_kv": kv, "prompt_chars": len(prompt),
                         "returned_chars": len(klast), "turns": len(kc), **dict(tot),
                         "max_ctx": max((c["in"] + c["cr"] + c["cw"] for c in kc), default=0),
                         "tools": ktools, "model": a.get("model") or kmodel,
                         "effort": a.get("reasoning_effort"), "sec": secs(kts[0], kts[-1]) if kts else 0})
        save_json(dst, {"platform": "codex", "session": tid, "stamp": stamp, "source": f,
                        "skill_loads": [], "main_calls": calls, "events": events, "dispatches": disp})
        n_new += 1
    return n_new, n_skip


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skill", required=True)
    ap.add_argument("--platform", default="all", choices=["claude", "codex", "all"])
    ap.add_argument("--since", help="只采集这个时间（ISO，UTC）之后仍有活动的会话")
    ap.add_argument("--root", help="仓库根目录，默认向上找 .git")
    ap.add_argument("--force", action="store_true", help="忽略增量，全部重采")
    a = ap.parse_args()
    root = repo_root(a.root)
    prof = load_profile(root, a.skill)
    out = skill_dir(root, a.skill) / "data"
    out.mkdir(parents=True, exist_ok=True)
    if a.platform in ("claude", "all"):
        print("claude: 新增/更新 %d，跳过 %d" % collect_claude(root, a.skill, prof, a.since, a.force, out))
    if a.platform in ("codex", "all"):
        print("codex:  新增/更新 %d，跳过 %d" % collect_codex(root, a.skill, prof, a.since, a.force, out))


if __name__ == "__main__":
    main()

"""版本台账：登记技能版本、快照被跟踪的文件、记录优化措施与量化预期。

登记当前工作区版本（改完技能、开跑之前）：
  python version.py register --skill S --id v5 --from 2026-09-29T08:00:00Z \
      --measure "验收员只读文件清单和发现核实" --expect "cat.验收.avg_input <= 300000 | 单次验收输入降到 300K"
补登历史版本（只有旧 SKILL.md 备份时）：
  python version.py register --skill S --id v2 --from ... --skill-md path/to/SKILL.md.v2 --measure ...
查看：python version.py list --skill S        检查未登记改动：python version.py check --skill S
列出会话里出现过的技能指纹及归属：python version.py scan --skill S（未登记的用 --alias-hash 补到对应版本）
"""
import argparse
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import body_hash, files_hash, load_json, load_profile, load_versions, repo_root, save_json, skill_dir  # noqa: E402

EXP = re.compile(r"^\s*([\w.\-一-鿿·/]+)\s*(<=|>=|<|>|==)\s*([-\d.eE]+)\s*(?:\|\s*(.*))?$")


def parse_expect(s):
    m = EXP.match(s)
    if not m:
        raise SystemExit(f"预期格式应为「指标 运算符 目标 | 描述」：{s}")
    return {"metric": m.group(1), "op": m.group(2), "target": float(m.group(3)), "desc": (m.group(4) or s).strip()}


def skill_md_paths(root, prof):
    return {k: Path(root, v, "SKILL.md") for k, v in (prof.get("skill_dirs") or {}).items()}


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("register")
    r.add_argument("--skill", required=True)
    r.add_argument("--id", required=True)
    r.add_argument("--from", dest="since", help="生效时间 ISO（UTC），默认现在")
    r.add_argument("--title", default="")
    r.add_argument("--measure", action="append", default=[], help="本版主要优化措施，可多次")
    r.add_argument("--expect", action="append", default=[], help="量化预期：指标 运算符 目标 | 描述")
    r.add_argument("--skill-md", action="append", default=[],
                   help="补登历史版本用：平台=文件，如 claude=bak/SKILL.md.v2；给了就只快照这些文件")
    r.add_argument("--alias-hash", action="append", default=[],
                   help="会话里观察到的技能加载指纹（scan 列出），归到本版；可多次")
    r.add_argument("--no-snapshot", action="store_true", help="补登没有备份的历史版本：只记指纹（--alias-hash）和措施")
    r.add_argument("--replace", action="store_true")
    for name in ("list", "check", "scan"):
        p = sub.add_parser(name)
        p.add_argument("--skill", required=True)
    a = ap.parse_args()
    root = repo_root()
    prof = load_profile(root, a.skill)
    vfile = skill_dir(root, a.skill) / "versions.json"
    vs = load_versions(root, a.skill)

    if a.cmd == "list":
        for v in vs["versions"]:
            print(f"{v['id']:6} {v['from']}  files={v.get('files_hash')}  body={v.get('body_hash')}  {v.get('title', '')}")
            for m in v.get("measures", []):
                print(f"         - {m}")
            for e in v.get("expectations", []):
                print(f"         ? {e['metric']} {e['op']} {e['target']:g}  {e['desc']}")
        return
    if a.cmd == "scan":
        known = {h: v["id"] for v in vs["versions"]
                 for h in [*(v.get("body_hash") or {}).values(), *v.get("alias_hashes", [])]}
        seen = {}
        for f in sorted((skill_dir(root, a.skill) / "data").glob("*.json")):
            for ld in (load_json(f) or {}).get("skill_loads", []):
                first, last, n = seen.get(ld["hash"], (ld["ts"], ld["ts"], 0))
                seen[ld["hash"]] = (min(first, ld["ts"]), max(last, ld["ts"]), n + 1)
        for h, (first, last, n) in sorted(seen.items(), key=lambda kv: kv[1][0]):
            print(f"{h}  首次 {first}  末次 {last}  加载 {n} 次  → {known.get(h, '未登记')}")
        return
    if a.cmd == "check":
        h, _ = files_hash(root, prof.get("tracked_files", []))
        last = vs["versions"][-1] if vs["versions"] else None
        if not last or last.get("files_hash") != h:
            print(f"有未登记的改动：当前 {h}，最后登记 {last and last['id']}={last and last.get('files_hash')}")
            sys.exit(1)
        print(f"当前文件与 {last['id']} 一致（{h}）")
        return

    if any(v["id"] == a.id for v in vs["versions"]) and not a.replace:
        raise SystemExit(f"版本 {a.id} 已存在；要覆盖加 --replace")
    snap = skill_dir(root, a.skill) / "snapshots" / a.id
    if snap.exists():
        shutil.rmtree(snap)
    body, fh = {}, None
    if a.no_snapshot:
        pass
    elif a.skill_md:
        for spec in a.skill_md:
            plat, _, path = spec.partition("=")
            src = Path(path)
            dst = snap / (prof["skill_dirs"][plat]) / "SKILL.md"
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
            body[plat] = body_hash(src.read_text(encoding="utf-8"))
    else:
        fh, files = files_hash(root, prof.get("tracked_files", []))
        for f in files:
            dst = snap / f
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(Path(root, f), dst)
        for plat, p in skill_md_paths(root, prof).items():
            if p.exists():
                body[plat] = body_hash(p.read_text(encoding="utf-8"))
    entry = {"id": a.id, "title": a.title,
             "from": a.since or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "files_hash": fh, "body_hash": body, "alias_hashes": a.alias_hash, "measures": a.measure,
             "expectations": [parse_expect(e) for e in a.expect]}
    vs["versions"] = [v for v in vs["versions"] if v["id"] != a.id] + [entry]
    vs["versions"].sort(key=lambda v: v["from"])
    save_json(vfile, vs)
    print(f"已登记 {a.id}：{'无快照' if a.no_snapshot else '快照 ' + str(snap.relative_to(root))}，正文指纹 {body}，别名 {a.alias_hash}")


if __name__ == "__main__":
    main()

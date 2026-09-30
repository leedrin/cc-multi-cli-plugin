"""multi-agent-optimize 共享工具：路径、配置、脱敏、分类。只用标准库。"""
import fnmatch
import glob
import hashlib
import json
import os
import re
from pathlib import Path

METRICS_DIR = "_skill-metrics"


def repo_root(start=None):
    p = Path(start or os.getcwd()).resolve()
    for q in [p, *p.parents]:
        if (q / ".git").exists():
            return q
    return p


def skill_dir(root, skill):
    return Path(root) / METRICS_DIR / skill


def load_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save_json(path, obj):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")


def load_profile(root, skill):
    prof = load_json(skill_dir(root, skill) / "profile.json")
    if prof is None:
        raise SystemExit(f"缺少 {METRICS_DIR}/{skill}/profile.json，先按 references/profile.md 写一份")
    return prof


def load_versions(root, skill):
    return load_json(skill_dir(root, skill) / "versions.json", {"versions": []})


# ---------- 脱敏：采集数据可能进 git，只留短摘要且去掉疑似密钥 ----------
_SECRET = re.compile(
    r"(sk-[A-Za-z0-9_\-]{12,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._\-]{12,}"
    r"|(?i:(?:api[_-]?key|token|secret|password)\s*[:=]\s*)[\"']?[^\s\"']{6,})"
)


def redact(text, limit=240):
    text = _SECRET.sub("<redacted>", text or "")
    return text[:limit]


# ---------- 技能正文指纹：用来把会话里的「技能加载」对上版本 ----------
def body_hash(text):
    """去掉 frontmatter、统一换行和首尾空白后取 sha1 前 12 位。"""
    t = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    if t.startswith("---\n"):
        end = t.find("\n---\n", 4)
        if end != -1:
            t = t[end + 5:]
    return hashlib.sha1(t.strip().encode("utf-8")).hexdigest()[:12]


def files_hash(root, patterns):
    h = hashlib.sha1()
    files = tracked_files(root, patterns)
    for f in files:
        h.update(f.encode())
        h.update(Path(root, f).read_bytes().replace(b"\r\n", b"\n"))
    return h.hexdigest()[:12], files


def tracked_files(root, patterns):
    out = set()
    for pat in patterns:
        for f in glob.glob(str(Path(root) / pat), recursive=True):
            if os.path.isfile(f):
                out.add(Path(f).relative_to(root).as_posix())
    return sorted(out)


# ---------- 分类：按 profile.categories 顺序匹配第一条 ----------
def _plain(prompt):
    """Codex 的派单提示是加密串（gAAAA 开头），不能拿来匹配。"""
    return "" if (prompt or "").startswith("gAAAA") else (prompt or "")


def classify(profile, agent, label, prompt):
    prompt = _plain(prompt)
    fields = {"agent": agent or "", "label": label or "", "prompt": prompt or ""}
    for c in profile.get("categories", []):
        ok = True
        for k, pat in c.get("when", {}).items():
            if not re.search(pat, fields.get(k, "")):
                ok = False
                break
        if ok:
            return c["name"]
    return "其他"


def unit_of(profile, label, prompt):
    """返回 (基础单元, 轮次)。例：T043b → ('T043','b')。"""
    u = profile.get("unit") or {}
    rx = u.get("regex")
    base = rnd = None
    prompt = _plain(prompt)
    if rx:
        for text in (label or "", prompt or ""):
            m = re.search(rx, text)
            if m:
                base = u.get("prefix", "") + m.group(1)
                rnd = (m.group(2) if m.lastindex and m.lastindex >= 2 else "") or None
                break
    rr = profile.get("round_regex")
    if rr:
        for text in (prompt or "", label or ""):
            m = re.search(rr, text)
            if m:
                rnd = next((g for g in m.groups() if g), rnd)
                break
    if rnd and rnd.isdigit():  # r2/r3 这类数字轮次折成字母：2→b
        rnd = chr(ord("a") + int(rnd) - 1)
    return base, rnd


def glob_match(name, patterns):
    return any(fnmatch.fnmatch(name, p) for p in patterns)

# 写 profile.json

profile 告诉脚本：哪些会话算本技能、派单怎么分类、「单元」是什么、哪些类别扮演哪种角色。放在 `_skill-metrics/<技能名>/profile.json`。完整例子见 `_skill-metrics/openspec-multi-apply/profile.json`。

```json
{
 "skill": "my-skill",
 "skill_dirs": {"claude": ".claude/skills/my-skill", "codex": ".codex/skills/my-skill"},
 "tracked_files": [".claude/skills/my-skill/**/*.md", ".claude/agents/my-*.md",
                   ".codex/skills/my-skill/**/*.md", ".codex/agents/my_*.toml"],
 "agent_match": "^my[-_]",
 "unit": {"name": "任务", "regex": "J(\\d{3})([a-z])?", "prefix": "J"},
 "round_regex": "修复轮[：:]\\s*([b-z])",
 "categories": [
  {"name": "探路", "when": {"agent": "scout"}},
  {"name": "执行·修复轮", "when": {"agent": "worker", "prompt": "修复轮[：:]"}},
  {"name": "执行·首轮", "when": {"agent": "worker"}}
 ],
 "roles": {"first_exec": ["执行·首轮"], "fix": ["执行·修复轮"], "review": ["审查"],
           "accept": ["验收"], "rework": ["补录"], "clerical": ["文书"]},
 "cost_weights": {"in": 1, "cw": 1.25, "cr": 0.1, "out": 5},
 "thresholds": {"fix_share": 0.3}
}
```

## 字段

- `skill_dirs`：两个平台的技能目录。`version.py` 用它算 SKILL.md 正文指纹。
- `tracked_files`：跟技能行为有关的所有文件（技能、references、agent 配置）。版本快照和 `version.py check` 都看这个列表。
- `agent_match`：子 agent 类型名的正则。会话里没加载过技能、但派过匹配的子 agent，也算本技能的会话。
- `unit`：从派单标签（优先）或提示里提取单元编号。第 1 组是编号，第 2 组（可选）是后缀轮次；`prefix` 拼回单元名。单元定得太细（每个修复单一个单元）会让「每单元修复轮」永远是 0，定得太粗会把无关工单混在一起。
- `round_regex`：从提示或标签里提取轮次（任一捕获组），数字轮次会自动折成字母（2→b）。
- `categories`：**按顺序**匹配，第一条命中的生效。`when` 里的 `agent` / `label` / `prompt` 都是正则，同一条里的条件要全部满足。`prompt` 只能匹配到提示开头 200 字和「键：值」行（采集时只存了这些）。具体规则放前面，兜底规则放后面。同名类别可以写多条。Codex 的提示是加密串（`gAAAA` 开头），脚本不拿它匹配，Codex 派单只能靠 `label`（task_name）分类；task_name 多为小写，单元正则要写成 `[Tt](\d{3})`。
- `roles`：把类别映射到六种角色。诊断信号和 `per_unit.<角色>` 依赖它：
  - `first_exec` 首轮执行（也用来判断样本难度）
  - `fix` 修复轮
  - `review` 审查（首审 + 复审）
  - `accept` 验收（也决定「纯新单元」）
  - `rework` 补录、返工这类本可避免的派单
  - `clerical` 文书
- `cost_weights`：等效输入的折算权重。
- `thresholds`：覆盖诊断阈值，键见 `analyze.py` 的 `DEFAULT_THRESHOLDS`。

## 调分类的办法

1. 先写粗规则，跑 `analyze.py --b all`，看「其他」的次数。
2. 看派单标签长什么样：

```bash
python - <<'EOF'
import json, glob, collections
c = collections.Counter()
for f in glob.glob('_skill-metrics/<技能名>/data/*.json'):
    for d in json.load(open(f, encoding='utf-8'))['dispatches']:
        c[(d['agent'], d['label'][:20])] += 1
for k, v in c.most_common(60): print(v, k)
EOF
```

3. 改完 profile 不需要重新采集，直接重跑 `analyze.py`。
4. 在 Windows 上用 Bash heredoc 写 JSON 时反斜杠可能被吃掉，改 profile 请用编辑器或 Write 工具。

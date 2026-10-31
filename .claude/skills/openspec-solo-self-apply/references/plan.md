# 工单图格式

用于拟定 `_solo-self/PLAN.md`。拆单规则和自检见 SKILL.md「一、拆解」。修复轮不单独成行。

```markdown
# 工单图：<change 名>

来源：openspec/changes/<change>/{proposal,design,tasks}.md、specs/
分支：<当前分支>

## 命令表
从 package.json scripts、CLAUDE.md/AGENTS.md 确定，之后所有验收照表。依赖外部条件的命令标出。
| 用途 | 命令 | 备注 |
| --- | --- | --- |
| 单文件测试 | `node --test --test-timeout=120000 <文件>` | |
| 按文件 lint | `npx biome check <文件...>` | |
| 类型检查 | `npm run typecheck` | |
| 全仓门禁 | `npm run check` | 含 banner、lint、未使用导出检查、测试；阶段门禁用 |
| 记录检查 | `node .claude/skills/openspec-solo-self-apply/scripts/records.mjs <skeleton\|ticket\|receipt\|audit>` | 需要 Node；没有时用 references 里的人工自检清单 |
| <项目特有检查> | `<命令>` | <外部条件：如缺生成物 / 缺登录；已尝试 / 不可用> |

## 拆解假设
- <自己做的判断和理由；没有写「无」>

## 工单
| 编号 | 标题 | 类型 | openspec 任务 | 被谁阻塞 | 只动 | 关键验收 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T001 | 抽出 IndexStore 接口 | 代码 | 1.1 | 无 | packages/x/src/store.ts | <单文件测试命令> | 待办 |
```

- 类型：代码 / 表征 / 文档 / 外部（见 SKILL.md「任务类型与并单」）。
- 状态只用：待办 / 进行中 / 完成 / 阻塞 / 放弃。
- 每一行必须对应一个真实的工单文件（待办的单除外，它在写工单时才建文件）和具体的任务编号。两张单合并时不留「并入 Txx」的占位行（`records audit` 会报错）：要么不占这个编号，要么原单挪 `dropped/` 并把状态写成「放弃」。
- `_solo-self/` 根目录只放 PLAN.md、LESSONS.md 和各状态目录；日志、临时脚本放 `_logs/`。
- 「openspec 任务」列出本单覆盖的全部任务编号，含随单勾选的约定类和并入的门禁类；tasks.md 里每条未勾选任务都要出现在某一行，或在拆解假设里说明归属。

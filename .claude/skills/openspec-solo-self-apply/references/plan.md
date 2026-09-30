# 工单图格式

用于拟定 `_solo-self/PLAN.md`。拆单规则和自检见 SKILL.md「一、拆解」。修复轮不单独成行。

```markdown
# 工单图：<change 名>

来源：openspec/changes/<change>/{proposal,design,tasks}.md、specs/

## 拆解假设
- <自己做的判断和理由；没有写「无」>

## 工单
| 编号 | 标题 | openspec 任务 | 被谁阻塞 | 只动 | 关键验收 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| T001 | 抽出 IndexStore 接口 | 1.1 | 无 | packages/x/src/store.ts | bun test packages/x | 待办 |
```

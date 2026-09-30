# 工单图格式

用于编排者拟定 `_tickets/PLAN.md`，交文书员通过文书任务落盘。自检和状态更新规则见 SKILL.md「6. 写 PLAN.md，自检」。修复轮不单独成行。

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

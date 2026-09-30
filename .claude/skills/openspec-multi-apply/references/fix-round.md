# 修复轮派单数据

修复轮不写修复单文件：原工单仍是依据，其「必须保持」全部有效。先红后绿、按类修复、「发现核实」回执格式等固定规则在 `.claude/agents/openspec-executor.md`，这里不重复。派单时 `subagent_type: "openspec-executor"`，description 写「修复 T<编号><轮次>」，prompt 按 SKILL.md「派单格式」写：

```text
仓库根目录：<路径>
落盘文件：_tickets/_receipts/T<编号><轮次>-exec.md（必须写入，下游要读；不要只在最终回答里返回）
工单编号：T<编号>
工单路径：<路径>
修复轮：<b / c / …>
来源：<报告路径> <条目或失败项>
```

- 轮次字母按本单已有修复轮顺延（b、c、d、e），回执为 `_tickets/_receipts/T<编号><轮次>-exec.md`。
- 「来源」写法：
  - 审查后：`_tickets/_receipts/T<编号>-review.md 条目 1、2、4（不处理：3 超范围）`；复审后换成 `T<编号><轮次>-review.md`。
  - 验收不通过后：`_tickets/_receipts/T<编号>-accept.md 失败项 <…>`。
  - 裁决分歧站审查者一边：`<报告路径> 条目 <编号>（裁决：<一句理由>）`。
- b 轮派 `openspec-executor`；c 轮及以后派升级执行者 `openspec-executor-pro`，description 写「修复 T<编号><轮次> 升级」。
- 同一失败现象连续两轮没消除时，数据末尾加一行 `先诊断：<现象，一句话>`。
- 只引用报告路径和条目编号，不把发现原文贴进派单。
- 可改文件 = 原工单「只动」+ 条目点名的文件及其直接测试，执行者配置里已写明，不必再扩范围。

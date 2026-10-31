---
name: openspec-solo-archive
description: 归档一个已实施完的 OpenSpec change，并把 solo-* apply 技能（openspec-solo-reviewed-apply、openspec-solo-self-apply、openspec-solo-apply，工作目录 _solo-rv、_solo-self、_solo）以及 openspec-multi-apply（_tickets）留下的工单、回执、审查材料和日志，一起迁进 openspec/changes/archive/<日期>-<change>/solo-records/，清空根目录让下一个 change 的工单从 T001 重新编号。先检查所有工单完成、tasks.md 全部勾选，再调用 openspec-archive-change（/opsx:archive）归档 change，最后迁移记录并写 MANIFEST.md。用户说「归档 / 收尾归档 / 所有工单都完成了 / 清理工单目录 / 下个 change 开单前清理」，或 solo-* apply 技能报告全部完成后使用。
---
# OpenSpec Solo 归档

两件事按顺序做，缺一不算归档完成：① 用 `openspec-archive-change` 归档 change 本身；② 把工单记录目录迁进归档里的 `solo-records/`。记录跟着 change 走，便于日后回顾；根目录清空，下一个 change 不会和旧工单编号重复。

本技能不修改任何 apply 技能。它只在 apply 做完之后单独运行。

脚本 `scripts/archive-records.mjs`（下称 **archive-records**）：`node .claude/skills/openspec-solo-archive/scripts/archive-records.mjs <check|move> --change <name> [选项]`。零依赖，要 Node。

| 工作目录 | 来自 |
| --- | --- |
| `_solo-rv/` | openspec-solo-reviewed-apply |
| `_solo-self/` | openspec-solo-self-apply |
| `_solo/` | openspec-solo-apply |
| `_tickets/` | openspec-multi-apply |

只迁移 `PLAN.md` 里写着属于这个 change 的目录（`来源：openspec/changes/<name>/…` 或 `# 工单图：<name>`）；属于别的 change、或没有 PLAN.md 的目录一律跳过并说明，不动它。

## 流程

```
归档进度：
- [ ] 1. 确定 change
- [ ] 2. check（只读）
- [ ] 3. 原技能的记录巡检
- [ ] 4. 归档 change
- [ ] 5. 迁移记录
- [ ] 6. 复核并汇报
```

**1. 确定 change**：用户点名就用；否则看当前会话刚做完哪个 change；还不确定就 `openspec list --json` 让用户选，不要猜。

**2. check**：`archive-records check --change <name>`，读输出：

| 退出码 | 含义 | 做什么 |
| --- | --- | --- |
| 0 | 可以归档 | 进 3 |
| 1 | 有 `ERROR` | 不归档。常见原因：有「待办/进行中」的单、`doing/` 或 `open/` 里还有工单、tasks.md 有未勾选又没人认领的任务、变异备份没恢复、回执还是「进行中」。回去用原 apply 技能做完，或把原因告诉用户 |
| 3 | 只有 `CONFIRM`：有阻塞的单（`blocked/`）或「⏸ 待外部条件」/属于阻塞单的任务没勾选 | 把清单列给用户，问一次是否带着这些未完成项归档（它们会随记录一起存档，不会丢）。同意 → 之后每条命令都加 `--allow-unfinished`；不同意 → 停 |

`放弃` 的单只是提示，不拦。

**3. 原技能的记录巡检**（脚本只检查归档条件，不检查记录写得全不全）：目录是 `_solo-rv` → `node .claude/skills/openspec-solo-reviewed-apply/scripts/records.mjs audit --final`；`_solo-self` → `node .claude/skills/openspec-solo-self-apply/scripts/records.mjs audit`。有 `ERROR` 先补齐（按那个技能的规矩），因为归档后记录就进了历史。其他目录没有巡检脚本，跳过。

**4. 归档 change**：调用 `openspec-archive-change` 技能（即 `/opsx:archive`），传入 change 名，按它的步骤走，包括它的 delta spec 同步提问：用户已表态就照做，没表态就用它推荐的选项。它把 `openspec/changes/<name>` 移到 `openspec/changes/archive/YYYY-MM-DD-<name>/`。用户在它的确认环节选了取消，或它失败了 → **到此为止，不迁移记录**。

**5. 迁移记录**：先 `archive-records move --change <name> [--allow-unfinished] --dry-run` 看计划，再去掉 `--dry-run` 真迁。它会：
- 确认 `openspec/changes/<name>` 已不存在、找到 `archive/<日期>-<name>/`（多个取日期最新的，可用 `--archive <路径>` 指定）；
- 把每个属于该 change 的工作目录整个移到 `<归档>/solo-records/<目录名>/`，对比迁移前后的文件数和字节数，校验通过才算完成（跨盘符时先复制再校验再删源）；
- 写 `<归档>/solo-records/MANIFEST.md`：change、移入时间、每个目录的工单数和状态分布、编号范围、全部提交 hash；
- 目标已存在时拒绝覆盖。

迁移中途失败：先读报错。源目录删不掉（被编辑器或进程占用）→ 目标已完整校验，按提示关闭占用后手动删除源目录，**不要重跑 move**。其他校验失败 → 源目录保留，不要手动清理，把报错给用户。

**6. 复核并汇报**：
- `Get-ChildItem` 看仓库根下对应的 `_solo-*`/`_tickets` 已不存在；`openspec/changes/archive/<日期>-<name>/solo-records/` 里有目录和 MANIFEST.md。
- `git status --short` 看一眼：归档目录和迁移后的记录是未跟踪文件，**不要替用户提交**；`.git/info/exclude` 里的 `/_solo-*/` 行保留（下个 change 会重建同名目录）。
- 用大白话汇报：归档到哪里、记录迁了哪些目录和多少文件、带着哪些未完成项归档（如有）、下个 change 的工单从 T001 开始。提醒一句：`LESSONS.md` 和 `_review/MEMORY.md`（审查员记下的复发缺陷）已随目录归档，新 change 不会自动继承，需要的话从 `solo-records/` 里拷回。

## 规矩

- 先 check 后归档，先归档 change 后迁记录：顺序不能反，change 没归档成功就不动工单目录。
- 不删除任何工单、回执、日志：只移动；不覆盖已有归档内容。
- 不提交、不 push；不改 tasks.md、PLAN.md 或任何记录内容。
- 只动 check 确认属于该 change 的目录；其他 change 的残留目录不碰。
- 用用户的语言汇报。

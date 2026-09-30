# 指标口径

所有指标都在 `analyze.py` 的 `compute()` 里算，报告 JSON 里的路径就是写预期时用的指标名（如 `per_unit.fix`、`cat.验收.avg_cost`）。

## 基本量

| 字段 | 含义 |
|---|---|
| `in` | 未缓存输入 token |
| `cr` | 缓存读 token |
| `cw` | 缓存写 token |
| `out` | 输出 token（经 OpenAI 网关的子 agent 记为 0） |
| `input` | `in + cr + cw`，即模型实际看到的上下文总量 |
| `fresh` | `in + cw`，没有命中缓存的部分 |
| `cost` | 等效输入 = `in×1 + cw×1.25 + cr×0.1 + out×5`，把各类 token 折算成未缓存输入的价格当量；权重可在 profile 的 `cost_weights` 覆盖 |

等效输入只在同一模型内可比。跨模型（Haiku 对比 luna）要比价格时，在结论里另外说明单价差异，不要直接拿等效输入比。

比较子 agent 成本优先用 `cost`，其次是 `fresh`。`input` 会被缓存命中率拉偏：v4 起网关缓存命中率翻倍，`input` 几乎不变，`fresh` 却降了 39%。

## 主 agent（`main.*`）

| 指标 | 说明 |
|---|---|
| `calls` | 主 agent 的 API 调用次数（按 message id 去重） |
| `ctx` / `cost` | 上下文总量 / 等效输入 |
| `calls_per_dispatch` | 调用次数 ÷ 派单次数，衡量每次派单的往返开销 |
| `prompt_avg` / `returned_avg` | 派单提示、子 agent 回传的平均字符数 |
| `compactions` / `compact_per_100` | 压缩次数 / 每 100 次派单的压缩次数 |
| `interrupts` / `user_msgs` | 用户中断次数 / 用户消息数 |

## 子 agent（`sub.*`、`cat.<类别>.*`）

`cat` 下每个类别有：`n` 次数、`turns_avg` 平均回合、`input`/`avg_input`、`fresh`/`avg_fresh`、`cost`/`avg_cost`、`cost_share` 等效占比、`input_per_turn`、`max_ctx`、`sec_avg`、`prompt_avg`、`returned_avg`、`models`。

## 单元与分母（`per_unit.*`）

- **单元**：profile 里 `unit.regex` 从派单标签或提示里取出的基础编号，例如工单 T025 族（T025、T025b、T025c2 都归到 T025）。
- **触及单元**：本期有派单的单元。
- **纯新单元**：首次派单在本期内、且本期有验收派单的单元。跨版本的老单元不进分母，避免把上一版的成本算到这一版。
- **分母**：纯新单元 ≥3 时用纯新，否则退回触及单元（报告里会写明用的哪个）。
- `dispatches`：分母单元内的派单 ÷ 单元数。`dispatches_amortized` 再加上没有单元的派单（批次门禁、跨单文书）按触及单元分摊。
- `sub_input` / `sub_fresh` / `sub_cost`：分母单元内子 agent 输入 ÷ 单元数；`sub_cost_amortized` 同上加分摊。
- `main_calls` / `main_ctx` / `main_cost`：主 agent 总量 ÷ 触及单元（主 agent 活动没法拆到单元）。
- `review` / `fix` / `accept` / `rework` / `clerical`：按 profile.roles 映射的类别，每单元次数。
- `by_cat`：每类每单元次数。`rounds`：每个单元修到的最深轮次（只认修复和审查派单上的轮次）。

## 角色占比与升级效能

- `role_share.<角色>`：该角色（profile.roles 映射的全部类别）占子 agent 等效输入的比例。修复轮拆成普通和升级两个类别以后，用 `role_share.fix` 看修复总占比。
- `per_unit.fix_heavy_share`：修复派单 ≥3 次（修到 d 轮及以后）的单元占比，门槛可用 `thresholds.fix_heavy_min` 改。
- `escalation.*`：进入第 2 个修复轮的单元，从第 2 个修复轮起（含之后的复审、验收）的表现。升级前的版本同样计算，就是「不升级」的对照组。
  - `units` / `unit_share`：这类单元的个数 / 占比
  - `fix_after_avg`：其后平均再修几轮（含第 2 轮本身）
  - `closed_in_one`：第 2 轮就收敛的比例
  - `cost_after_avg`：其后平均等效输入；`cost_per_fix_after`：其后每个修复轮的等效输入
  - `detail`：逐单元明细（在报告 JSON 里）

升级执行者换了模型，`cost_*` 是 token 当量，不是钱。判断升级划不划算时要乘上两个模型的单价比。

## 版本归属

- `auto`（默认）：Claude 会话按技能加载的正文指纹切段，指纹对应登记的版本（`body_hash` 或 `alias_hashes`）；对不上的按生效时间归属，并记进「归属告警」。
- `time`：只按 `versions.json` 的 `from` 时间归属。
- `load`：只认指纹，对不上的丢弃。
- 技能加载之前的活动（会话里还没开始用本技能）不计入。

## 预期判定

`达到`：B 满足目标。`部分达到（±x%）`：没达到目标但比 A 往目标方向走了。`未达到`：没达到且没改善。`无数据`：本期没有这个指标（比如没有这个类别的派单）。

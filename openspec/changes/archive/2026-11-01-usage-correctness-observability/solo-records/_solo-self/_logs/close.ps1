param(
  [string]$Id,
  [string]$Hash,
  [string[]]$Tasks,
  [string]$Fixes = '无',
  [string]$Doubt = '无',
  [int]$Commands = 4
)
$root = 'F:\cc-multi-cli-plugin'
Set-Location $root
$f = 'openspec/changes/usage-correctness-observability/tasks.md'
$t = [IO.File]::ReadAllText("$root\$f")
foreach ($i in ($Tasks -join ',' -split ',')) { $t = $t.Replace("- [ ] $i ", "- [x] $i ") }
[IO.File]::WriteAllText("$root\$f", $t)
$ticket = Get-ChildItem _solo-self/doing -Filter "$Id-*.md" | Select-Object -First 1
Add-Content $ticket.FullName "`n## 记录`n- 提交：$Hash`n- 验收：通过（重跑 $Commands 条命令）`n- 修正：$Fixes`n- 存疑：$Doubt"
Move-Item $ticket.FullName _solo-self/done/
$plan = Get-Content _solo-self/PLAN.md -Raw
$lines = $plan -split "`n"
for ($k = 0; $k -lt $lines.Count; $k++) {
  if ($lines[$k].StartsWith("| $Id |")) { $lines[$k] = $lines[$k] -replace '\| (待办|进行中) \|\s*$', '| 完成 |' }
}
[IO.File]::WriteAllText("$root\_solo-self\PLAN.md", ($lines -join "`n"))
$done = (Select-String -Path $f -Pattern '\[x\]').Count
"closed $Id ($done/63 tasks done)"


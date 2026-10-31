Set-Location F:\cc-multi-cli-plugin
$ErrorActionPreference = 'Continue'
"--- banner"; node scripts/banner.mjs --check 2>&1 | Select-Object -Last 2
"--- biome"; npx biome check --error-on-warnings plugins test scripts docs package.json biome.json knip.json 2>&1 | Select-Object -Last 6; "biome exit $LASTEXITCODE"
"--- knip"; npx knip 2>&1 | Select-Object -Last 8; "knip exit $LASTEXITCODE"
"--- tests"; npm test 2>&1 | Select-String -Pattern '^ℹ (tests|pass|fail|skipped)|✖|error TS' | Select-Object -First 30
"--- typecheck:mod (baseline: 8 errors, all in hooks/workers.ts)"; npm run typecheck:mod 2>&1 | Select-String -Pattern 'error TS' | Where-Object { $_.Line -notmatch 'hooks/workers.ts' } | Select-Object -First 20
"--- hook tests"
$j = Start-Job { $env:CLAUDE_CODE_ENABLE_FUNCTION_HOOKS='1'; Set-Location F:\cc-multi-cli-plugin; claude plugin test plugins/multi-core 2>&1 }
if (Wait-Job $j -Timeout 300) { Receive-Job $j | Select-String -Pattern '^\(fail\)|\d+ (pass|fail)$|Ran ' } else { Stop-Job $j; 'hook tests timeout' }

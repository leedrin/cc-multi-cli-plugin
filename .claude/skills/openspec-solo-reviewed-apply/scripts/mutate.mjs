#!/usr/bin/env node
// Mutation and baseline probes for the resident reviewer of openspec-solo-reviewed-apply.
// Zero dependencies. A reviewer's "no findings" is worth nothing unless something was run that
// could have failed; these probes make the tests prove they can fail.
//
//   node mutate.mjs run --files a.ts,b.ts --cmd "<test command>" [--cmd ...]
//        [--lines diff|all] [--max 24] [--budget 900] [--timeout 180] [--only id,id]
//        [--out report.json] [--root _solo-rv]
//        Mutates the added lines of the files one at a time and runs the commands against each
//        mutant. A mutant the tests do not fail on has "survived": a test gap or a defect.
//   node mutate.mjs baseline --impl a.ts,b.ts --cmd "<test command>" [--out report.json]
//        Puts the HEAD version of the implementation files back (an empty file for new ones) and
//        runs the commands: the new tests must fail there ("red-first" check).
//   node mutate.mjs status [--root _solo-rv]    CLEAN, or DIRTY when a run left a file mutated
//   node mutate.mjs recover [--root _solo-rv]   restore every file from the backup
//
// Safety: the originals are copied to <root>/_review/.mutation-backup before the first change and
// restored (and checksum-verified) after every mutant and on exit. The caller must not edit the
// working tree while a probe runs. Always run `status` before committing.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_ROOT = '_solo-rv';
const DEFAULT_MAX = 24;
const DEFAULT_BUDGET_SECONDS = 900;
const DEFAULT_TIMEOUT_SECONDS = 180;
const MAX_PER_LINE = 2;
const SYNTAX_FAILURE = /SyntaxError|ERR_(?:INVALID|UNSUPPORTED)_TYPESCRIPT_SYNTAX/;
const SOME_TESTS_PASSED = /^(?:ℹ|#) pass [1-9]/m;
const SWAPS = {
  '===': '!==',
  '!==': '===',
  '==': '!=',
  '!=': '==',
  '>=': '>',
  '<=': '<',
  '>': '>=',
  '<': '<=',
  '&&': '||',
  '||': '&&',
  true: 'false',
  false: 'true',
  '+': '-',
  '-': '+',
  some: 'every',
  every: 'some',
  max: 'min',
  min: 'max',
  startsWith: 'endsWith',
  endsWith: 'startsWith',
};

// Operators found by pattern. `part` narrows the replaced text to a capture group when set.
const PATTERN_OPS = [
  { op: 'eq-flip', priority: 1, regex: /===|!==|==|!=/g },
  { op: 'cmp-bound', priority: 1, regex: /(?<=\s)(?:>=|<=|>|<)(?=\s)/g },
  { op: 'logic-swap', priority: 1, regex: /&&(?!=)|\|\|(?!=)/g },
  { op: 'bool-flip', priority: 1, regex: /\b(?:true|false)\b/g },
  { op: 'negation-drop', priority: 1, regex: /(?<![\w)\]'"`$])!(?!=)(?=[\w(])/g, drop: true },
  {
    op: 'method-swap',
    priority: 1,
    regex: /\.(?:some|every)\(|Math\.(?:max|min)\(|\.(?:startsWith|endsWith)\(/g,
    word: /some|every|max|min|startsWith|endsWith/,
  },
  { op: 'nullish-number', priority: 1, regex: /(?:\?\?|\|\|)\s*(\d+)\b/g, number: 1 },
  { op: 'arith-swap', priority: 2, regex: /(?<=[\w)\]]\s)[+-](?=\s[\w(])/g },
  { op: 'number-bump', priority: 3, regex: /(?<![\w.$#])(\d+)(?![\w.])/g, number: 1 },
];

function sha(data) {
  return createHash('sha256').update(data).digest('hex');
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    if (rest[index].startsWith('--')) {
      const name = rest[index].slice(2);
      options[name] = options[name] ?? [];
      options[name].push(rest[index + 1] ?? '');
      index++;
    }
  }
  return { command, options };
}

function first(options, name, fallback) {
  return options[name]?.[0] ?? fallback;
}

function listOf(options, name) {
  return (options[name] ?? [])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

// ---------- backup and restore ----------

function backupDir(root) {
  return join(root, '_review', '.mutation-backup');
}

function backupFiles(root, files) {
  const dir = backupDir(root);
  if (existsSync(dir)) {
    throw new Error('上次变异没有恢复：先运行 mutate.mjs recover，再重试');
  }
  mkdirSync(dir, { recursive: true });
  const manifest = files.map((file, index) => {
    copyFileSync(file, join(dir, `${index}.bak`));
    return { file, backup: `${index}.bak`, sha256: sha(readFileSync(file)) };
  });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Puts every backed-up file back and returns the files whose checksum did not match. */
function restoreAll(root) {
  const dir = backupDir(root);
  const manifestFile = join(dir, 'manifest.json');
  if (!existsSync(manifestFile)) {
    return [];
  }
  const bad = [];
  for (const entry of JSON.parse(readFileSync(manifestFile, 'utf8'))) {
    copyFileSync(join(dir, entry.backup), entry.file);
    if (sha(readFileSync(entry.file)) !== entry.sha256) {
      bad.push(entry.file);
    }
  }
  if (bad.length === 0) {
    rmSync(dir, { recursive: true, force: true });
  }
  return bad;
}

function withBackup(root, files, work) {
  const manifest = backupFiles(root, files);
  const onExit = () => restoreAll(root);
  const onInterrupt = () => {
    restoreAll(root);
    process.exit(130);
  };
  process.once('exit', onExit);
  process.once('SIGINT', onInterrupt);
  const outcome = {};
  try {
    outcome.value = work();
  } catch (error) {
    outcome.failure = error;
  }
  const bad = restoreAll(root);
  process.off('exit', onExit);
  process.off('SIGINT', onInterrupt);
  if (bad.length > 0) {
    throw new Error(`恢复校验失败：${bad.join(', ')}（备份保留在 ${backupDir(root)}）`);
  }
  if (outcome.failure) {
    throw outcome.failure;
  }
  return { value: outcome.value, manifest };
}

// ---------- finding mutation sites ----------

function isTracked(file) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', file], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Line numbers added or changed against HEAD, or null for "every line". */
function changedLines(file, mode) {
  if (mode === 'all' || !isTracked(file)) {
    return null;
  }
  const diff = execFileSync('git', ['diff', '-U0', 'HEAD', '--', file], { encoding: 'utf8' });
  const lines = new Set();
  for (const hunk of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let offset = 0; offset < count; offset++) {
      lines.add(Number(hunk[1]) + offset);
    }
  }
  return lines;
}

/** Blanks string contents and trailing comments so operators inside them are not mutated. */
function mask(line) {
  const strings = line.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, (text) => {
    return `${text[0]}${'_'.repeat(text.length - 2)}${text[text.length - 1]}`;
  });
  const comment = strings.indexOf('//');
  return comment < 0 ? strings : strings.slice(0, comment) + ' '.repeat(strings.length - comment);
}

function backticks(line) {
  return (line.match(/(?<!\\)`/g) ?? []).length;
}

function splitCr(raw) {
  const cr = raw.endsWith('\r') ? '\r' : '';
  return { line: raw.slice(0, raw.length - cr.length), cr };
}

function isDeclaration(line) {
  return /^\s*(?:import|export\s+(?:type|interface|\*|\{)|type|interface)\b/.test(line);
}

/** The lines that hold code worth mutating: no comments, imports, types or multi-line templates. */
function codeLines(lines) {
  const result = [];
  let inBlock = false;
  let inTemplate = false;
  for (let index = 0; index < lines.length; index++) {
    const { line, cr } = splitCr(lines[index]);
    const skipBlock = inBlock || /^\s*(?:\/\/|\/\*|\*)/.test(line);
    const skipTemplate = inTemplate || backticks(line) % 2 === 1;
    if (!inBlock && line.includes('/*') && !line.includes('*/')) {
      inBlock = true;
    } else if (inBlock && line.includes('*/')) {
      inBlock = false;
    }
    if (backticks(line) % 2 === 1) {
      inTemplate = !inTemplate;
    }
    if (!(skipBlock || skipTemplate || isDeclaration(line))) {
      result.push({ number: index + 1, text: line, cr });
    }
  }
  return result;
}

function balanced(text) {
  return (text.match(/\(/g) ?? []).length === (text.match(/\)/g) ?? []).length;
}

function patternMutations(text, masked) {
  const found = [];
  for (const spec of PATTERN_OPS) {
    for (const match of masked.matchAll(spec.regex)) {
      found.push(patternMutation(spec, match, text));
    }
  }
  return found.filter(Boolean);
}

function patternMutation(spec, match, text) {
  const token = match[0];
  if (spec.drop) {
    return { op: spec.op, priority: spec.priority, start: match.index, length: 1, replacement: '' };
  }
  if (spec.number !== undefined) {
    const digits = match[spec.number];
    const start = match.index + token.lastIndexOf(digits);
    return {
      op: spec.op,
      priority: spec.priority,
      start,
      length: digits.length,
      replacement: String(Number(digits) + 1),
    };
  }
  const replacement = spec.word
    ? text.slice(match.index, match.index + token.length).replace(spec.word, (word) => SWAPS[word])
    : SWAPS[token];
  return replacement === undefined
    ? undefined
    : {
        op: spec.op,
        priority: spec.priority,
        start: match.index,
        length: token.length,
        replacement,
      };
}

function lineMutations(text, masked) {
  const found = [];
  const indent = /^\s*/.exec(text)[0].length;
  const statement = text.slice(indent);
  const condition = /^(\s*(?:\}\s*else\s+)?if\s*\()(.+)(\)\s*\{)$/.exec(text);
  if (condition && balanced(mask(condition[2]))) {
    for (const value of ['false', 'true']) {
      found.push({
        op: `cond-${value}`,
        priority: 1,
        start: condition[1].length,
        length: condition[2].length,
        replacement: value,
      });
    }
  }
  const returned = /^return\s+(?!undefined\b)[^;]+;$/.exec(statement);
  if (returned) {
    found.push({
      op: 'return-undefined',
      priority: 2,
      start: indent,
      length: statement.length,
      replacement: 'return undefined;',
    });
  }
  const call = /^(?:await\s+)?[\w$.]+\(.*\);$/.test(masked.trim());
  const skipped = /^(?:return|throw|assert|expect|console|super|t\.)/.test(statement);
  if (call && !skipped && balanced(masked)) {
    found.push({
      op: 'call-delete',
      priority: 2,
      start: indent,
      length: statement.length,
      replacement: ';',
    });
  }
  return found;
}

function findMutants(file, mode) {
  const text = readFileSync(file, 'utf8');
  // Split on LF only: a CR stays on its line, so mixed endings round-trip byte for byte.
  const eol = '\n';
  const lines = text.split(eol);
  const wanted = changedLines(file, mode);
  const seen = new Map();
  const mutants = [];
  for (const line of codeLines(lines)) {
    if (wanted && !wanted.has(line.number)) {
      continue;
    }
    const masked = mask(line.text);
    for (const found of [
      ...patternMutations(line.text, masked),
      ...lineMutations(line.text, masked),
    ]) {
      const key = `${file}|${found.op}|${line.text.trim()}`;
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      const id = sha(`${key}|${occurrence}|${found.start}`).slice(0, 8);
      const mutated =
        line.text.slice(0, found.start) +
        found.replacement +
        line.text.slice(found.start + found.length);
      mutants.push({
        id,
        file,
        line: line.number,
        op: found.op,
        priority: found.priority,
        original: line.text.trim(),
        mutated: mutated.trim(),
        mutatedLine: mutated + line.cr,
      });
    }
  }
  return { mutants, lines, eol };
}

/** Deterministic spread: best operators first, at most MAX_PER_LINE per line, stable ids. */
function select(mutants, max, only) {
  if (only.length > 0) {
    return mutants.filter((mutant) => only.includes(mutant.id));
  }
  const ranked = [...mutants].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const perLine = new Map();
  const chosen = [];
  for (const mutant of ranked) {
    const key = `${mutant.file}:${mutant.line}`;
    if (chosen.length < max && (perLine.get(key) ?? 0) < MAX_PER_LINE) {
      perLine.set(key, (perLine.get(key) ?? 0) + 1);
      chosen.push(mutant);
    }
  }
  return chosen.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// ---------- running ----------

function runCommands(commands, timeoutSeconds) {
  const started = Date.now();
  let output = '';
  for (const command of commands) {
    const result = spawnSync(command, {
      shell: true,
      encoding: 'utf8',
      timeout: timeoutSeconds * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    output += `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 0) {
      return {
        ok: false,
        timedOut: result.error?.code === 'ETIMEDOUT',
        output,
        seconds: (Date.now() - started) / 1000,
      };
    }
  }
  return { ok: true, timedOut: false, output, seconds: (Date.now() - started) / 1000 };
}

function classify(run) {
  if (run.ok) {
    return 'survived';
  }
  if (run.timedOut) {
    return 'killed';
  }
  return SYNTAX_FAILURE.test(run.output) && !SOME_TESTS_PASSED.test(run.output)
    ? 'invalid'
    : 'killed';
}

function summarize(results) {
  const count = (state) => results.filter((result) => result.result === state).length;
  return {
    total: results.length,
    killed: count('killed'),
    survived: count('survived'),
    invalid: count('invalid'),
    skipped: count('skipped'),
  };
}

function writeMutant(file, source, mutant) {
  const lines = [...source.lines];
  lines[mutant.line - 1] = mutant.mutatedLine;
  writeFileSync(file, lines.join(source.eol));
}

function probeMutants(selected, sources, options) {
  const results = [];
  const started = Date.now();
  for (const mutant of selected) {
    const base = { id: mutant.id, file: mutant.file, line: mutant.line, op: mutant.op };
    const detail = { original: mutant.original, mutated: mutant.mutated };
    if ((Date.now() - started) / 1000 > options.budget) {
      results.push({ ...base, ...detail, result: 'skipped', seconds: 0 });
      continue;
    }
    const source = sources.get(mutant.file);
    writeMutant(mutant.file, source, mutant);
    const run = runCommands(options.commands, options.timeout);
    writeFileSync(mutant.file, source.lines.join(source.eol));
    results.push({ ...base, ...detail, result: classify(run), seconds: run.seconds });
  }
  return results;
}

function printMutationSummary(report) {
  const { totals } = report;
  console.log(
    `变异：${totals.total} 个，杀死 ${totals.killed}，存活 ${totals.survived}，无效 ${totals.invalid}，未试 ${totals.skipped}`,
  );
  for (const mutant of report.mutants.filter((item) => item.result === 'survived')) {
    console.log(
      `存活 ${mutant.id}｜${mutant.file}:${mutant.line}｜${mutant.op}｜${mutant.original} → ${mutant.mutated}`,
    );
  }
}

function output(report, options) {
  const out = first(options, 'out');
  if (out) {
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`报告：${out}`);
  }
}

function cmdRun(options) {
  const root = first(options, 'root', DEFAULT_ROOT);
  const files = listOf(options, 'files');
  const commands = options.cmd ?? [];
  if (files.length === 0 || commands.length === 0) {
    throw new Error('用法：run --files a.ts,b.ts --cmd "<测试命令>"');
  }
  const tests = files.filter((file) => /\.(?:test|spec)\.|[\\/]tests?[\\/]/.test(file));
  if (tests.length > 0) {
    throw new Error(`不对测试文件做变异：${tests.join(', ')}`);
  }
  const mode = first(options, 'lines', 'diff');
  const found = files.map((file) => ({ file, ...findMutants(file, mode) }));
  const all = found.flatMap((entry) => entry.mutants);
  if (all.length === 0) {
    throw new Error(
      '没有可变异的行：文件无改动，或改动全是注释、类型、导入；用 --lines all 变异整个文件',
    );
  }
  const settings = {
    commands,
    timeout: Number(first(options, 'timeout', DEFAULT_TIMEOUT_SECONDS)),
    budget: Number(first(options, 'budget', DEFAULT_BUDGET_SECONDS)),
  };
  const baseline = runCommands(commands, settings.timeout);
  if (!baseline.ok) {
    console.log('基线不绿：未变异的代码上测试就失败，先让测试通过再审');
    console.log(baseline.output.split('\n').slice(-12).join('\n'));
    return 3;
  }
  const selected = select(all, Number(first(options, 'max', DEFAULT_MAX)), listOf(options, 'only'));
  const sources = new Map(found.map((entry) => [entry.file, entry]));
  const { value, manifest } = withBackup(root, files, () =>
    probeMutants(selected, sources, settings),
  );
  const report = {
    version: 1,
    mode: 'run',
    generatedAt: new Date().toISOString(),
    commands,
    files: manifest.map((entry) => ({ file: entry.file, sha256: entry.sha256 })),
    candidates: all.length,
    baselineSeconds: baseline.seconds,
    totals: summarize(value),
    restored: true,
    mutants: value,
  };
  printMutationSummary(report);
  output(report, options);
  return 0;
}

function headVersion(file) {
  if (!isTracked(file)) {
    return Buffer.alloc(0);
  }
  return execFileSync('git', ['show', `HEAD:${file}`], { maxBuffer: 64 * 1024 * 1024 });
}

function cmdBaseline(options) {
  const root = first(options, 'root', DEFAULT_ROOT);
  const files = listOf(options, 'impl');
  const commands = options.cmd ?? [];
  if (files.length === 0 || commands.length === 0) {
    throw new Error('用法：baseline --impl a.ts,b.ts --cmd "<测试命令>"');
  }
  const timeout = Number(first(options, 'timeout', DEFAULT_TIMEOUT_SECONDS));
  const heads = new Map(files.map((file) => [file, headVersion(file)]));
  const { value } = withBackup(root, files, () => {
    for (const [file, data] of heads) {
      writeFileSync(file, data);
    }
    return runCommands(commands, timeout);
  });
  const result = value.ok ? 'green' : 'red';
  const report = {
    version: 1,
    mode: 'baseline',
    generatedAt: new Date().toISOString(),
    commands,
    files,
    result,
    restored: true,
    tail: value.output.split('\n').slice(-12),
  };
  console.log(
    result === 'red'
      ? '先红校验：红（旧实现下新测试失败，符合预期）'
      : '先红校验：绿（旧实现下测试仍然全过：这些测试锁不住本单的改动）',
  );
  output(report, options);
  return 0;
}

function cmdStatus(options) {
  const dir = backupDir(first(options, 'root', DEFAULT_ROOT));
  if (!existsSync(join(dir, 'manifest.json'))) {
    console.log('CLEAN');
    return 0;
  }
  const files = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).map(
    (entry) => entry.file,
  );
  console.log(`DIRTY：${files.join(', ')}（运行 mutate.mjs recover）`);
  return 1;
}

function cmdRecover(options) {
  const bad = restoreAll(first(options, 'root', DEFAULT_ROOT));
  if (bad.length > 0) {
    console.log(`恢复校验失败：${bad.join(', ')}`);
    return 2;
  }
  console.log('CLEAN');
  return 0;
}

function main(argv) {
  const { command, options } = parseArgs(argv);
  process.chdir(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
  const commands = {
    run: cmdRun,
    baseline: cmdBaseline,
    status: cmdStatus,
    recover: cmdRecover,
  };
  if (!commands[command]) {
    console.log('用法：mutate.mjs run|baseline|status|recover（见文件头部说明）');
    return 1;
  }
  try {
    return commands[command](options);
  } catch (error) {
    console.log(`ERROR ${error.message}`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));

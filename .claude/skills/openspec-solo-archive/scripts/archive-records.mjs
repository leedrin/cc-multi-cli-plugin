#!/usr/bin/env node
// Check and move the work records of the solo-* apply skills into an archived OpenSpec change.
// Zero dependencies. The records live in a root-level work directory (_solo-self, _solo-rv, _solo
// or _tickets); once the change is archived they move to
//   openspec/changes/archive/<date>-<change>/solo-records/<dir>/
// which empties the root, so the next change numbers its tickets from T001 again.
//
//   node archive-records.mjs check --change <name> [--allow-unfinished] [--dir <extra>] [--repo <dir>]
//        Read-only. Exit 0 = ready, 3 = ready after the user confirms unfinished work, 1 = blocked.
//   node archive-records.mjs move  --change <name> [--allow-unfinished] [--archive <path>]
//        [--dry-run] [--dir <extra>] [--repo <dir>]
//        Moves the work directories that belong to the change into the archived change, verifies
//        file counts and sizes, writes solo-records/MANIFEST.md. Run it after the change was archived.

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CANDIDATES = ['_solo-self', '_solo-rv', '_solo', '_tickets'];
const ARCHIVE_ROOT = join('openspec', 'changes', 'archive');
const RECORDS_DIR = 'solo-records';
const EXIT_OK = 0;
const EXIT_BLOCKED = 1;
const EXIT_CONFIRM = 3;

function shown(opts, path) {
  return relative(opts.repo, path).replace(/\\/g, '/');
}

function read(file) {
  return readFileSync(file, 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n');
}

function options(argv) {
  const [command, ...rest] = argv;
  const value = (name) => {
    const index = rest.indexOf(name);
    return index >= 0 ? rest[index + 1] : undefined;
  };
  const extra = rest.flatMap((item, index) => (item === '--dir' ? [rest[index + 1]] : []));
  return {
    command,
    change: value('--change'),
    archive: value('--archive'),
    repo: resolve(value('--repo') ?? process.cwd()),
    extraDirs: extra.filter(Boolean),
    allowUnfinished: rest.includes('--allow-unfinished'),
    dryRun: rest.includes('--dry-run'),
  };
}

function gitRoot(start) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: start,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return start;
  }
}

// ---------- reading the records ----------

function planRows(text) {
  const lines = text.split('\n').filter((line) => line.trim().startsWith('|'));
  const cells = (line) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim());
  const header = lines.find((line) => cells(line)[0] === '编号' && cells(line).includes('状态'));
  if (!header) {
    return [];
  }
  const names = cells(header);
  return lines
    .filter((line) => /^\|\s*T\d+[a-z]?\s*\|/.test(line))
    .map((line) => {
      const row = new Map(cells(line).map((cell, index) => [names[index], cell]));
      return {
        id: row.get('编号') ?? '',
        status: row.get('状态') ?? '',
        tasks: row.get('openspec 任务') ?? '',
      };
    });
}

function ownsChange(planText, change) {
  const escaped = change.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    planText.includes(`openspec/changes/${change}/`) ||
    new RegExp(`^# 工单图[：:]\\s*${escaped}\\s*$`, 'm').test(planText)
  );
}

function listFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

function measure(dir) {
  const files = listFiles(dir);
  return { files: files.length, bytes: files.reduce((sum, file) => sum + statSync(file).size, 0) };
}

function mdNames(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.md')) : [];
}

function commitsOf(dir) {
  const hashes = [];
  for (const name of mdNames(join(dir, 'done'))) {
    const match = /^- 提交[：:]\s*([0-9a-f]{7,40})/m.exec(read(join(dir, 'done', name)));
    if (match) {
      hashes.push(match[1]);
    }
  }
  return hashes;
}

function inProgressReports(dir) {
  const found = [];
  for (const sub of ['_receipts', '_review']) {
    for (const name of mdNames(join(dir, sub))) {
      if (/^进行中/.test(read(join(dir, sub, name)).split('\n')[0] ?? '')) {
        found.push(`${sub}/${name}`);
      }
    }
  }
  return found;
}

function archivedDirOf(repo, change, explicit) {
  if (explicit) {
    return resolve(repo, explicit);
  }
  const root = join(repo, ARCHIVE_ROOT);
  if (!existsSync(root)) {
    return null;
  }
  const matches = readdirSync(root)
    .filter((name) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${change}$`).test(name))
    .sort();
  return matches.length > 0 ? join(root, matches[matches.length - 1]) : null;
}

function tasksFileOf(repo, change) {
  const live = join(repo, 'openspec', 'changes', change, 'tasks.md');
  if (existsSync(live)) {
    return live;
  }
  const archived = archivedDirOf(repo, change);
  return archived && existsSync(join(archived, 'tasks.md')) ? join(archived, 'tasks.md') : null;
}

// ---------- inspection ----------

function add(issues, level, message) {
  issues.push({ level, message });
}

function inspectTasks(repo, change, issues, blockedTasks) {
  const file = tasksFileOf(repo, change);
  if (!file) {
    add(issues, 'INFO', '找不到 tasks.md，跳过任务勾选检查');
    return;
  }
  const open = read(file)
    .split('\n')
    .filter((line) => /^\s*- \[ \]/.test(line));
  const taskId = (line) => /^\s*- \[ \]\s*(\d+(?:\.\d+)*)/.exec(line)?.[1];
  const deferred = open.filter((line) => line.includes('⏸') || blockedTasks.has(taskId(line)));
  const plain = open.length - deferred.length;
  if (plain > 0) {
    add(
      issues,
      'ERROR',
      `tasks.md 里还有 ${plain} 条未勾选且没有「⏸ 待外部条件」标记、也不属于阻塞单的任务`,
    );
  }
  if (deferred.length > 0) {
    add(
      issues,
      'CONFIRM',
      `tasks.md 里有 ${deferred.length} 条任务没有勾选（标了「⏸ 待外部条件」或属于阻塞的单）`,
    );
  }
}

function inspectPlan(dir, issues) {
  const rows = planRows(read(join(dir.path, 'PLAN.md')));
  const count = (...statuses) => rows.filter((row) => statuses.includes(row.status));
  const unfinished = count('待办', '进行中');
  if (unfinished.length > 0) {
    add(
      issues,
      'ERROR',
      `${dir.name}/PLAN.md 里还有未完成的单：${unfinished.map((r) => r.id).join(', ')}`,
    );
  }
  if (count('阻塞').length > 0) {
    add(
      issues,
      'CONFIRM',
      `${dir.name}/ 里有阻塞的单：${count('阻塞')
        .map((r) => r.id)
        .join(', ')}`,
    );
  }
  if (count('放弃').length > 0) {
    add(
      issues,
      'INFO',
      `${dir.name}/ 里有放弃的单：${count('放弃')
        .map((r) => r.id)
        .join(', ')}`,
    );
  }
  return rows;
}

function inspectDir(dir, issues) {
  const rows = inspectPlan(dir, issues);
  for (const sub of ['doing', 'open']) {
    const names = mdNames(join(dir.path, sub));
    if (names.length > 0) {
      add(issues, 'ERROR', `${dir.name}/${sub}/ 里还有工单文件：${names.join(', ')}`);
    }
  }
  const blocked = mdNames(join(dir.path, 'blocked'));
  if (blocked.length > 0) {
    add(issues, 'CONFIRM', `${dir.name}/blocked/ 里有工单：${blocked.join(', ')}`);
  }
  if (existsSync(join(dir.path, '_review', '.mutation-backup'))) {
    add(
      issues,
      'ERROR',
      `${dir.name}/_review/.mutation-backup 还在：变异没有恢复，先运行 mutate.mjs recover`,
    );
  }
  const running = inProgressReports(dir.path);
  if (running.length > 0) {
    add(issues, 'ERROR', `${dir.name}/ 里还有「进行中」的文件：${running.join(', ')}`);
  }
  return rows;
}

function findDirs(opts, issues) {
  const dirs = [];
  for (const name of [...CANDIDATES, ...opts.extraDirs]) {
    const path = join(opts.repo, name);
    if (!existsSync(path)) {
      continue;
    }
    const plan = join(path, 'PLAN.md');
    if (!existsSync(plan)) {
      add(issues, 'INFO', `跳过 ${name}/：没有 PLAN.md，无法确认属于哪个 change`);
    } else if (ownsChange(read(plan), opts.change)) {
      dirs.push({ name, path });
    } else {
      add(issues, 'INFO', `跳过 ${name}/：PLAN.md 不属于 change「${opts.change}」`);
    }
  }
  return dirs;
}

function inspect(opts) {
  const issues = [];
  const dirs = findDirs(opts, issues);
  const summaries = [];
  for (const dir of dirs) {
    const rows = inspectDir(dir, issues);
    summaries.push({ ...dir, rows, ...measure(dir.path), commits: commitsOf(dir.path) });
  }
  const blockedTasks = new Set(
    summaries
      .flatMap((dir) => dir.rows)
      .filter((row) => row.status === '阻塞')
      .flatMap((row) => row.tasks.match(/\d+(?:\.\d+)*/g) ?? []),
  );
  inspectTasks(opts.repo, opts.change, issues, blockedTasks);
  return { issues, dirs: summaries };
}

function verdict(issues, allowUnfinished) {
  const errors = issues.filter((issue) => issue.level === 'ERROR');
  const confirms = issues.filter((issue) => issue.level === 'CONFIRM');
  if (errors.length > 0) {
    return EXIT_BLOCKED;
  }
  return confirms.length > 0 && !allowUnfinished ? EXIT_CONFIRM : EXIT_OK;
}

function printIssues(issues, allowUnfinished) {
  for (const issue of issues) {
    const level = issue.level === 'CONFIRM' && allowUnfinished ? 'INFO(已确认)' : issue.level;
    console.log(`${level} ${issue.message}`);
  }
}

function printSummary(dirs) {
  for (const dir of dirs) {
    const counts = new Map();
    for (const row of dir.rows) {
      counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
    }
    const text = [...counts].map(([status, n]) => `${status} ${n}`).join('，');
    console.log(`目录 ${dir.name}/：${dir.rows.length} 张单（${text}），${dir.files} 个文件`);
  }
}

// ---------- commands ----------

function cmdCheck(opts) {
  const { issues, dirs } = inspect(opts);
  printIssues(issues, opts.allowUnfinished);
  printSummary(dirs);
  if (dirs.length === 0) {
    console.log('INFO 没有属于这个 change 的工单记录目录：只需要归档 change 本身');
  }
  const code = verdict(issues, opts.allowUnfinished);
  const label = {
    [EXIT_OK]: 'OK 可以归档',
    [EXIT_CONFIRM]: 'NEEDS-CONFIRM 有未完成项，需用户确认后加 --allow-unfinished',
    [EXIT_BLOCKED]: 'FAIL 先处理 ERROR',
  };
  console.log(label[code]);
  return code;
}

function removeSource(dir) {
  try {
    rmSync(dir.path, { recursive: true, force: true });
  } catch (error) {
    throw new Error(
      `${dir.name} 已完整复制并校验，但源目录删不掉（被编辑器或进程占用？）：关闭后手动删除 ${dir.path}，不要重跑 move。原因：${error.message}`,
    );
  }
}

function moveDir(dir, destRoot) {
  const target = join(destRoot, dir.name);
  const before = measure(dir.path);
  mkdirSync(destRoot, { recursive: true });
  try {
    renameSync(dir.path, target);
  } catch {
    cpSync(dir.path, target, { recursive: true, errorOnExist: true, force: false });
    const copied = measure(target);
    if (copied.files !== before.files || copied.bytes !== before.bytes) {
      throw new Error(
        `复制校验失败：${dir.name}（源 ${before.files} 个/${before.bytes} 字节，目标 ${copied.files} 个/${copied.bytes} 字节）；源目录已保留`,
      );
    }
    removeSource(dir);
  }
  const after = measure(target);
  if (after.files !== before.files || after.bytes !== before.bytes || existsSync(dir.path)) {
    throw new Error(`迁移校验失败：${dir.name}`);
  }
  return { ...before, target };
}

function manifest(opts, archive, moved) {
  const lines = [
    '# 工单记录归档',
    '',
    `- change：${opts.change}`,
    `- 归档目录：${shown(opts, archive)}`,
    `- 移入时间：${new Date().toISOString()}`,
    '- 说明：这些是 solo-* apply 技能当时的工单、回执、审查材料和日志，原目录已清空，下一个 change 的工单从 T001 重新编号。',
    '',
  ];
  for (const dir of moved) {
    const statuses = new Map();
    for (const row of dir.rows) {
      statuses.set(row.status, (statuses.get(row.status) ?? 0) + 1);
    }
    const ids = dir.rows.map((row) => row.id).sort();
    lines.push(
      `## ${dir.name}/`,
      `- 工单：${dir.rows.length} 张（${[...statuses].map(([s, n]) => `${s} ${n}`).join('，')}），编号 ${ids[0] ?? '-'} … ${ids[ids.length - 1] ?? '-'}`,
      `- 文件：${dir.files} 个，${dir.bytes} 字节`,
      `- 提交：${dir.commits.length > 0 ? dir.commits.join(', ') : '无'}`,
      '',
    );
  }
  return lines.join('\n');
}

function cmdMove(opts) {
  const { issues, dirs } = inspect(opts);
  printIssues(issues, opts.allowUnfinished);
  const code = verdict(issues, opts.allowUnfinished);
  if (code !== EXIT_OK) {
    console.log('FAIL 检查没通过，不迁移（先跑 check 看原因）');
    return EXIT_BLOCKED;
  }
  if (existsSync(join(opts.repo, 'openspec', 'changes', opts.change))) {
    console.log(
      `FAIL change「${opts.change}」还在 openspec/changes/ 下：先完成 openspec-archive-change，再迁移记录`,
    );
    return EXIT_BLOCKED;
  }
  const archive = archivedDirOf(opts.repo, opts.change, opts.archive);
  if (!(archive && existsSync(archive))) {
    console.log(`FAIL 找不到归档目录 ${ARCHIVE_ROOT}/<日期>-${opts.change}（可用 --archive 指定）`);
    return EXIT_BLOCKED;
  }
  if (dirs.length === 0) {
    console.log('OK 没有需要迁移的工单记录目录');
    return EXIT_OK;
  }
  const destRoot = join(archive, RECORDS_DIR);
  const clash = dirs.filter((dir) => existsSync(join(destRoot, dir.name)));
  if (clash.length > 0) {
    console.log(
      `FAIL 归档里已有 ${RECORDS_DIR}/${clash.map((dir) => dir.name).join(', ')}：不覆盖，先人工处理`,
    );
    return EXIT_BLOCKED;
  }
  if (opts.dryRun) {
    for (const dir of dirs) {
      console.log(
        `DRY ${dir.name}/ → ${shown(opts, destRoot)}/${dir.name}/（${dir.files} 个文件）`,
      );
    }
    return EXIT_OK;
  }
  const moved = dirs.map((dir) => ({ ...dir, ...moveDir(dir, destRoot) }));
  writeFileSync(join(destRoot, 'MANIFEST.md'), manifest(opts, archive, moved));
  for (const dir of moved) {
    console.log(`MOVED ${dir.name}/ → ${shown(opts, dir.target)}（${dir.files} 个文件，已校验）`);
  }
  console.log(
    `OK 已写入 ${shown(opts, join(destRoot, 'MANIFEST.md'))}；根目录已清空，下个 change 从 T001 起`,
  );
  return EXIT_OK;
}

function main(argv) {
  const opts = options(argv);
  if (!opts.change || !['check', 'move'].includes(opts.command ?? '')) {
    console.log(
      '用法：archive-records.mjs check|move --change <name> [--allow-unfinished] [--archive <path>] [--dry-run] [--dir <extra>] [--repo <dir>]',
    );
    return 2;
  }
  opts.repo = gitRoot(opts.repo);
  return opts.command === 'check' ? cmdCheck(opts) : cmdMove(opts);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}

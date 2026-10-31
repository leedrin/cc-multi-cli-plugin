#!/usr/bin/env node
// Structure checks for the records written by openspec-solo-self-apply (tickets, receipts, PLAN.md).
// Zero dependencies. Why it exists: after context compaction the format files are no longer in
// context, so records drift shorter and shorter. This script is the gate that does not forget.
//
//   node records.mjs skeleton ticket|receipt      print the template to fill in (never write from memory)
//   node records.mjs ticket <file> [--done]       check one ticket (--done also checks the 记录 block)
//   node records.mjs receipt <file> [--complete]  check one receipt (--complete: review + acceptance present)
//   node records.mjs audit [--root _solo-self]    check every record against PLAN.md
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TICKET_SECTIONS = ['目标', '动手前先读', '边界', '验收', '为什么这样验收'];
const EXECUTION_FIELDS = ['状态', '文件清单', '先红', '验收', '存疑'];
const FIX_FIELDS = ['来源', '先红', '文件清单', '验收'];
const ACCEPT_FIELDS = ['越界', '测试篡改', '结论'];
const STUCK_FIELDS = ['症状', '根因分析', '试过', '建议'];
const SHRINK_RATIO = 0.5;

function read(file) {
  return readFileSync(file, 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n');
}

function sectionsOf(text) {
  const result = [];
  for (const line of text.split('\n')) {
    const match = /^## (.+?)\s*$/.exec(line);
    if (match) {
      // The skeleton annotates some headings with a trailing （…）hint; it is not part of the title.
      result.push({ title: match[1].replace(/\s+（[^）]*）$/, ''), lines: [] });
    } else if (result.length > 0) {
      result[result.length - 1].lines.push(line);
    }
  }
  return result.map((section) => ({ title: section.title, body: section.lines.join('\n') }));
}

/** A field counts only when it has a value, or content on the line right after it. */
function hasField(body, name) {
  const lines = body.split('\n');
  const pattern = new RegExp(`(?:^|[；;])[ \\t]*(?:[-*][ \\t]+)?${name}[：:][ \\t]*(.*)$`);
  for (let index = 0; index < lines.length; index++) {
    const match = pattern.exec(lines[index]);
    if (match) {
      const value = match[1].trim();
      const next = (lines[index + 1] ?? '').trim();
      return (value !== '' && !/^<[^>]*>$/.test(value)) || next !== '';
    }
  }
  return false;
}

function fieldValue(body, name) {
  const match = new RegExp(`(?:^|[；;])[ \\t]*(?:[-*][ \\t]+)?${name}[：:][ \\t]*(.*)$`, 'm').exec(
    body,
  );
  return match ? match[1].trim() : '';
}

/** Template placeholders look like <本轮改动…>: angle brackets holding Chinese text, outside code fences. */
function placeholderErrors(text) {
  const errors = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('```')) {
      fenced = !fenced;
    } else if (!fenced && /<[^<>\n]*[\u4e00-\u9fff][^<>\n]*>/.test(line)) {
      errors.push(`残留模板占位符：${line.trim().slice(0, 40)}`);
    }
  }
  return errors.slice(0, 3);
}

function missingFields(body, names, label) {
  return names.filter((name) => !hasField(body, name)).map((name) => `${label}缺少字段「${name}」`);
}

function commitExists(hash) {
  try {
    execFileSync('git', ['cat-file', '-e', `${hash}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function checkRecordBlock(body) {
  const errors = missingFields(body, ['验收', '修正', '存疑'], '「记录」');
  const hash = /^[0-9a-f]{7,40}\b/.exec(fieldValue(body, '提交'))?.[0];
  if (!hash) {
    errors.push('「记录」的「提交」不是有效的 commit hash');
  } else if (!commitExists(hash)) {
    errors.push(`「记录」里的提交 ${hash} 在 git 中不存在`);
  }
  return errors;
}

function checkTicketHeader(text) {
  const errors = [];
  if (!/^# T\d+[a-z]?[：:]\s*\S/.test(text.split('\n')[0] ?? '')) {
    errors.push('首行应为「# T<编号>：<标题>」');
  }
  const top = text.split('\n## ')[0];
  return errors.concat(missingFields(top, ['openspec', '类型', '被谁阻塞'], '头部'));
}

function checkTicketSections(sections) {
  const errors = [];
  const titles = sections.map((section) => section.title);
  let last = -1;
  for (const name of TICKET_SECTIONS) {
    const index = titles.indexOf(name);
    if (index < 0 || sections[index].body.trim() === '') {
      errors.push(`缺少或为空的小节「## ${name}」`);
    } else if (index < last) {
      errors.push(`小节「## ${name}」顺序不对`);
    } else {
      last = index;
    }
  }
  return errors;
}

export function checkTicket(text, done) {
  const sections = sectionsOf(text);
  const errors = checkTicketHeader(text)
    .concat(checkTicketSections(sections))
    .concat(placeholderErrors(text));
  const section = (name) => sections.find((item) => item.title === name)?.body ?? '';
  errors.push(...missingFields(section('边界'), ['只动', '适用通用规则', '必须保持'], '「边界」'));
  if (!/^\s*\d+\.\s+\S/m.test(section('验收'))) {
    errors.push('「验收」里没有编号的验收命令');
  }
  if (done) {
    const record = sections.find((item) => item.title === '记录');
    errors.push(...(record ? checkRecordBlock(record.body) : ['缺少「## 记录」小节']));
  }
  return errors;
}

function checkReview(title, body) {
  const errors = [];
  const clean = /无发现[（(].{8,}/.test(body);
  if (!clean && !/^\s*\d+\.\s+\S/m.test(body)) {
    errors.push(
      `「${title}」要么逐条列发现，要么写「无发现（查了什么，≥8 字）」，不能只写「无发现」`,
    );
  }
  return errors.concat(missingFields(body, ['结论'], `「${title}」`));
}

function checkAcceptance(body) {
  const errors = missingFields(body, ACCEPT_FIELDS, '「验收」');
  if (!body.includes('→')) {
    errors.push('「验收」里没有「命令 → 结果」的逐条记录');
  }
  return errors;
}

function checkReceiptSection(section) {
  const { title, body } = section;
  if (title === '执行') {
    return missingFields(body, EXECUTION_FIELDS, '「执行」');
  }
  if (title === '审查' || title.startsWith('复审')) {
    return checkReview(title, body);
  }
  if (title.startsWith('修复')) {
    return missingFields(body, FIX_FIELDS, `「${title}」`);
  }
  if (title === '验收') {
    return checkAcceptance(body);
  }
  if (title === '卡住') {
    return missingFields(body, STUCK_FIELDS, '「卡住」');
  }
  return [`未知小节「## ${title}」（只允许 执行/审查/复审/修复/验收/卡住）`];
}

export function checkReceipt(text, complete) {
  const sections = sectionsOf(text);
  const titles = sections.map((section) => section.title);
  const errors = titles[0] === '执行' ? [] : ['第一节必须是「## 执行」'];
  errors.push(...placeholderErrors(text));
  for (const section of sections) {
    errors.push(...checkReceiptSection(section));
  }
  if (complete) {
    if (!titles.some((title) => title === '审查' || title.startsWith('复审'))) {
      errors.push('缺少「## 审查」：自审不能省');
    }
    const last = sections[sections.length - 1];
    if (last?.title !== '验收' || !/^通过/.test(fieldValue(last.body, '结论'))) {
      errors.push('最后一节必须是结论为「通过」的「## 验收」');
    }
  }
  return errors;
}

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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
}

function filesIn(root, dir) {
  const path = join(root, dir);
  return existsSync(path) ? readdirSync(path).filter((name) => name.endsWith('.md')) : [];
}

function idOf(name) {
  return /^(T\d+[a-z]?)[-.]/.exec(name)?.[1];
}

function auditDone(root, row, problems, sizes) {
  const id = row.id;
  const ticket = filesIn(root, 'done').find((name) => idOf(name) === id);
  const receipt = join(root, '_receipts', `${id}.md`);
  if (!row.tasks || row.tasks === '-') {
    problems.push({
      level: 'ERROR',
      file: 'PLAN.md',
      message: `${id} 是没有任务编号的占位行：并入别的单就不要留行（挪 dropped/ 并写明并入哪张）`,
    });
  }
  if (ticket) {
    const text = read(join(root, 'done', ticket));
    sizes.tickets.push({ file: `done/${ticket}`, size: text.length });
    for (const message of checkTicket(text, true)) {
      problems.push({ level: 'ERROR', file: `done/${ticket}`, message });
    }
  } else {
    problems.push({
      level: 'ERROR',
      file: 'PLAN.md',
      message: `${id} 状态「完成」但 done/ 里没有工单文件`,
    });
  }
  if (existsSync(receipt)) {
    const text = read(receipt);
    sizes.receipts.push({ file: `_receipts/${id}.md`, size: text.length });
    for (const message of checkReceipt(text, true)) {
      problems.push({ level: 'ERROR', file: `_receipts/${id}.md`, message });
    }
  } else {
    problems.push({ level: 'ERROR', file: `_receipts/${id}.md`, message: '缺少回执文件' });
  }
}

function auditParked(root, dir, problems) {
  for (const name of filesIn(root, dir)) {
    if (!/(原因|等待|待外部条件|在等|卡住)/.test(read(join(root, dir, name)))) {
      problems.push({
        level: 'ERROR',
        file: `${dir}/${name}`,
        message: '挪出主线的工单必须写明原因或在等什么',
      });
    }
  }
}

function shrinkWarnings(entries, problems) {
  const base = median(entries.map((entry) => entry.size));
  for (const entry of entries) {
    if (base > 0 && entry.size < base * SHRINK_RATIO) {
      problems.push({
        level: 'WARN',
        file: entry.file,
        message: `篇幅 ${entry.size} 字，不到同类记录中位数 ${base} 的一半，检查是否缩水`,
      });
    }
  }
}

export function audit(root) {
  const problems = [];
  const planFile = join(root, 'PLAN.md');
  if (!existsSync(planFile)) {
    return [{ level: 'ERROR', file: 'PLAN.md', message: '不存在' }];
  }
  const rows = planRows(read(planFile));
  const sizes = { tickets: [], receipts: [] };
  for (const row of rows) {
    if (row.status === '完成') {
      auditDone(root, row, problems, sizes);
    }
  }
  const planned = new Set(rows.map((row) => row.id));
  for (const dir of ['done', 'doing', 'blocked', 'dropped']) {
    for (const name of filesIn(root, dir)) {
      if (!planned.has(idOf(name))) {
        problems.push({
          level: 'ERROR',
          file: `${dir}/${name}`,
          message: '不在 PLAN.md 的工单表里',
        });
      }
    }
  }
  auditParked(root, 'blocked', problems);
  auditParked(root, 'dropped', problems);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && !['PLAN.md', 'LESSONS.md'].includes(entry.name)) {
      problems.push({
        level: 'WARN',
        file: entry.name,
        message: '散落在 _solo-self/ 根目录，日志和临时脚本请挪到 _logs/',
      });
    }
  }
  shrinkWarnings(sizes.tickets, problems);
  shrinkWarnings(sizes.receipts, problems);
  return problems;
}

function skeleton(kind) {
  const file = join(HERE, '..', 'references', `${kind}.md`);
  const block = /```[a-z]*\n([\s\S]*?)\n```/.exec(read(file));
  return block ? block[1] : '';
}

function report(problems, label) {
  for (const problem of problems) {
    console.log(`${problem.level} ${problem.file}: ${problem.message}`);
  }
  const errors = problems.filter((problem) => problem.level === 'ERROR').length;
  console.log(errors === 0 ? `OK ${label}` : `FAIL ${label}: ${errors} 个问题`);
  return errors === 0 ? 0 : 1;
}

function runFileCheck(kind, file, flag, args) {
  if (!file || !existsSync(file)) {
    console.log(`FAIL 找不到文件：${file ?? '(未指定)'}`);
    return 1;
  }
  const text = read(file);
  const messages =
    kind === 'ticket'
      ? checkTicket(text, args.includes(flag))
      : checkReceipt(text, args.includes(flag));
  return report(
    messages.map((message) => ({ level: 'ERROR', file, message })),
    file,
  );
}

function main(argv) {
  const [command, target, ...rest] = argv;
  const args = [target, ...rest].filter(Boolean);
  if (command === 'skeleton' && (target === 'ticket' || target === 'receipt')) {
    console.log(skeleton(target));
    return 0;
  }
  if (command === 'ticket') {
    return runFileCheck('ticket', target, '--done', args);
  }
  if (command === 'receipt') {
    return runFileCheck('receipt', target, '--complete', args);
  }
  if (command === 'audit') {
    const rootIndex = args.indexOf('--root');
    const root = rootIndex >= 0 ? args[rootIndex + 1] : '_solo-self';
    return report(audit(root), root);
  }
  console.log(
    '用法：records.mjs skeleton ticket|receipt | ticket <file> [--done] | receipt <file> [--complete] | audit [--root <dir>]',
  );
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}

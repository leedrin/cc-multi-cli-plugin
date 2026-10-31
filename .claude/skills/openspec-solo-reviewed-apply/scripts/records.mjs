#!/usr/bin/env node
// Structure checks for the records written by openspec-solo-reviewed-apply: tickets, receipts,
// PLAN.md, the resident reviewer's reports and the scenario list. Zero dependencies.
//
// Why it exists: after context compaction the format files are no longer in context and records
// drift shorter and shorter; and a reviewer's "no findings" is only believable when probes were
// run. This script is the gate that does not forget, and it cross-checks report claims against
// the JSON that mutate.mjs wrote.
//
//   node records.mjs skeleton ticket|receipt|review|stage   print the template (never write from memory)
//   node records.mjs ticket <file> [--done]                  check one ticket
//   node records.mjs receipt <file> [--complete]             check one receipt (links its review reports)
//   node records.mjs review <file>                           check one ticket review report
//   node records.mjs stage <file> [--expect T001,T002]       check a stage or final review report
//   node records.mjs scenarios [--root _solo-rv]             check _review/SCENARIOS.md
//   node records.mjs audit [--root _solo-rv] [--final]       check every record against PLAN.md

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = '_solo-rv';
const TICKET_SECTIONS = ['目标', '动手前先读', '边界', '验收', '为什么这样验收'];
const REPORT_SECTIONS = ['场景映射', '先红校验', '变异', '探针', '发现', '结论'];
const STAGE_SECTIONS = ['跨单检查', '探针', '发现', '结论'];
const STAGE_ITEMS = ['接口一致', '重复实现', '死代码', '场景覆盖', '共享状态'];
const EXECUTION_FIELDS = ['状态', '文件清单', '先红', '验收', '存疑'];
const FIX_FIELDS = ['来源', '先红', '文件清单', '验收'];
const ACCEPT_FIELDS = ['越界', '测试篡改', '工作区', '结论'];
const STUCK_FIELDS = ['症状', '根因分析', '试过', '建议'];
const REVIEW_LINK_FIELDS = ['审查报告', '发现数', '结论'];
const NO_SCENARIO_TYPES = ['文档', '外部'];
const SEVERITIES = ['高', '中', '低'];
const OWNERS = ['本单', '超范围', '改 spec', '改spec'];
const KINDS = ['缺陷', '测试'];
const MIN_PROBES_FOR_CLEAN = 3;
const MIN_REPORTS_FOR_RATE = 6;
const SHRINK_RATIO = 0.5;

// ---------- shared text helpers ----------

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

function readJson(file) {
  try {
    return JSON.parse(read(file));
  } catch {
    return null;
  }
}

function sectionOrderErrors(sections, names) {
  const errors = [];
  const titles = sections.map((section) => section.title);
  let last = -1;
  for (const name of names) {
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

function bodyOf(sections, name) {
  return sections.find((item) => item.title === name)?.body ?? '';
}

// ---------- tickets ----------

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

function scenarioIds(value) {
  return value.match(/S\d+/g) ?? [];
}

function checkTicketHeader(text) {
  const errors = [];
  if (!/^# T\d+[a-z]?[：:]\s*\S/.test(text.split('\n')[0] ?? '')) {
    errors.push('首行应为「# T<编号>：<标题>」');
  }
  const top = text.split('\n## ')[0];
  errors.push(...missingFields(top, ['openspec', '类型', '被谁阻塞', '场景'], '头部'));
  const type = fieldValue(top, '类型');
  const scenarios = fieldValue(top, '场景');
  const noneAllowed = NO_SCENARIO_TYPES.some((name) => type.startsWith(name));
  if (scenarios && scenarioIds(scenarios).length === 0 && !(noneAllowed && /^无/.test(scenarios))) {
    errors.push(
      '头部「场景」要列 SCENARIOS.md 里的编号（如 S003, S004）；只有文档/外部类才能写「无」',
    );
  }
  return errors;
}

export function checkTicket(text, done) {
  const sections = sectionsOf(text);
  const errors = checkTicketHeader(text)
    .concat(sectionOrderErrors(sections, TICKET_SECTIONS))
    .concat(placeholderErrors(text));
  errors.push(
    ...missingFields(bodyOf(sections, '边界'), ['只动', '适用通用规则', '必须保持'], '「边界」'),
  );
  if (!/^\s*\d+\.\s+\S/m.test(bodyOf(sections, '验收'))) {
    errors.push('「验收」里没有编号的验收命令');
  }
  if (done) {
    const record = sections.find((item) => item.title === '记录');
    errors.push(...(record ? checkRecordBlock(record.body) : ['缺少「## 记录」小节']));
  }
  return errors;
}

// ---------- ticket review reports (written by the resident reviewer) ----------

function parseFindings(body) {
  const clean = /无发现[（(][\s\S]{8,}/.test(body);
  const items = body
    .split('\n')
    .filter((line) => /^\s*\d+\.\s+\S/.test(line))
    .map((line) =>
      line
        .replace(/^\s*\d+\.\s+/, '')
        .split('｜')
        .map((part) => part.trim()),
    );
  return { clean, items };
}

function findingErrors(items) {
  const errors = [];
  for (const [index, item] of items.entries()) {
    const [severity, owner, kind] = item;
    const label = `发现 ${index + 1}`;
    if (item.length < 7) {
      errors.push(`${label} 要写满 7 段：严重程度｜归属｜类型｜文件:行号｜问题｜代码证据｜怎么改`);
    } else if (!(SEVERITIES.includes(severity) && OWNERS.includes(owner) && KINDS.includes(kind))) {
      errors.push(
        `${label} 的严重程度/归属/类型取值不合法（高中低｜本单/超范围/改 spec｜缺陷/测试）`,
      );
    }
  }
  return errors;
}

function blocking(items) {
  return items.filter((item) => (item[0] === '高' || item[0] === '中') && item[1] === '本单');
}

function checkFindingsSection(body, probes, minProbes) {
  const { clean, items } = parseFindings(body);
  const errors = [];
  if (!clean && items.length === 0) {
    errors.push('「发现」要么逐条列出，要么写「无发现（查了什么，≥8 字）」');
  }
  errors.push(...findingErrors(items));
  if (clean && items.length === 0 && probes < minProbes) {
    errors.push(
      `「无发现」必须有至少 ${minProbes} 条执行过的探针（「探针」小节 N. 命令 → 结果），现在 ${probes} 条`,
    );
  }
  return { errors, items };
}

function countProbes(body) {
  return body.split('\n').filter((line) => /^\s*\d+\.\s+.+→.+/.test(line)).length;
}

function checkMapping(body, ticketNotApplicable) {
  const text = body.trim();
  if (/^不适用[：:]/.test(text)) {
    const reason = fieldValue(body, '不适用');
    const ok = reason.length >= 8 && ticketNotApplicable;
    return {
      errors: ok ? [] : ['「场景映射」只有文档/外部类单能写「不适用：<≥8 字理由>」'],
      gaps: 0,
    };
  }
  const rows = body
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter((line) => /^S\d+｜/.test(line));
  const errors =
    rows.length === 0 ? ['「场景映射」没有任何「S编号｜测试名｜文件:行｜覆盖/缺口」行'] : [];
  let gaps = 0;
  for (const row of rows) {
    const [id, test, location, state] = row.split('｜').map((part) => part.trim());
    if (state === '缺口') {
      gaps += 1;
    } else if (state !== '覆盖') {
      errors.push(`${id} 的最后一段只能是「覆盖」或「缺口」`);
    } else {
      errors.push(...mappingRowErrors(id, test ?? '', location ?? ''));
    }
  }
  return { errors, gaps };
}

function mappingRowErrors(id, test, location) {
  const file = location.replace(/:\d+(?:-\d+)?$/, '');
  if (!(file && existsSync(file))) {
    return [`${id} 指向的测试文件不存在：${location}`];
  }
  if (!(test && read(file).includes(test))) {
    return [`${id} 指向的测试名「${test}」在 ${file} 里找不到`];
  }
  return [];
}

function checkRedFirst(body, findings) {
  const result = fieldValue(body, '结果');
  if (result.startsWith('不适用')) {
    return result.length >= 12 ? [] : ['「先红校验」写不适用时要带理由（≥8 字）'];
  }
  const errors = missingFields(body, ['命令', '报告文件'], '「先红校验」');
  const json = readJson(fieldValue(body, '报告文件'));
  if (!(json && json.mode === 'baseline')) {
    errors.push('「先红校验」的报告文件不存在或不是 mutate.mjs baseline 的输出');
    return errors;
  }
  const expected = result.startsWith('红') ? 'red' : 'green';
  if (!(result.startsWith('红') || result.startsWith('绿'))) {
    errors.push('「先红校验」的结果只能是「红」「绿」或「不适用：…」');
  } else if (json.result !== expected) {
    errors.push(`「先红校验」写的是${result.slice(0, 1)}，但报告文件里是 ${json.result}`);
  }
  if (result.startsWith('绿') && findings === 0) {
    errors.push('先红校验为绿（旧实现下新测试也通过）= 测试没测到新行为，必须有一条发现');
  }
  return errors;
}

function survivorErrors(body, json, findings) {
  const errors = [];
  for (const mutant of json.mutants.filter((item) => item.result === 'survived')) {
    const line = new RegExp(`处置\\s+${mutant.id}[：:]\\s*(杀不死|等价)(.*)`).exec(body);
    if (!line) {
      errors.push(
        `存活变异 ${mutant.id}（${mutant.file}:${mutant.line}）没有「处置 ${mutant.id}：杀不死/等价」`,
      );
    } else if (line[1] === '等价' && line[2].replace(/[（）() ]/g, '').length < 6) {
      errors.push(`变异 ${mutant.id} 判等价要写理由（≥6 字）`);
    } else if (line[1] === '杀不死' && findings === 0) {
      errors.push(`变异 ${mutant.id} 杀不死 = 测试缺口，必须在「发现」里有对应的一条`);
    }
  }
  return errors;
}

function checkMutation(body, findings) {
  if (/^不适用[：:]/.test(body.trim())) {
    return fieldValue(body, '不适用').length >= 8 ? [] : ['「变异」写不适用时要带理由（≥8 字）'];
  }
  const line = /变异：(\d+) 个，杀死 (\d+)，存活 (\d+)，无效 (\d+)，未试 (\d+)/.exec(body);
  const json = readJson(fieldValue(body, '报告文件'));
  if (!(line && json && json.mode === 'run' && Array.isArray(json.mutants))) {
    return ['「变异」要贴 mutate.mjs 的汇总行和「报告文件：<json>」，且文件须是 run 的输出'];
  }
  const errors = [];
  const claimed = line.slice(1, 6).map(Number);
  const t = json.totals;
  if (claimed.join() !== [t.total, t.killed, t.survived, t.invalid, t.skipped].join()) {
    errors.push('「变异」汇总行与报告文件里的统计不一致');
  }
  if (t.total === 0) {
    errors.push('没有变异点：改写「不适用：<理由>」，不能拿 0 个变异当通过');
  }
  if (json.restored !== true) {
    errors.push('变异报告显示文件没有恢复，先 recover 并重跑');
  }
  return errors.concat(survivorErrors(body, json, findings));
}

function reportHeaderErrors(text, pattern, label, types) {
  const first = text.split('\n')[0] ?? '';
  if (/^进行中/.test(first)) {
    return { stop: true, errors: [`${label}仍是「进行中」，审查员还没写完`] };
  }
  const errors = pattern.test(first) ? [] : [`${label}首行格式不对：${first.slice(0, 30)}`];
  const top = text.split('\n## ')[0];
  const kind = fieldValue(top, '类型');
  if (!types.includes(kind)) {
    errors.push(`头部「类型」要是 ${types.join('/')}`);
  }
  return { stop: false, errors, top };
}

export function checkReviewReport(text) {
  const head = reportHeaderErrors(text, /^# 审查报告 T\d+[a-z]?\s*第\d+轮/, '审查报告', [
    '首审',
    '复审',
  ]);
  if (head.stop) {
    return head.errors;
  }
  const sections = sectionsOf(text);
  const errors = head.errors
    .concat(missingFields(head.top, ['范围', '工单类型'], '头部'))
    .concat(sectionOrderErrors(sections, REPORT_SECTIONS))
    .concat(placeholderErrors(text));
  const probes = countProbes(bodyOf(sections, '探针'));
  const found = checkFindingsSection(bodyOf(sections, '发现'), probes, MIN_PROBES_FOR_CLEAN);
  const mapping = checkMapping(
    bodyOf(sections, '场景映射'),
    NO_SCENARIO_TYPES.some((name) => fieldValue(head.top, '工单类型').startsWith(name)),
  );
  const count = found.items.length;
  errors.push(...found.errors, ...mapping.errors);
  if (mapping.gaps > 0 && count === 0) {
    errors.push('场景映射里有「缺口」，必须在「发现」里有对应的一条');
  }
  errors.push(...checkRedFirst(bodyOf(sections, '先红校验'), count));
  errors.push(...checkMutation(bodyOf(sections, '变异'), count));
  errors.push(
    ...conclusionErrors(bodyOf(sections, '结论'), found.items, ['进验收', '开修复轮', '阻塞']),
  );
  return errors;
}

function conclusionErrors(body, items, allowed) {
  const value = fieldValue(body, '结论');
  const word = allowed.find((name) => value.startsWith(name));
  if (!word) {
    return [`「结论」只能以 ${allowed.join('/')} 开头`];
  }
  if (word === allowed[0] && blocking(items).length > 0) {
    return [`有「高/中｜本单」的发现，结论不能是「${allowed[0]}」`];
  }
  if (word === allowed[1] && items.length === 0) {
    return ['没有发现却要求开修复，结论与发现矛盾'];
  }
  return [];
}

// ---------- stage and final review reports ----------

export function checkStageReport(text, expectedIds = []) {
  const head = reportHeaderErrors(text, /^# (阶段审查|终审)/, '阶段报告', ['阶段审', '终审']);
  if (head.stop) {
    return head.errors;
  }
  const sections = sectionsOf(text);
  const errors = head.errors
    .concat(missingFields(head.top, ['阶段', '工单'], '头部'))
    .concat(sectionOrderErrors(sections, STAGE_SECTIONS))
    .concat(placeholderErrors(text));
  const listed = fieldValue(head.top, '工单').match(/T\d+[a-z]?/g) ?? [];
  for (const id of expectedIds.filter((item) => !listed.includes(item))) {
    errors.push(`头部「工单」漏了 ${id}`);
  }
  const body = bodyOf(sections, '跨单检查');
  const items =
    fieldValue(head.top, '类型') === '终审' ? [...STAGE_ITEMS, '任务覆盖'] : STAGE_ITEMS;
  for (const name of items.filter(
    (item) => !new RegExp(`^\\s*\\d+\\.\\s+${item}`, 'm').test(body),
  )) {
    errors.push(`「跨单检查」缺少检查项「${name}」（按「N. ${name}｜做了什么｜结果」写）`);
  }
  const probes = countProbes(bodyOf(sections, '探针'));
  const found = checkFindingsSection(bodyOf(sections, '发现'), probes, MIN_PROBES_FOR_CLEAN);
  errors.push(...found.errors);
  errors.push(
    ...conclusionErrors(bodyOf(sections, '结论'), found.items, ['通过', '开修复单', '阻塞']),
  );
  return errors;
}

// ---------- receipts ----------

function checkReviewLink(title, body) {
  const errors = missingFields(body, REVIEW_LINK_FIELDS, `「${title}」`);
  const path = fieldValue(body, '审查报告');
  if (!path) {
    return errors;
  }
  if (!existsSync(path)) {
    return errors.concat([`「${title}」引用的审查报告不存在：${path}`]);
  }
  const reportText = read(path);
  errors.push(...checkReviewReport(reportText).map((message) => `${path}：${message}`));
  const sections = sectionsOf(reportText);
  const { items } = parseFindings(bodyOf(sections, '发现'));
  if (String(items.length) !== fieldValue(body, '发现数').replace(/[^0-9]/g, '')) {
    errors.push(`「${title}」的发现数与审查报告里的条数（${items.length}）不一致`);
  }
  const word = ['进验收', '开修复轮', '阻塞'].find((name) =>
    fieldValue(bodyOf(sections, '结论'), '结论').startsWith(name),
  );
  if (word && !fieldValue(body, '结论').startsWith(word)) {
    errors.push(`「${title}」的结论与审查报告不一致（报告：${word}）`);
  }
  return errors;
}

function checkAcceptance(body) {
  const errors = missingFields(body, ACCEPT_FIELDS, '「验收」');
  if (!body.includes('→')) {
    errors.push('「验收」里没有「命令 → 结果」的逐条记录');
  }
  if (hasField(body, '工作区') && !/^CLEAN/.test(fieldValue(body, '工作区'))) {
    errors.push('「验收」的「工作区」必须是 CLEAN（mutate.mjs status 的输出）');
  }
  return errors;
}

function checkReceiptSection(section) {
  const { title, body } = section;
  if (title === '执行') {
    return missingFields(body, EXECUTION_FIELDS, '「执行」');
  }
  if (title === '审查' || title.startsWith('复审')) {
    return checkReviewLink(title, body);
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

function isReview(title) {
  return title === '审查' || title.startsWith('复审');
}

function completeErrors(sections) {
  const errors = [];
  const reviews = sections.filter((section) => isReview(section.title));
  if (reviews.length === 0) {
    errors.push('缺少「## 审查」：常驻审查员的首审不能省');
  } else if (!/^进验收/.test(fieldValue(reviews[reviews.length - 1].body, '结论'))) {
    errors.push('最后一次审查/复审的结论必须是「进验收」');
  }
  const lastReview = sections.map((s) => isReview(s.title)).lastIndexOf(true);
  const lastFix = sections.map((s) => s.title.startsWith('修复')).lastIndexOf(true);
  if (lastFix > lastReview) {
    errors.push('修复之后必须有「## 复审」：改完不能自己放行');
  }
  const last = sections[sections.length - 1];
  if (last?.title !== '验收' || !/^通过/.test(fieldValue(last.body, '结论'))) {
    errors.push('最后一节必须是结论为「通过」的「## 验收」');
  }
  return errors;
}

export function checkReceipt(text, complete) {
  const sections = sectionsOf(text);
  const errors = sections[0]?.title === '执行' ? [] : ['第一节必须是「## 执行」'];
  errors.push(...placeholderErrors(text));
  for (const section of sections) {
    errors.push(...checkReceiptSection(section));
  }
  return complete ? errors.concat(completeErrors(sections)) : errors;
}

// ---------- scenarios ----------

function scenarioLines(root) {
  const file = join(root, '_review', 'SCENARIOS.md');
  if (!existsSync(file)) {
    return null;
  }
  return read(file)
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter((line) => /^S\d+｜/.test(line));
}

export function checkScenarios(root) {
  const rows = scenarioLines(root);
  if (rows === null) {
    return ['_review/SCENARIOS.md 不存在：审查员开场时要从 specs/ 列出全部场景'];
  }
  if (rows.length === 0) {
    return ['SCENARIOS.md 里没有「S编号｜spec 路径｜场景名｜一句话 WHEN→THEN」行'];
  }
  const errors = [];
  const seen = new Set();
  for (const row of rows) {
    const parts = row.split('｜').map((part) => part.trim());
    if (parts.length < 4 || parts.some((part) => part === '')) {
      errors.push(`场景行要写满 4 段：${row.slice(0, 40)}`);
    }
    if (seen.has(parts[0])) {
      errors.push(`场景编号重复：${parts[0]}`);
    }
    seen.add(parts[0]);
  }
  return errors;
}

// ---------- audit ----------

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
        stage: row.get('阶段') ?? '',
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

function addFileProblems(problems, file, messages) {
  for (const message of messages) {
    problems.push({ level: 'ERROR', file, message });
  }
}

function auditTicketScenarios(text, file, known, problems) {
  const top = text.split('\n## ')[0];
  for (const id of scenarioIds(fieldValue(top, '场景'))) {
    if (known && !known.has(id)) {
      problems.push({ level: 'ERROR', file, message: `场景 ${id} 不在 SCENARIOS.md 里` });
    }
  }
}

function auditReportTypes(root, id, ticketText, problems) {
  const dir = join(root, '_review');
  const type = fieldValue(ticketText.split('\n## ')[0], '类型');
  const reports = existsSync(dir)
    ? readdirSync(dir).filter((name) => new RegExp(`^${id}-r\\d+\\.md$`).test(name))
    : [];
  for (const name of reports) {
    const claimed = fieldValue(read(join(dir, name)).split('\n## ')[0], '工单类型');
    if (claimed && type && claimed.slice(0, 2) !== type.slice(0, 2)) {
      problems.push({
        level: 'ERROR',
        file: `_review/${name}`,
        message: `报告的「工单类型」是 ${claimed}，工单是 ${type}：不能靠改类型绕过场景映射`,
      });
    }
  }
}

function auditDone(root, row, ctx) {
  const id = row.id;
  const ticket = filesIn(root, 'done').find((name) => idOf(name) === id);
  const receipt = join(root, '_receipts', `${id}.md`);
  if (!row.tasks || row.tasks === '-') {
    ctx.problems.push({
      level: 'ERROR',
      file: 'PLAN.md',
      message: `${id} 是没有任务编号的占位行：并入别的单就不要留行（挪 dropped/ 并写明并入哪张）`,
    });
  }
  if (ticket) {
    const text = read(join(root, 'done', ticket));
    ctx.sizes.tickets.push({ file: `done/${ticket}`, size: text.length });
    addFileProblems(ctx.problems, `done/${ticket}`, checkTicket(text, true));
    auditTicketScenarios(text, `done/${ticket}`, ctx.known, ctx.problems);
    auditReportTypes(root, id, text, ctx.problems);
    ctx.used.push(...scenarioIds(fieldValue(text.split('\n## ')[0], '场景')));
  } else {
    ctx.problems.push({
      level: 'ERROR',
      file: 'PLAN.md',
      message: `${id} 状态「完成」但 done/ 里没有工单文件`,
    });
  }
  if (existsSync(receipt)) {
    const text = read(receipt);
    ctx.sizes.receipts.push({ file: `_receipts/${id}.md`, size: text.length });
    addFileProblems(ctx.problems, `_receipts/${id}.md`, checkReceipt(text, true));
  } else {
    ctx.problems.push({ level: 'ERROR', file: `_receipts/${id}.md`, message: '缺少回执文件' });
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

function auditStageReports(root, rows, problems, final) {
  const stages = new Map();
  for (const row of rows.filter((item) => item.stage && item.stage !== '-')) {
    stages.set(row.stage, [...(stages.get(row.stage) ?? []), row]);
  }
  for (const [stage, members] of stages) {
    const settled = members.every((row) => row.status === '完成' || row.status === '放弃');
    const done = members.filter((row) => row.status === '完成').map((row) => row.id);
    if (settled && done.length > 0) {
      auditReportFile(root, `STAGE-${stage}.md`, done, problems);
    }
  }
  if (final) {
    const done = rows.filter((row) => row.status === '完成').map((row) => row.id);
    auditReportFile(root, 'FINAL.md', done, problems);
  }
}

function auditReportFile(root, name, expected, problems) {
  const file = join(root, '_review', name);
  if (!existsSync(file)) {
    problems.push({
      level: 'ERROR',
      file: `_review/${name}`,
      message: '阶段已收尾但缺少这份跨单审查报告',
    });
    return;
  }
  addFileProblems(problems, `_review/${name}`, checkStageReport(read(file), expected));
}

function auditZeroFindings(root, problems) {
  const dir = join(root, '_review');
  if (!existsSync(dir)) {
    return;
  }
  const firsts = readdirSync(dir).filter((name) => /^T\d+[a-z]?-r1\.md$/.test(name));
  if (firsts.length < MIN_REPORTS_FOR_RATE) {
    return;
  }
  const withFindings = firsts.filter(
    (name) => parseFindings(bodyOf(sectionsOf(read(join(dir, name))), '发现')).items.length > 0,
  );
  if (withFindings.length === 0) {
    problems.push({
      level: 'WARN',
      file: '_review/',
      message: `${firsts.length} 份首审报告全是「无发现」：审查员可能在放水，抽查探针和存活变异的处置`,
    });
  }
}

function auditScenarioCoverage(ctx, root, final, problems) {
  if (!ctx.known) {
    return;
  }
  const covered = new Set(ctx.used);
  for (const dir of ['doing', 'open', 'blocked']) {
    for (const name of filesIn(root, dir)) {
      const top = read(join(root, dir, name)).split('\n## ')[0];
      for (const id of scenarioIds(fieldValue(top, '场景'))) {
        covered.add(id);
      }
    }
  }
  const missing = [...ctx.known].filter((id) => !covered.has(id));
  if (missing.length > 0) {
    problems.push({
      level: final ? 'ERROR' : 'WARN',
      file: '_review/SCENARIOS.md',
      message: `这些场景没有任何工单认领：${missing.join(', ')}`,
    });
  }
}

function auditStray(root, problems) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && !['PLAN.md', 'LESSONS.md'].includes(entry.name)) {
      problems.push({
        level: 'WARN',
        file: entry.name,
        message: `散落在 ${root}/ 根目录，日志和临时脚本请挪到 _logs/`,
      });
    }
  }
}

export function audit(root, final = false) {
  const planFile = join(root, 'PLAN.md');
  if (!existsSync(planFile)) {
    return [{ level: 'ERROR', file: 'PLAN.md', message: '不存在' }];
  }
  const problems = [];
  const rows = planRows(read(planFile));
  const scenarios = scenarioLines(root);
  addFileProblems(problems, '_review/SCENARIOS.md', checkScenarios(root));
  const ctx = {
    problems,
    sizes: { tickets: [], receipts: [] },
    known: scenarios ? new Set(scenarios.map((row) => row.split('｜')[0].trim())) : null,
    used: [],
  };
  for (const row of rows.filter((item) => item.status === '完成')) {
    auditDone(root, row, ctx);
  }
  const planned = new Set(rows.map((row) => row.id));
  for (const dir of ['done', 'doing', 'blocked', 'dropped']) {
    for (const name of filesIn(root, dir).filter((item) => !planned.has(idOf(item)))) {
      problems.push({ level: 'ERROR', file: `${dir}/${name}`, message: '不在 PLAN.md 的工单表里' });
    }
  }
  auditParked(root, 'blocked', problems);
  auditParked(root, 'dropped', problems);
  auditStray(root, problems);
  auditStageReports(root, rows, problems, final);
  auditScenarioCoverage(ctx, root, final, problems);
  auditZeroFindings(root, problems);
  shrinkWarnings(ctx.sizes.tickets, problems);
  shrinkWarnings(ctx.sizes.receipts, problems);
  return problems;
}

// ---------- command line ----------

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

function checkText(kind, file, args) {
  const text = read(file);
  const expectIndex = args.indexOf('--expect');
  const expected = expectIndex >= 0 ? (args[expectIndex + 1] ?? '').split(',').filter(Boolean) : [];
  const checks = {
    ticket: () => checkTicket(text, args.includes('--done')),
    receipt: () => checkReceipt(text, args.includes('--complete')),
    review: () => checkReviewReport(text),
    stage: () => checkStageReport(text, expected),
  };
  return checks[kind]();
}

function runFileCheck(kind, file, args) {
  if (!file || !existsSync(file)) {
    console.log(`FAIL 找不到文件：${file ?? '(未指定)'}`);
    return 1;
  }
  return report(
    checkText(kind, file, args).map((message) => ({ level: 'ERROR', file, message })),
    file,
  );
}

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}

function main(argv) {
  const [command, target, ...rest] = argv;
  const args = [target, ...rest].filter(Boolean);
  if (command === 'skeleton' && ['ticket', 'receipt', 'review', 'stage'].includes(target)) {
    console.log(skeleton(target));
    return 0;
  }
  if (['ticket', 'receipt', 'review', 'stage'].includes(command)) {
    return runFileCheck(command, target, args);
  }
  const root = optionValue(args, '--root', DEFAULT_ROOT);
  if (command === 'scenarios') {
    return report(
      checkScenarios(root).map((message) => ({ level: 'ERROR', file: 'SCENARIOS.md', message })),
      root,
    );
  }
  if (command === 'audit') {
    return report(audit(root, args.includes('--final')), root);
  }
  console.log(
    '用法：records.mjs skeleton ticket|receipt|review|stage | ticket <file> [--done] | receipt <file> [--complete] | review <file> | stage <file> [--expect T001,T002] | scenarios | audit [--root <dir>] [--final]',
  );
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}

import path from 'node:path';
import { P, loadConfig, readJSON } from './lib/store.mjs';
import { addDays, bjToday, cnDate, fmtNum, fmtDelta, log } from './lib/util.mjs';

const WEBHOOK = process.env.WECOM_WEBHOOK || '';
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
const TARGET = process.env.REPORT_DATE || addDays(bjToday(), -1);

function trim(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function buildMarkdown(report, config, opts = {}) {
  const topN = opts.topN ?? config.notify.topNPerColumn ?? 3;
  const whyLen = opts.whyLen ?? 46;
  const showRec = opts.rec !== false;
  const lines = [];

  lines.push(`## ◤◢ SKILLS DAILY · ${cnDate(report.date)}`);
  lines.push(
    `<font color="comment">池 ${report.pool_size} 个仓库 · 快照 ${report.snapshot_days} 天 · 生成 ${report.generated_at.slice(11)}</font>`,
  );

  for (const col of report.columns) {
    lines.push('');
    lines.push(`> **${col.label}**　<font color="comment">${col.status === 'live' ? 'LIVE' : 'COLD START'}</font>`);
    if (!col.items.length) {
      lines.push('> <font color="comment">今日空置（宁缺勿滥）</font>');
      continue;
    }
    col.items.slice(0, topN).forEach((it, i) => {
      const metric =
        col.metric === 'delta' && typeof it.delta === 'number'
          ? `<font color="warning">${fmtDelta(it.delta)}</font>`
          : `★${fmtNum(it.stars)}`;
      const why = it.summary && whyLen > 0 ? trim(it.summary, whyLen) : '';
      const rec = showRec && typeof it.score === 'number' ? `　<font color="comment">REC ${it.score}</font>` : '';
      lines.push(`> ${i + 1}. [${it.full_name}](${it.url}) ${metric}${rec}`);
      if (why) lines.push(`> 　<font color="comment">${why}</font>`);
    });
    if (col.items.length > topN) {
      lines.push(`> <font color="comment">…另有 ${col.items.length - topN} 条</font>`);
    }
  }

  if (SITE_URL) {
    lines.push('');
    lines.push(`[◆ 打开完整日报](${SITE_URL})`);
  }

  return lines.join('\n');
}

/**
 * 企业微信 markdown 上限 4096 字节，多一栏就会顶到。
 * 逐级降级，而不是只打一行日志假装截断了：
 * 先压点评长度，再减少每栏条数，最后按行硬截。
 */
const PLANS = [
  { topN: 3, whyLen: 46, rec: true },
  { topN: 3, whyLen: 30, rec: true },
  // 保住每栏 3 条：宁可摘掉 REC 标签、压短点评，也不把条目减半
  { topN: 3, whyLen: 26, rec: false },
  { topN: 2, whyLen: 34, rec: true },
  { topN: 2, whyLen: 0, rec: false },
  { topN: 1, whyLen: 0, rec: false },
];

const LIMIT = 4000; // 留 96 字节余量给企业微信的包装

function hardTrim(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let cut = buf.slice(0, maxBytes).toString('utf8');
  const nl = cut.lastIndexOf('\n');
  if (nl > 0) cut = cut.slice(0, nl);
  return `${cut}\n…`;
}

function fitMarkdown(report, config) {
  for (const plan of PLANS) {
    const text = buildMarkdown(report, config, plan);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= LIMIT) return { text, plan, bytes };
  }
  const text = hardTrim(buildMarkdown(report, config, PLANS[PLANS.length - 1]), LIMIT);
  return { text, plan: { ...PLANS[PLANS.length - 1], hard: true }, bytes: Buffer.byteLength(text, 'utf8') };
}

async function main() {
  const config = await loadConfig();
  const report = await readJSON(path.join(P.daily, `${TARGET}.json`));
  if (!report) throw new Error(`找不到 ${TARGET} 的日报数据，请先执行 build`);

  if (!config.notify?.enabled) {
    log('推送已关闭（config.notify.enabled=false）');
    return;
  }
  if (!WEBHOOK && process.env.NOTIFY_DRY !== '1') {
    log('未配置 WECOM_WEBHOOK，跳过推送。把群机器人 webhook 放进仓库 Secrets 即可启用。');
    return;
  }

  const { text: content, plan, bytes } = fitMarkdown(report, config);

  if (process.env.NOTIFY_DRY === '1') {
    console.log('--- 预览推送内容 ---');
    console.log(content);
    console.log(`--- 共 ${bytes} 字节 / 上限 4096 · 方案 ${JSON.stringify(plan)} ---`);
    return;
  }

  log(`消息 ${bytes} 字节（上限 4096）· 方案 ${JSON.stringify(plan)}`);

  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
  });
  const json = await res.json().catch(() => ({}));
  if (json.errcode === 0) {
    log('企业微信群机器人推送成功');
  } else {
    throw new Error(`企业微信推送失败: ${JSON.stringify(json)}`);
  }
}

main().catch((err) => {
  console.error('推送失败:', err);
  process.exit(1);
});

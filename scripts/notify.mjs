import path from 'node:path';
import { P, loadConfig, readJSON } from './lib/store.mjs';
import { addDays, bjToday, cnDate, fmtNum, fmtDelta, log } from './lib/util.mjs';

const WEBHOOK = process.env.WECOM_WEBHOOK || '';
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
const TARGET = process.env.REPORT_DATE || addDays(bjToday(), -1);

function trim(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function buildMarkdown(report, config) {
  const topN = config.notify.topNPerColumn ?? 3;
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
      const why = it.summary ? trim(it.summary, 46) : '';
      lines.push(`> ${i + 1}. [${it.full_name}](${it.url}) ${metric}　<font color="comment">REC ${it.score}</font>`);
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

  const content = buildMarkdown(report, config);

  if (process.env.NOTIFY_DRY === '1') {
    console.log('--- 预览推送内容 ---');
    console.log(content);
    console.log(`--- 共 ${Buffer.byteLength(content, 'utf8')} 字节 / 上限 4096 ---`);
    return;
  }

  if (Buffer.byteLength(content, 'utf8') > 4000) {
    log(`消息 ${Buffer.byteLength(content, 'utf8')} 字节，超过企业微信 4096 上限，截断`);
  }

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

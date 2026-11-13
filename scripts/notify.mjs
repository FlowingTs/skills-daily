import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { P, loadConfig, readJSON } from './lib/store.mjs';
import { addDays, bjToday, cnDate, fmtNum, log } from './lib/util.mjs';

const WEBHOOK = process.env.WECOM_WEBHOOK || '';
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
const TARGET = process.env.REPORT_DATE || addDays(bjToday(), -1);

function trim(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * 只推两个领域的潜力榜：日/周/月/总已经收进页面切换里，
 * 早上八点最值得看的其实是「昨天又冒出来什么」，而不是「谁又涨了」。
 */
function buildMarkdown(report, config, opts = {}) {
  const topN = opts.topN ?? config.notify.topNPerColumn ?? 3;
  const whyLen = opts.whyLen ?? 46;
  const showRec = opts.rec !== false;
  const lines = [];

  const pools = report.groups.map((g) => `${g.label} ${g.pool_size}`).join(' · ');
  lines.push(`## ◤◢ SKILLS DAILY · ${cnDate(report.date)}`);
  lines.push(`<font color="comment">${pools} 个仓库 · 生成 ${report.generated_at.slice(11)}</font>`);

  for (const g of report.groups) {
    const pot = g.potential;
    lines.push('');
    const window = pot.used_window ? `近 ${pot.used_window} 天新建` : '新建仓库';
    lines.push(`> **${g.label} ${pot.label}**　<font color="comment">${window} · 按每天拿到的 star 排</font>`);
    if (!pot.items.length) {
      lines.push('> <font color="comment">今天没有满足条件的仓库（宁缺勿滥）</font>');
      continue;
    }
    pot.items.slice(0, topN).forEach((it, i) => {
      const speed = Math.round(it.velocity ?? 0);
      const rec = showRec && typeof it.score === 'number' ? `　<font color="comment">REC ${it.score}</font>` : '';
      lines.push(`> ${i + 1}. [${it.full_name}](${it.url}) <font color="warning">+${fmtNum(speed)}/天</font>${rec}`);
      if (it.summary && whyLen > 0) {
        lines.push(`> 　<font color="comment">${trim(it.summary, whyLen)}</font>`);
      }
    });
    if (pot.items.length > topN) {
      lines.push(`> <font color="comment">…另有 ${pot.items.length - topN} 个</font>`);
    }
  }

  if (SITE_URL) {
    lines.push('');
    lines.push(`[◆ 打开完整日报 · 日/周/月/总四档可切换](${SITE_URL})`);
  }

  return lines.join('\n');
}

/**
 * 企业微信 markdown 上限 4096 字节。
 * 逐级降级，而不是只打一行日志假装截断了。
 */
const PLANS = [
  { topN: 3, whyLen: 46, rec: true },
  { topN: 3, whyLen: 30, rec: true },
  { topN: 3, whyLen: 26, rec: false },
  { topN: 2, whyLen: 30, rec: true },
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

/** 读取当天分享图，返回 base64 字符串（或 null）。企业微信 image 消息限制 2MB。 */
function loadShareImage(date) {
  const candidates = [
    path.join(P.site, 'share', `${date}.png`),
    path.join(P.site, 'share', 'latest.png'),
  ];
  for (const f of candidates) {
    try {
      const buf = fs.readFileSync(f);
      if (buf.length === 0) continue;
      if (buf.length > 2 * 1024 * 1024) {
        log(`分享图 ${path.basename(f)} 超过 2MB（${(buf.length / 1024 / 1024).toFixed(2)}MB），回退文字`);
        continue;
      }
      return { base64: buf.toString('base64'), md5: crypto.createHash('md5').update(buf).digest('hex'), bytes: buf.length };
    } catch {
      /* 继续找下一个 */
    }
  }
  return null;
}

async function post(payload) {
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  return json;
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

  // 优先发分享图；图缺失或超限则回退文字 markdown。
  const img = loadShareImage(TARGET);

  if (process.env.NOTIFY_DRY === '1') {
    if (img) {
      console.log(`--- 预览：将推送分享图（${(img.bytes / 1024).toFixed(1)} KB）---`);
    } else {
      console.log('--- 预览：分享图缺失，将回退文字 ---');
      const { text, plan, bytes } = fitMarkdown(report, config);
      console.log(text);
      console.log(`--- 共 ${bytes} 字节 / 上限 4096 · 方案 ${JSON.stringify(plan)} ---`);
    }
    return;
  }

  if (img) {
    const json = await post({ msgtype: 'image', image: { base64: img.base64, md5: img.md5 } });
    if (json.errcode === 0) {
      log(`已推送分享图（${(img.bytes / 1024).toFixed(1)} KB）`);
      return;
    }
    log(`图片推送失败（${JSON.stringify(json)}），回退文字`);
  }

  const { text: content, plan, bytes } = fitMarkdown(report, config);
  log(`消息 ${bytes} 字节（上限 4096）· 方案 ${JSON.stringify(plan)}`);

  const json = await post({ msgtype: 'markdown', markdown: { content } });
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

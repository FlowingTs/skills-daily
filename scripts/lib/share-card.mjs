// 生成每日分享图：先用 HTML/CSS 排版，再用本机 Chromium 截图成 PNG。
//
// 设计：三个领域各占一段，每段的第一名是整块暖色（= 段内 100% 宽度的那条），
// 下面两个按「每天涨星数」在段内等比缩短——每段自成台阶，三段纵向排开，
// 段与段之间由 flex 平均分配剩余高度，所以某段条数少时也不会塌出大空洞。
// 领域之间的冷热差（Skills 176/天 vs MCP 5/天）不靠视觉硬比，交给数字说。
// 不用卡片、不用细线、不用边框；每条仓库都带一句人话介绍。

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { encodeQR } from './qr.mjs';
import { screenshotHTML } from './chrome-shot.mjs';
import { P } from './store.mjs';

const W = 1080;
/** 九条满配时的画布高度 */
const BASE_H = 2140;
/** 每少一条就收短这么多，免得底部空一大块 */
const ROW_H = 116;
const MIN_H = 1560;
const SCALE = 2;

/** 每个领域最多画几条 */
const PER_GROUP = 3;

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const fmtInt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');

/** 涨星数：小于 10 的保留一位小数，否则取整——MCP 那种 5.5/天 才不会被抹成 6。 */
function fmtVel(n) {
  const v = Number(n) || 0;
  if (v === 0) return '0';
  if (v < 10) {
    const s = v.toFixed(1);
    return s.endsWith('.0') ? s.slice(0, -2) : s;
  }
  return fmtInt(Math.round(v));
}

function cnDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-');
  return `${Number(y)} 年 ${Number(m)} 月 ${Number(d)} 日`;
}

/** 视觉宽度：中文算 1，ASCII 算 0.56，用来截断混排的介绍。 */
function visualLen(s) {
  let n = 0;
  for (const ch of String(s)) n += /[\x00-\xff]/.test(ch) ? 0.56 : 1;
  return n;
}

/** 按视觉宽度截断，顺手把尾部的标点清掉，免得出「…，」。 */
function clip(s, max) {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  if (visualLen(t) <= max) return t;
  let out = '';
  let n = 0;
  for (const ch of t) {
    const w = /[\x00-\xff]/.test(ch) ? 0.56 : 1;
    if (n + w > max - 1) break;
    out += ch;
    n += w;
  }
  return `${out.replace(/[，。、；：,.·:;\s-]+$/, '')}…`;
}

/**
 * 仓库名的「字符指纹」：取 repo 部分、去掉所有非字母数字、再按字符排序。
 * ai--manus 与 manus--ai 归一化后都是 aimanus，指纹相同 —— 能抓住
 * 「同一项目被批量 fork 出一堆镜像」这种污染，又几乎不会误杀正常项目。
 */
function fingerprint(fullName) {
  const repo = String(fullName).split('/').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
  return [...repo].sort().join('');
}

/** 同一领域内折叠同类镜像：同名的只留涨得最快的那条，后面用其他条目补位。 */
function dedupeMirrors(items) {
  const seenName = new Set();
  const seenSig = new Set();
  const out = [];
  for (const it of items) {
    const name = String(it.full_name).toLowerCase();
    if (seenName.has(name)) continue;
    const sig = fingerprint(it.full_name);
    // 指纹太短（比如 x/abc）容易误杀，只对够长的做字符集比对
    if (sig.length >= 6 && seenSig.has(sig)) continue;
    seenName.add(name);
    if (sig.length >= 6) seenSig.add(sig);
    out.push(it);
  }
  return out;
}

/** 二维码内联 SVG：白底 + 4 模块留白 + 黑色模块。 */
function qrSVG(text, moduleSize = 6) {
  const { matrix, size } = encodeQR(text);
  const quiet = 4;
  const total = size + quiet * 2;
  const px = total * moduleSize;
  let rects = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) {
        rects += `<rect x="${(c + quiet) * moduleSize}" y="${(r + quiet) * moduleSize}" width="${moduleSize}" height="${moduleSize}"/>`;
      }
    }
  }
  return `<svg class="qr" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}" role="img" aria-label="扫码打开日报"><rect width="${px}" height="${px}" fill="#ffffff"/><g fill="#000000">${rects}</g></svg>`;
}

/** 段内第一名：整块暖色。 */
function renderLead(it) {
  const desc = clip(it.summary || it.desc || '', 74);
  return `<div class="lead">
      <div class="lead-top">
        <span class="lead-rank">1</span>
        <span class="lead-name">${esc(it.full_name)}</span>
        <span class="lead-v">+${fmtVel(it.velocity)}<span class="u">颗/天</span></span>
      </div>
      ${desc ? `<p class="lead-desc">${esc(desc)}</p>` : ''}
    </div>`;
}

/** 段内第 2、3 名：仓库名 + 同比缩放的条 + 一句介绍。 */
function renderRow(it, rank, maxVel) {
  const v = Number(it.velocity) || 0;
  const pct = Math.max(7, Math.round((v / Math.max(1, maxVel)) * 100));
  const desc = clip(it.summary || it.desc || '', 76);
  return `<div class="row">
      <div class="row-top">
        <span class="row-rank">${rank}</span>
        <span class="row-name">${esc(it.full_name)}</span>
        <span class="row-v">+${fmtVel(v)}<span class="u">颗/天</span></span>
      </div>
      ${desc ? `<p class="row-desc">${esc(desc)}</p>` : ''}
      <div class="bar" style="width:${pct}%"></div>
    </div>`;
}

/** 一个领域一段；空榜也要占位，否则读者会以为这段被漏掉了。 */
function renderSection(g) {
  const raw = (g.items || []).filter((it) => it && it.full_name);
  const deduped = dedupeMirrors(raw);
  const items = deduped.slice(0, PER_GROUP);
  const folded = raw.length - deduped.length;
  const label = String(g.label || g.id || '').toUpperCase();
  const note = items.length
    ? g.window
      ? `近 ${g.window} 天新建`
      : '新建仓库'
    : '今天没有满足条件的仓库';

  let body;
  if (!items.length) {
    body = '<p class="empty">宁缺勿滥，这一栏今天空着。</p>';
  } else {
    const maxVel = Math.max(1, ...items.map((it) => Number(it.velocity) || 0));
    body = [
      renderLead(items[0]),
      ...items.slice(1).map((it, i) => renderRow(it, i + 2, maxVel)),
      folded > 0 ? `<p class="folded">另有 ${folded} 个同项目的镜像仓库（描述与星数雷同）未列出</p>` : '',
    ]
      .filter(Boolean)
      .join('\n      ');
  }

  return `<section class="sec">
      <div class="sec-head">
        <span class="mark"></span>
        <span class="sec-name">${esc(label)}</span>
        <span class="sec-note">${esc(note)}</span>
      </div>
      ${body}
    </section>`;
}

/** 画布高度随实际条数收缩：九条满配 2140，每少一条收 116，最低 1560。 */
export function cardHeight(groups) {
  const total = (groups || []).filter(Boolean).reduce(
    (n, g) => n + Math.min(dedupeMirrors((g.items || []).filter((it) => it && it.full_name)).length, PER_GROUP),
    0,
  );
  const h = BASE_H - Math.max(0, 9 - total) * ROW_H;
  return Math.max(MIN_H, Math.min(BASE_H, h));
}

/**
 * 生成分享图的 HTML（不含外链资源，可离线渲染）。
 * groups: [{ id, label, window, items: [{ full_name, velocity, summary }] }]
 */
export function shareCardHTML({ date, groups, url, siteName = 'SKILLS DAILY' }) {
  const list = (groups || []).filter(Boolean);
  const total = list.reduce(
    (n, g) => n + Math.min(dedupeMirrors((g.items || []).filter((it) => it && it.full_name)).length, PER_GROUP),
    0,
  );
  const h = cardHeight(list);
  const filled = list.filter((g) => dedupeMirrors((g.items || []).filter((it) => it && it.full_name)).length > 0).length;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  @page { size: ${W}px ${h}px; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${h}px; }
  body {
    background: #08080b;
    color: #edeae2;
    font-family: "Helvetica Neue", Helvetica, Arial,
                 "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC",
                 "Source Han Sans SC", "WenQuanYi Micro Hei", sans-serif;
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
    padding: 54px 68px 48px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── 页头 ── */
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 30px; flex: none; }
  h1 { font-size: 44px; line-height: 1.16; font-weight: 700; letter-spacing: -0.028em; }
  .sub { font-size: 21px; color: #9d9ca6; margin-top: 14px; font-weight: 400; line-height: 1.4; }
  .meta { text-align: right; padding-top: 4px; flex: none; }
  .brand { font-size: 21px; font-weight: 700; letter-spacing: -0.01em; }
  .date { font-size: 21px; color: #8b8a94; margin-top: 6px; }

  /* ── 三个领域：段距固定，剩余高度统一留在页脚上方 ── */
  .main {
    flex: 1; min-height: 0;
    display: flex; flex-direction: column; justify-content: flex-start;
    gap: 52px;
    padding: 40px 0 20px;
  }
  .sec { flex: none; }
  .sec-head { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; }
  .mark { width: 6px; height: 30px; background: #e6d3a7; flex: none; }
  .sec-name { font-size: 31px; font-weight: 700; letter-spacing: 0.12em; }
  .sec-note { font-size: 19px; color: #6e6d78; margin-left: auto; font-weight: 400; }

  /* 段内第一名：整块暖色 */
  .lead { background: #e6d3a7; color: #0a0a0c; padding: 22px 28px 20px; }
  .lead-top { display: flex; align-items: baseline; gap: 13px; }
  .lead-rank { font-size: 25px; font-weight: 700; opacity: .32; flex: none; }
  .lead-name {
    font-size: 33px; font-weight: 700; letter-spacing: -0.022em;
    flex: 1; min-width: 0; overflow-wrap: anywhere;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .lead-v { font-size: 41px; font-weight: 700; letter-spacing: -0.03em; flex: none; }
  .lead-v .u { font-size: 17px; font-weight: 600; opacity: .55; margin-left: 7px; letter-spacing: 0; }
  .lead-desc {
    font-size: 22px; line-height: 1.46; opacity: .76; font-weight: 500; margin-top: 11px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }

  /* 段内第 2、3 名：安静的台阶 */
  .row { margin-top: 24px; }
  .row-top { display: flex; align-items: baseline; gap: 12px; }
  .row-rank { font-size: 22px; color: #56555f; font-weight: 600; flex: none; width: 20px; }
  .row-name {
    font-size: 27px; font-weight: 600; letter-spacing: -0.015em;
    flex: 1; min-width: 0; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  .row-v { font-size: 29px; font-weight: 700; color: #e6d3a7; letter-spacing: -0.02em; flex: none; }
  .row-v .u { font-size: 15px; color: #6e6d78; margin-left: 6px; font-weight: 400; letter-spacing: 0; }
  .row-desc {
    font-size: 19px; color: #9d9ca6; line-height: 1.46; margin-top: 6px; padding-left: 32px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .bar { height: 9px; background: #6a6047; margin-top: 10px; margin-left: 32px; }
  .empty { font-size: 20px; color: #63626c; }
  .folded { font-size: 17px; color: #5c5b66; margin-top: 13px; padding-left: 32px; }

  /* ── 页脚 ── */
  footer { flex: none; padding-top: 30px; display: flex; align-items: flex-end; gap: 32px; }
  .qr { display: block; flex: none; }
  .foot-text p { font-size: 24px; line-height: 1.45; font-weight: 500; }
  .foot-text .sub2 { font-size: 20px; color: #8b8a94; margin-top: 10px; font-weight: 400; }
  .foot-text .src { font-size: 18px; color: #63626c; margin-top: 6px; font-weight: 400; }
</style>
</head>
<body>
  <header>
    <div>
      <h1>三个领域，各三个新仓库</h1>
      <p class="sub">各取涨得最快的前三 · 按平均每天拿到的 star 排</p>
    </div>
    <div class="meta">
      <div class="brand">${esc(siteName)}</div>
      <div class="date">${esc(cnDate(date))}</div>
    </div>
  </header>

  <div class="main">
    ${list.map(renderSection).join('\n    ')}
  </div>

  <footer>
    ${qrSVG(url)}
    <div class="foot-text">
      <p>长按识别二维码，进站看完整日报。</p>
      <p class="sub2">${filled} 个领域 · 共 ${total} 个新仓库，日 / 周 / 月 / 总四档可切换。</p>
      <p class="src">数据来自 GitHub，每天早八点更新</p>
    </div>
  </footer>
</body>
</html>`;
}

/**
 * 渲染并返回 PNG Buffer。
 */
export async function renderShareCard({ date, groups, url, siteName }) {
  const html = shareCardHTML({ date, groups, url, siteName });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'card-'));
  const htmlPath = path.join(tmp, 'card.html');
  try {
    await fs.writeFile(htmlPath, html, 'utf8');
    return await screenshotHTML(htmlPath, { width: W, height: cardHeight(groups), scale: SCALE });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 生成并写入分享图文件。
 */
export async function writeShareCard({ date, groups, url, siteName, outDir }) {
  const png = await renderShareCard({ date, groups, url, siteName });
  const dir = outDir || path.join(P.site, 'share');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${date}.png`);
  await fs.writeFile(file, png);
  await fs.writeFile(path.join(dir, 'latest.png'), png);
  return { path: file, bytes: png.length };
}

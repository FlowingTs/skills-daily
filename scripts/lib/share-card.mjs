// 生成每日分享图：先用 HTML/CSS 排版，再用本机 Chromium 截图成 PNG。
//
// 设计：榜首是整幅暖色块（= 100% 宽度的那条），下面四个按「每天涨星数」的
// 比例缩短，于是整张图是一个自上而下的下行阶梯——数据本身就是版式，
// 不用卡片、不用细线、不用装饰。

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { encodeQR } from './qr.mjs';
import { screenshotHTML } from './chrome-shot.mjs';
import { P } from './store.mjs';

const W = 1080;
const H = 1450;
const SCALE = 2;

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const fmtInt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');

function cnDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-');
  return `${Number(y)} 年 ${Number(m)} 月 ${Number(d)} 日`;
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

/** 第二句：把榜首和末位的差距算出来，让它成为一句真实的话，而不是标签。 */
function supportSentence(list) {
  if (list.length < 2) return '按新建仓库平均每天拿到的 star 排。';
  const top = Math.round(list[0].velocity ?? 0);
  const last = Math.round(list[list.length - 1].velocity ?? 0);
  const cn = { 2: '二', 3: '三', 4: '四', 5: '五' };
  const ordinal = `第${cn[list.length] || list.length}名`;
  if (last <= 0) return `第一名每天涨 ${top} 颗，其余几个还在个位数。`;
  const ratio = (top / last).toFixed(1).replace(/\.0$/, '');
  return `第一名每天涨 ${top} 颗，是${ordinal}的 ${ratio} 倍。`;
}

/**
 * 生成分享图的 HTML（不含外链资源，可离线渲染）。
 */
export function shareCardHTML({ date, items, url, siteName = 'SKILLS DAILY' }) {
  const list = (items || []).filter((it) => it && it.full_name).slice(0, 5);
  const top = list[0] || null;
  const rest = list.slice(1);
  const maxVel = Math.max(1, ...list.map((it) => Math.round(it.velocity ?? 0)));

  const heroName = top?.full_name ?? '今天没有新冒出来的仓库';
  const heroVel = top ? Math.round(top.velocity ?? 0) : 0;

  const rows = rest
    .map((it, i) => {
      const v = Math.round(it.velocity ?? 0);
      const pct = Math.max(6, Math.round((v / maxVel) * 100));
      return `<li>
      <div class="row-head">
        <span class="n">${i + 2}</span>
        <span class="name">${esc(it.full_name)}</span>
        <span class="v">+${fmtInt(v)}</span><span class="u">颗/天</span>
      </div>
      <div class="bar" style="width:${pct}%"></div>
    </li>`;
    })
    .join('\n    ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  @page { size: ${W}px ${H}px; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; }
  body {
    background: #08080b;
    color: #edeae2;
    font-family: "Helvetica Neue", Helvetica, Arial,
                 "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC",
                 "Source Han Sans SC", "WenQuanYi Micro Hei", sans-serif;
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
    padding: 62px 72px 54px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── 页头 ── */
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 28px; }
  h1 { font-size: 47px; line-height: 1.1; font-weight: 700; letter-spacing: -0.025em; white-space: nowrap; }
  .sub { font-size: 24px; color: #9d9ca6; margin-top: 18px; font-weight: 400; }
  .meta { text-align: right; padding-top: 2px; flex: none; }
  .brand { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
  .date { font-size: 22px; color: #8b8a94; margin-top: 7px; }

  /* ── 榜首：整幅暖色块 ── */
  .hero {
    margin-top: 40px;
    background: #e6d3a7;
    color: #0a0a0c;
    padding: 38px 40px 32px;
    display: flex; flex-direction: column; justify-content: space-between;
    height: 384px;
  }
  .hero-line { display: flex; align-items: baseline; gap: 16px; }
  .rank { font-size: 38px; font-weight: 700; opacity: .34; }
  .hero-name {
    font-size: 43px; font-weight: 700; letter-spacing: -0.025em;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .hero-fig { display: flex; align-items: baseline; gap: 14px; }
  .hero-num { font-size: 172px; font-weight: 700; letter-spacing: -0.05em; line-height: .78; }
  .hero-unit { font-size: 26px; font-weight: 600; opacity: .58; }
  .hero-cap { font-size: 21px; font-weight: 500; opacity: .55; margin-top: 20px; }

  /* ── 其余四个：条形的阶梯 ── */
  .rest { margin-top: 44px; list-style: none; }
  .rest li { margin-bottom: 56px; }
  .rest li:last-child { margin-bottom: 0; }
  .row-head { display: flex; align-items: baseline; gap: 4px; }
  .rest .n { font-size: 28px; color: #67666f; font-weight: 500; width: 46px; flex: none; }
  .rest .name {
    font-size: 32px; font-weight: 600; letter-spacing: -0.015em;
    flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .rest .v { font-size: 36px; font-weight: 700; color: #e6d3a7; letter-spacing: -0.02em; }
  .rest .u { font-size: 17px; color: #6e6d78; margin-left: 7px; font-weight: 400; }
  .bar { height: 16px; background: #6a6047; margin-top: 16px; }

  /* ── 页脚 ── */
  footer {
    margin-top: auto;
    display: flex; align-items: flex-end; gap: 34px;
  }
  .qr { display: block; flex: none; }
  .foot-text p { font-size: 25px; line-height: 1.45; font-weight: 500; }
  .foot-text .sub2 { font-size: 21px; color: #8b8a94; margin-top: 11px; font-weight: 400; }
  .foot-text .src { font-size: 19px; color: #63626c; margin-top: 7px; font-weight: 400; }
</style>
</head>
<body>
  <header>
    <div>
      <h1>昨天新冒出来的 ${list.length} 个仓库</h1>
      <p class="sub">${esc(supportSentence(list))}</p>
    </div>
    <div class="meta">
      <div class="brand">${esc(siteName)}</div>
      <div class="date">${esc(cnDate(date))}</div>
    </div>
  </header>

  <section class="hero">
    <div class="hero-line">
      <span class="rank">1</span>
      <span class="hero-name">${esc(heroName)}</span>
    </div>
    <div>
      <div class="hero-fig">
        <span class="hero-num">+${fmtInt(heroVel)}</span>
        <span class="hero-unit">颗星 / 天</span>
      </div>
      <div class="hero-cap">新建仓库 · 近 7 天平均每天拿到的 star</div>
    </div>
  </section>

  <ol class="rest" start="2">
    ${rows}
  </ol>

  <footer>
    ${qrSVG(url)}
    <div class="foot-text">
      <p>长按识别二维码，进站看完整日报。</p>
      <p class="sub2">日 / 周 / 月 / 总 四档榜单可切换，另有两份潜力榜。</p>
      <p class="src">数据来自 GitHub，每天早八点更新</p>
    </div>
  </footer>
</body>
</html>`;
}

/**
 * 渲染并返回 PNG Buffer。
 */
export async function renderShareCard({ date, items, url, siteName }) {
  const html = shareCardHTML({ date, items, url, siteName });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'card-'));
  const htmlPath = path.join(tmp, 'card.html');
  try {
    await fs.writeFile(htmlPath, html, 'utf8');
    return await screenshotHTML(htmlPath, { width: W, height: H, scale: SCALE });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 生成并写入分享图文件。
 */
export async function writeShareCard({ date, items, url, siteName, outDir }) {
  const png = await renderShareCard({ date, items, url, siteName });
  const dir = outDir || path.join(P.site, 'share');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${date}.png`);
  await fs.writeFile(file, png);
  await fs.writeFile(path.join(dir, 'latest.png'), png);
  return { path: file, bytes: png.length };
}

// 生成每日分享图（竖版 PNG，黑色宇宙风）。
// 图上：标题、日期、潜力榜 Top5 仓库名 + star 净增、二维码（扫码进首页）。
// 纯 Node 零依赖：自绘 bitmap + 5×7 点阵字体 + 自实现 QR + 自实现 PNG。

import fs from 'node:fs/promises';
import path from 'node:path';
import { encodePNG } from './png.mjs';
import { encodeQR } from './qr.mjs';
import { glyph } from './font5x7.mjs';
import { P } from './store.mjs';

// ── 配色（与站点 style.css 的黑色宇宙一致） ──
const BG = [6, 6, 9];        // --bg: #060609
const ACCENT = [230, 211, 167]; // --accent: #e6d3a7 暖星色
const TEXT = [236, 234, 228];   // 主文字
const MUTED = [128, 128, 138];  // 次要文字
const WARN = [255, 168, 92];    // 涨（暖橙，与 +N 呼应）
const CARD = [16, 16, 22];      // 卡片底色

// ── 画布 ──
class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h * 4);
  }
  set(x, y, [r, g, b, a = 255]) {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    // 简单 alpha 混合（源覆盖）
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = a;
  }
  fillRect(x, y, w, h, color) {
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) this.set(xx, yy, color);
  }
  // 画圆角矩形（用于卡片）
  fillRoundRect(x, y, w, h, r, color) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        let inside = true;
        if (xx < x + r && yy < y + r) inside = (xx - (x + r)) ** 2 + (yy - (y + r)) ** 2 <= r * r;
        else if (xx >= x + w - r && yy < y + r) inside = (xx - (x + w - r - 1)) ** 2 + (yy - (y + r)) ** 2 <= r * r;
        else if (xx < x + r && yy >= y + h - r) inside = (xx - (x + r)) ** 2 + (yy - (y + h - r - 1)) ** 2 <= r * r;
        else if (xx >= x + w - r && yy >= y + h - r) inside = (xx - (x + w - r - 1)) ** 2 + (yy - (y + h - r - 1)) ** 2 <= r * r;
        if (inside) this.set(xx, yy, color);
      }
    }
  }
  // 画点阵字符（scale = 每个点放大倍数）
  drawGlyph(g, x, y, scale, color) {
    if (!g) return;
    for (let col = 0; col < 5; col++) {
      const bits = g[col];
      for (let row = 0; row < 7; row++) {
        if (bits & (1 << row)) {
          this.fillRect(x + col * scale, y + row * scale, scale, scale, color);
        }
      }
    }
  }
  text(str, x, y, scale, color) {
    let cx = x;
    for (const ch of str) {
      const g = glyph(ch);
      if (g) {
        this.drawGlyph(g, cx, y, scale, color);
        cx += 6 * scale; // 5 列 + 1 空格
      } else {
        cx += 6 * scale; // 未知字符占位
      }
    }
    return cx; // 返回结束 x
  }
  textWidth(str, scale) {
    return str.length * 6 * scale;
  }
  centeredText(str, y, scale, color) {
    const w = this.textWidth(str, scale);
    this.text(str, Math.floor((this.w - w) / 2), y, scale, color);
  }
}

// 把 QR 布尔矩阵画到画布（带白色 quiet zone）
function drawQR(canvas, matrix, size, qx, qy, cell) {
  const quiet = 4; // 4 模块 quiet zone
  const total = size + quiet * 2;
  const box = total * cell;
  // 白色背景
  canvas.fillRect(qx, qy, box, box, [255, 255, 255]);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) {
        canvas.fillRect(qx + (c + quiet) * cell, qy + (r + quiet) * cell, cell, cell, [6, 6, 9]);
      }
    }
  }
  return box;
}

/**
 * 生成分享图，返回 PNG Buffer。
 * @param {object} opts
 * @param {string} opts.date  YYYY-MM-DD
 * @param {Array}  opts.items 潜力榜 Top 项 [{full_name, velocity}]
 * @param {string} opts.url  二维码内容（首页地址）
 */
export function renderShareCard({ date, items, url }) {
  const W = 1080;
  const H = 1450;
  const c = new Canvas(W, H);
  c.fillRect(0, 0, W, H, BG);

  // 顶部装饰线（暖星色）
  c.fillRect(0, 0, W, 6, ACCENT);

  // 标题 SKILLS DAILY
  const title = 'SKILLS DAILY';
  c.centeredText(title, 90, 5, ACCENT);

  // 副标题 + 日期
  const subtitle = `GITHUB RISING · ${date.replace(/-/g, '.')}`;
  c.centeredText(subtitle, 150, 2, MUTED);

  // 分割线
  c.fillRect(80, 210, W - 160, 2, [40, 40, 50]);

  // 榜单标题
  c.centeredText('TODAY RISING TOP', 250, 3, TEXT);

  // 卡片列表
  const cardX = 90;
  const cardW = W - 180;
  const cardH = 130;
  const cardGap = 24;
  const listStartY = 320;
  const maxItems = Math.min(items.length, 5);

  for (let i = 0; i < maxItems; i++) {
    const it = items[i];
    const cy = listStartY + i * (cardH + cardGap);
    c.fillRoundRect(cardX, cy, cardW, cardH, 20, CARD);

    // 序号
    const num = String(i + 1);
    c.text(num, cardX + 36, cy + 45, 4, ACCENT);

    // 仓库名 owner/repo（可能过长，截断）
    const name = it.full_name || '';
    const nameScale = 3;
    const maxNameChars = Math.floor((cardW - 160) / (6 * nameScale));
    let shown = name;
    if (shown.length > maxNameChars) shown = shown.slice(0, maxNameChars - 1) + '~';
    c.text(shown, cardX + 100, cy + 40, nameScale, TEXT);

    // star 净增
    const vel = Math.round(it.velocity ?? 0);
    const velText = `+${vel}/day`;
    c.text(velText, cardX + 100, cy + 80, 2, WARN);
  }

  // 底部二维码区
  const footerY = listStartY + maxItems * (cardH + cardGap) + 50;
  c.centeredText('SCAN TO OPEN', footerY, 3, TEXT);
  c.centeredText('LONG-PRESS TO SCAN', footerY + 40, 2, MUTED);

  // 二维码（居中，白色 quiet zone）
  const qrMatrix = qrMatrixFor(url);
  const qrCell = 5;
  const qrTotal = qrMatrix.length + 8; // 矩阵 + 2*4 模块 quiet zone
  const qx = Math.floor((W - qrTotal * qrCell) / 2);
  const qy = footerY + 90;
  drawQR(c, qrMatrix, qrMatrix.length, qx, qy, qrCell);

  return encodePNG(W, H, c.data);
}

// 缓存 QR 矩阵避免重复计算
function qrMatrixFor(url) {
  return encodeQR(url).matrix;
}

/**
 * 生成并写入分享图文件。
 */
export async function writeShareCard({ date, items, url, outDir }) {
  const png = renderShareCard({ date, items, url });
  const dir = outDir || path.join(P.site, 'share');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${date}.png`), png);
  await fs.writeFile(path.join(dir, 'latest.png'), png);
  return { path: path.join(dir, `${date}.png`), bytes: png.length };
}

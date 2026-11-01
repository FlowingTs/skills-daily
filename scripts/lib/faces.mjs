import fs from 'node:fs/promises';
import path from 'node:path';
import { P } from './store.mjs';
import { log, sleep } from './util.mjs';

const FACE_DIR = path.join(P.site, 'assets', 'faces');
const CARD_DIR = path.join(P.site, 'assets', 'cards');

const FACE_LIMIT = 800;
const CARD_KEEP_DAYS = 14;

// 阈值别定太高：纯色 logo、小尺寸组织头像常常只有几百字节，
// 512 会把它们当坏图丢掉（实测 365 字节的合法 png 被判失败）。
const MIN_BYTES = 200;

async function exists(file) {
  try {
    const st = await fs.stat(file);
    return st.size > MIN_BYTES;
  } catch {
    return false;
  }
}

async function existingFace(owner) {
  for (const ext of ['png', 'jpg']) {
    const f = path.join(FACE_DIR, `${owner}.${ext}`);
    if (await exists(f)) return `${owner}.${ext}`;
  }
  return null;
}

async function download(url, dest, { timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'skills-daily/1.0' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return false;
    const type = res.headers.get('content-type') || '';
    if (!/^image\//i.test(type)) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < MIN_BYTES) return false;
    // 按真实类型落盘：github 的头像有 jpeg 也有 png，扩展名写错会让浏览器拿错 MIME
    const ext = /jpeg|jpg/i.test(type) ? 'jpg' : 'png';
    const final = dest.replace(/\.[a-z]+$/, `.${ext}`);
    await fs.mkdir(path.dirname(final), { recursive: true });
    await fs.writeFile(final, buf);
    return final;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * github.com/<owner>.png 对新建的组织账号会返回 404。
 * 退一步问接口要 avatar_url（多一个请求，只在第一种取法失败时发生）。
 */
async function avatarFromApi(owner) {
  const token = process.env.GITHUB_TOKEN || '';
  if (!token) return null;
  try {
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(owner)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'skills-daily/1.0',
      },
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j.avatar_url || null;
  } catch {
    return null;
  }
}

/**
 * 把头像和仓库卡片下载到本地。
 * 页面因此不依赖 github.com 的可用性，国内打开也不会一片空白。
 */
export async function fetchImages(entries, date, { onCard = null } = {}) {
  await fs.mkdir(FACE_DIR, { recursive: true });
  await fs.mkdir(CARD_DIR, { recursive: true });

  const owners = [...new Set(entries.map((e) => e.repo.full_name.split('/')[0]))];
  const faces = {};
  let fetched = 0;
  let missed = 0;

  for (const owner of owners) {
    let file = await existingFace(owner);
    if (!file) {
      const dest = path.join(FACE_DIR, `${owner}.png`);
      let saved = await download(`https://github.com/${owner}.png?size=96`, dest);
      if (!saved) {
        const alt = await avatarFromApi(owner);
        if (alt) saved = await download(alt, dest);
      }
      if (saved) { file = path.basename(saved); fetched++; }
      else missed++;
      await sleep(60);
    }
    if (file) faces[owner] = file;
  }

  let cardPath = null;
  if (onCard) {
    const [owner, name] = onCard.full_name.split('/');
    const file = `${date}-${owner}__${name}.png`;
    const dest = path.join(CARD_DIR, file);
    if (!(await exists(dest))) {
      await download(`https://opengraph.githubassets.com/1/${onCard.full_name}`, dest, { timeout: 25000 });
    }
    if (await exists(dest)) cardPath = `assets/cards/${file}`;
  }

  await prune();
  log(`图片：头像新增 ${fetched} 个、失败 ${missed} 个；卡片 ${cardPath ?? '无'}`);
  return { cardPath, faces };
}

async function prune() {
  // 头像：按 mtime 保留最近 FACE_LIMIT 个
  try {
    const files = await fs.readdir(FACE_DIR);
    if (files.length > FACE_LIMIT) {
      const stats = await Promise.all(
        files.map(async (f) => ({ f, t: (await fs.stat(path.join(FACE_DIR, f))).mtimeMs })),
      );
      stats.sort((a, b) => b.t - a.t);
      for (const { f } of stats.slice(FACE_LIMIT)) {
        await fs.unlink(path.join(FACE_DIR, f)).catch(() => {});
      }
    }
  } catch { /* 忽略 */ }

  // 卡片：文件名带日期，删掉过期的
  try {
    const cutoff = new Date(Date.now() - CARD_KEEP_DAYS * 86400000).toISOString().slice(0, 10);
    const files = await fs.readdir(CARD_DIR);
    for (const f of files) {
      if (f.slice(0, 10) < cutoff) await fs.unlink(path.join(CARD_DIR, f)).catch(() => {});
    }
  } catch { /* 忽略 */ }
}

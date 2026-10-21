import { log, sleep } from './util.mjs';

const API = 'https://api.github.com';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

export const hasToken = () => Boolean(TOKEN);

const stats = { calls: 0, searchCalls: 0, remaining: null };
export const getStats = () => ({ ...stats });

let lastSearchAt = 0;
let minSearchInterval = 2100;

export function setSearchInterval(ms) {
  minSearchInterval = ms;
}

function headers(accept = 'application/vnd.github+json') {
  const h = { Accept: accept, 'User-Agent': 'skills-daily/1.0', 'X-GitHub-Api-Version': '2022-11-28' };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

async function request(url, { accept, retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    stats.calls++;
    let res;
    try {
      res = await fetch(url, { headers: headers(accept) });
    } catch (err) {
      if (attempt === retries) throw new Error(`network ${url}: ${err.message}`);
      await sleep(1500 * (attempt + 1));
      continue;
    }

    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining !== null) stats.remaining = Number(remaining);

    if (res.status === 200 || res.status === 304) {
      return { ok: true, data: await res.json(), headers: res.headers };
    }
    if (res.status === 404) {
      return { ok: false, status: 404, data: null };
    }
    if (res.status === 401) {
      throw new Error('GitHub 401：token 无效或缺失（代码搜索/star 历史接口必须鉴权）');
    }
    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || 0);
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0);
      const waitMs = retryAfter
        ? retryAfter * 1000
        : reset
          ? Math.max(1000, reset * 1000 - Date.now() + 500)
          : 3000;
      if (remaining === '0' || res.status === 429) {
        log(`限流，等待 ${Math.round(waitMs / 1000)}s`);
        await sleep(Math.min(waitMs, 65000));
        continue;
      }
      if (attempt === retries) {
        const body = await res.text().catch(() => '');
        throw new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`);
      }
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (attempt === retries) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`);
    }
    await sleep(1200 * (attempt + 1));
  }
  return { ok: false, status: 0, data: null };
}

/** 仓库搜索 */
export async function searchRepos(q, { sort = 'stars', order = 'desc', perPage = 100, page = 1 } = {}) {
  const gap = Date.now() - lastSearchAt;
  if (gap < minSearchInterval) await sleep(minSearchInterval - gap);
  lastSearchAt = Date.now();
  stats.searchCalls++;

  const url = `${API}/search/repositories?q=${encodeURIComponent(q)}&sort=${sort}&order=${order}&per_page=${perPage}&page=${page}`;
  const r = await request(url);
  if (!r.ok || !r.data) return { total: 0, items: [] };
  return { total: r.data.total_count || 0, items: r.data.items || [] };
}

/** 代码搜索：验证仓库里是否真的存在 SKILL.md（需要 token） */
export async function verifySkillFile(fullName) {
  if (!TOKEN) return null;
  const gap = Date.now() - lastSearchAt;
  if (gap < minSearchInterval) await sleep(minSearchInterval - gap);
  lastSearchAt = Date.now();
  stats.searchCalls++;

  const q = `filename:SKILL.md repo:${fullName}`;
  const r = await request(`${API}/search/code?q=${encodeURIComponent(q)}&per_page=1`);
  if (!r.ok) return null;
  return (r.data.total_count || 0) > 0;
}

/**
 * 采样某仓库最近窗口内的 star 事件数（仅在有 token 时可用）。
 * 通过 stargazers 端点分页读取 starred_at，自动识别正序/倒序。
 * 返回 { windowDays: count }，失败返回 null。
 */
export async function sampleRecentStars(fullName, stars, windows = [1, 7, 30], maxPages = 6) {
  if (!TOKEN || !stars) return null;
  const totalPages = Math.max(1, Math.ceil(stars / 100));
  const acc = [];

  const fetchPage = async (p) => {
    const r = await request(`${API}/repos/${fullName}/stargazers?per_page=100&page=${p}`, {
      accept: 'application/vnd.github.star+json',
    });
    if (!r.ok || !Array.isArray(r.data)) return null;
    return r.data.map((x) => x.starred_at).filter(Boolean);
  };

  const first = await fetchPage(1);
  if (!first || first.length === 0) return null;

  let descending = true;
  if (first.length > 1) descending = Date.parse(first[0]) >= Date.parse(first[first.length - 1]);

  acc.push(...first);

  // 从最新往旧翻页
  let page = descending ? 1 : totalPages;
  const step = descending ? 1 : -1;
  const oldestWindowMs = Math.max(...windows) * 86400000;

  for (let i = 0; i < maxPages; i++) {
    const ts = i === 0 ? first : await fetchPage(page);
    if (!ts || ts.length === 0) break;
    if (i > 0) acc.push(...ts);
    const oldest = Math.min(...ts.map((t) => Date.parse(t)));
    if (Date.now() - oldest > oldestWindowMs) break;
    page += step;
    if (page < 1 || page > totalPages) break;
  }

  const now = Date.now();
  const out = {};
  for (const w of windows) {
    const cutoff = now - w * 86400000;
    out[w] = acc.filter((t) => Date.parse(t) >= cutoff).length;
  }
  return { windows: out, sampled: acc.length };
}

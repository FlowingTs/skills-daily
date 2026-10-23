#!/usr/bin/env node
/**
 * 一键触发日报工作流。
 *
 * 用途：GitHub 自带的 schedule 在这个仓库上不派发（已验证：3 个窗口、2 个工作流全都没触发），
 * 所以定时这一层必须由仓库外的调度器来承担。这个脚本就是所有外部方案共用的那一个动作。
 *
 * 用法：
 *   GH_TOKEN=xxx node scripts/dispatch.mjs
 *   node scripts/dispatch.mjs          # 从 .dispatch-token 文件读
 *
 * 退出码：0 成功受理，1 失败。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.SD_REPO || 'FlowingTs/skills-daily';
const WORKFLOW = process.env.SD_WORKFLOW || 'daily.yml';
const REF = process.env.SD_REF || 'main';

async function readToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  for (const f of [path.join(ROOT, '.dispatch-token'), path.join(ROOT, '..', '.dispatch-token')]) {
    try {
      const t = (await fs.readFile(f, 'utf8')).trim();
      if (t) return t;
    } catch {
      /* 继续找下一个 */
    }
  }
  return '';
}

const token = await readToken();
if (!token) {
  console.error('缺少 token：请设 GH_TOKEN 环境变量，或在项目根目录放 .dispatch-token 文件。');
  process.exit(1);
}

const url = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;
const stamp = new Date().toISOString();

try {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'skills-daily-dispatcher',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: REF }),
  });

  if (res.status === 204) {
    console.log(`[${stamp}] 已触发 ${REPO}/${WORKFLOW} @ ${REF}`);
    process.exit(0);
  }

  const body = await res.text();
  console.error(`[${stamp}] 触发失败 ${res.status}: ${body.slice(0, 300)}`);
  process.exit(1);
} catch (err) {
  console.error(`[${stamp}] 网络错误: ${err.message}`);
  process.exit(1);
}

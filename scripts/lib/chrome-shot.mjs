// 用本机 Chromium 内核浏览器（Chrome / Edge / Chromium）把 HTML 截成 PNG。
// 零依赖：只 spawn，不装任何东西。找不到浏览器时抛错，由调用方降级。

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const CANDIDATES = [
  // Windows
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

/** 返回可用的浏览器可执行文件路径，找不到返回 null。 */
export function findBrowser() {
  const fromEnv = process.env.CHROME_PATH || process.env.BROWSER_PATH;
  if (fromEnv && fsSync.existsSync(fromEnv)) return fromEnv;
  for (const p of CANDIDATES) {
    if (fsSync.existsSync(p)) return p;
  }
  return null;
}

/**
 * 把本地 HTML 文件截图为 PNG。
 * @param {string} htmlPath 绝对路径
 * @param {object} opts { width, height, scale, outPath }
 * @returns {Promise<Buffer>} PNG 内容
 */
export async function screenshotHTML(htmlPath, { width = 1080, height = 1450, scale = 2, outPath } = {}) {
  const bin = findBrowser();
  if (!bin) throw new Error('未找到 Chrome / Edge / Chromium，无法截图');

  const out = outPath || path.join(os.tmpdir(), `shot-${Date.now()}.png`);
  // 每次用独立 profile，避免和正在运行的浏览器抢锁
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'shot-profile-'));

  const url = `file:///${htmlPath.replace(/\\/g, '/').replace(/^\//, '')}`;
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--allow-file-access-from-files',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    `--force-device-scale-factor=${scale}`,
    '--virtual-time-budget=1500',
    `--screenshot=${out}`,
    url,
  ];

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      const timer = setTimeout(() => { child.kill(); reject(new Error('截图超时（30s）')); }, 30000);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        // Chrome 在不支持某些参数时也会返回 0，是否成功以下面的文件检查为准
        if (code !== 0 && !fsSync.existsSync(out)) {
          reject(new Error(`浏览器退出码 ${code}：${stderr.slice(-400)}`));
        } else {
          resolve();
        }
      });
    });
    const buf = await fs.readFile(out);
    if (!buf.length) throw new Error('截图文件为空');
    return buf;
  } finally {
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
    await fs.rm(out, { force: true }).catch(() => {});
  }
}

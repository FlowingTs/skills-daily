import fs from 'node:fs/promises';
import path from 'node:path';
import { P } from './lib/store.mjs';
import { addDays, bjToday, log } from './lib/util.mjs';

/**
 * 幂等守卫：最近刚生成过同一份报告就直接跳过。
 *
 * 这里**不用「是不是今天生成的」**来判断，因为自然日的边界太宽：
 * 凌晨为了排查问题手动重跑一次，就会把当天早上八点的定时发布额度吃掉，
 * 于是八点那次被判为重复、静默跳过，当天就收不到日报。
 *
 * 改成看「距上次生成过了多久」：
 *   - 凌晨跑过 → 早上八点距 6 小时以上 → 照常发布；
 *   - 八点发完之后，第二个定时窗口（半小时后）→ 不到 4 小时 → 跳过，不会重复推送。
 */
const target = process.env.REPORT_DATE || addDays(bjToday(), -1);
const force = ['1', 'true', 'yes'].includes(String(process.env.FORCE || '').toLowerCase());

/** 4 小时内生成过的视为「刚发过」；超过就重新生成 */
const STALE_MS = 4 * 60 * 60 * 1000;

/**
 * 解析报告里的 generated_at（形如 2026-11-14T01:51，北京时间、不带时区）。
 * 不能直接交给 Date.parse：CI 跑在 UTC 机器上，会把它当成本地时间，凭空差 8 小时。
 */
function bjTimestamp(s) {
  const m = String(s ?? '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return NaN;
  const [, y, mo, d, hh = '0', mm = '0'] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh) - 8, Number(mm));
}

async function emit(skip, reason) {
  log(`幂等检查：${reason}`);
  const line = `skip=${skip ? 'true' : 'false'}\n`;
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, line, 'utf8');
  } else {
    process.stdout.write(line);
  }
}

/** 把毫秒时长说成人话，日志里看得懂 */
function human(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} 小时 ${rest} 分钟` : `${h} 小时`;
}

if (force) {
  await emit(false, 'FORCE=1，强制运行');
  process.exit(0);
}

const file = path.join(P.daily, `${target}.json`);
let existing = null;
try {
  existing = JSON.parse(await fs.readFile(file, 'utf8'));
} catch {
  existing = null;
}

const genAt = bjTimestamp(existing?.generated_at);
const ageMs = Date.now() - genAt;
// 时间字段缺失或解析不出来时，宁可重跑一次，也不要漏发。
const fresh = Number.isFinite(genAt) && ageMs >= 0 && ageMs < STALE_MS;

if (fresh) {
  await emit(true, `${target} 的报告 ${human(ageMs)}前刚生成过（${existing.generated_at}），跳过`);
} else if (existing) {
  await emit(
    false,
    Number.isFinite(genAt)
      ? `${target} 的报告已生成 ${human(ageMs)}，超过 4 小时，重新生成`
      : `${target} 的报告时间无法识别（${existing.generated_at ?? '缺失'}），重新生成`,
  );
} else {
  await emit(false, `${target} 尚无报告，开始生成`);
}

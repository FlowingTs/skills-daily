import fs from 'node:fs/promises';
import path from 'node:path';
import { P } from './lib/store.mjs';
import { addDays, bjToday, log } from './lib/util.mjs';

/**
 * 幂等守卫：判断这次触发该不该真的干活。
 *
 * 要同时挡住两件相反的事，所以单一条件都不够：
 *
 *  1) 上午八点的正式发布必须发出。哪怕凌晨为了排查问题手动重跑过一次，
 *     也不能把早八点的额度吃掉（只用「今天生成过」判断会踩这个坑）。
 *  2) 下午的补跑不能重复推送。GitHub 自己的 schedule 会延迟几个小时才派发，
 *     同一份日报下午又发一遍，用户一天收到两次（只用「N 小时内」判断会踩这个坑）。
 *
 * 解法是引入「发布窗口」：只有北京时间 07:00–11:00 才算正式发布时段。
 *
 *   - 今天已生成 + 在窗口内 + 距上次超过 4 小时  → 重新生成（覆盖凌晨那次）
 *   - 今天已生成 + 其它任何情况                  → 跳过（下午补跑、同日第二个窗口都走这条）
 *   - 今天还没生成                              → 生成（cron-job.org 挂了时，下午补跑也能兜住）
 */
const target = process.env.REPORT_DATE || addDays(bjToday(), -1);
const force = ['1', 'true', 'yes'].includes(String(process.env.FORCE || '').toLowerCase());

/** 正式发布时段（北京时间），含头不含尾 */
const WINDOW_START = 7;
const WINDOW_END = 11;
/** 同一天里两次正式窗口至少隔这么久，避免连发 */
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

/** 当前北京时间的小时数；不依赖运行机器的时区 */
function bjHour(now = new Date()) {
  return (now.getUTCHours() + 8) % 24;
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
  if (!Number.isFinite(ms)) return '未知时长';
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

// 这两个只给测试用（模拟某个时间点、指向一份临时报告），生产环境不会设置。
const file = process.env.GUARD_FILE || path.join(P.daily, `${target}.json`);
const now = process.env.GUARD_NOW ? new Date(process.env.GUARD_NOW) : new Date();

let existing = null;
try {
  existing = JSON.parse(await fs.readFile(file, 'utf8'));
} catch {
  existing = null;
}

const today = bjToday();
const genDate = String(existing?.generated_at ?? '').slice(0, 10);
const genAt = bjTimestamp(existing?.generated_at);
const ageMs = now.getTime() - genAt;
const generatedToday = genDate === today;
const hour = bjHour(now);
const inWindow = hour >= WINDOW_START && hour < WINDOW_END;

if (existing && generatedToday) {
  if (inWindow && ageMs >= STALE_MS) {
    await emit(
      false,
      `${target} 今天 ${existing.generated_at.slice(11)} 已生成过，现在在发布窗口内且已过 ${human(ageMs)}，重新生成`,
    );
  } else if (!inWindow) {
    await emit(
      true,
      `${target} 今天已生成过，当前 ${hour} 点不在发布窗口（${WINDOW_START}–${WINDOW_END} 点），跳过`,
    );
  } else {
    await emit(true, `${target} 今天 ${human(ageMs)}前刚生成过，跳过`);
  }
} else if (existing) {
  await emit(
    false,
    Number.isFinite(genAt)
      ? `${target} 的报告还停留在 ${genDate || '未知日期'}，今天还没生成，开始生成`
      : `${target} 的报告时间无法识别（${existing.generated_at ?? '缺失'}），重新生成`,
  );
} else {
  await emit(false, `${target} 尚无报告，开始生成`);
}

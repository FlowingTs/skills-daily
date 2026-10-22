import fs from 'node:fs/promises';
import path from 'node:path';
import { P } from './lib/store.mjs';
import { addDays, bjToday, log } from './lib/util.mjs';

/**
 * 幂等守卫：今天已经生成过同一份报告就直接跳过。
 * GitHub 的 schedule 在整点可能被判为过载而丢弃，所以工作流配了两个时段，
 * 谁先跑到谁干活，后到的这个守卫会让它直接退出，不会重复推送。
 */
const target = process.env.REPORT_DATE || addDays(bjToday(), -1);
const today = bjToday();
const force = process.env.FORCE === '1';

async function emit(skip, reason) {
  log(`幂等检查：${reason}`);
  const line = `skip=${skip ? 'true' : 'false'}\n`;
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, line, 'utf8');
  } else {
    process.stdout.write(line);
  }
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

if (existing?.generated_at?.startsWith(today)) {
  await emit(true, `${target} 的报告已于今天 ${existing.generated_at.slice(11)} 生成，跳过`);
} else if (existing) {
  await emit(false, `${target} 的报告是旧的（${existing.generated_at ?? '未知时间'}），重新生成`);
} else {
  await emit(false, `${target} 尚无报告，开始生成`);
}

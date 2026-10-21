import { esc, fmtNum, fmtDelta, cnDate, bjNowISO } from './util.mjs';

function timeAgo(iso) {
  if (!iso) return '—';
  const h = (Date.now() - Date.parse(iso)) / 3600000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} 分钟前`;
  if (h < 24) return `${Math.round(h)} 小时前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} 天前`;
  return `${Math.round(d / 30)} 个月前`;
}

function scoreClass(v) {
  if (v >= 80) return 'high';
  if (v < 55) return 'low';
  return '';
}

function renderCard(item, index, column, root) {
  const r = item.repo;
  const [owner, name] = r.full_name.split('/');
  const rank = String(index + 1).padStart(2, '0');
  const topClass = index === 0 ? 'top1' : index === 1 ? 'top2' : index === 2 ? 'top3' : '';

  let metricHtml;
  if (column.metric === 'delta' && typeof item.delta === 'number') {
    metricHtml = `<span class="metric ${item.delta > 0 ? '' : 'zero'}">${esc(fmtDelta(item.delta))}</span>`;
  } else if (column.metric === 'delta' && item.approx) {
    metricHtml = `<span class="metric total">≈${fmtNum(r.stargazers_count)}</span>`;
  } else {
    metricHtml = `<span class="metric total">${fmtNum(r.stargazers_count)}</span>`;
  }

  const noteHtml = item.summary
    ? `<p class="note">${esc(item.summary)}</p>`
    : `<p class="note raw">${esc((r.description || '仓库未提供描述').slice(0, 160))}</p>`;

  const tags = (r.topics || [])
    .filter((t) => !['skills', 'skill', 'ai', 'claude'].includes(t))
    .slice(0, 4)
    .map((t) => `<span class="tag-chip">${esc(t)}</span>`)
    .join('');

  const score = item.score ?? 0;

  return `<article class="card ${topClass}" style="--i:${index}">
  <div class="rank"><span>${rank}</span></div>
  <div class="card-body">
    <div class="card-head">
      <a class="repo" href="${esc(r.html_url)}" target="_blank" rel="noopener">
        <span class="owner">${esc(owner)}</span><span class="slash">/</span>${esc(name)}
      </a>
      ${metricHtml}
    </div>
    ${noteHtml}
    <div class="meta-row">
      <span><b>★</b> ${fmtNum(r.stargazers_count)}</span>
      <span><b>⑂</b> ${fmtNum(r.forks_count)}</span>
      ${r.language ? `<span><b>◆</b> ${esc(r.language)}</span>` : ''}
      <span>更新 ${esc(timeAgo(r.pushed_at))}</span>
      <span>建于 ${esc((r.created_at || '').slice(0, 7).replace('-', '.'))}</span>
      <div class="score ${scoreClass(score)}">
        <span class="label">REC</span>
        <div class="bar"><i style="--w:${score}%"></i></div>
        <span class="val">${score}</span>
      </div>
    </div>
    ${tags ? `<div class="meta-row"><div class="tags">${tags}</div></div>` : ''}
  </div>
</article>`;
}

function renderEmpty(column) {
  if (column.status === 'collecting') {
    const have = column.have || 0;
    const need = column.need || 1;
    const pct = Math.min(100, Math.round((have / need) * 100));
    return `<div class="empty">
      <div class="code">// NO SIGNAL</div>
      <h3>增量数据积累中</h3>
      <p>「${esc(column.label)}」需要连续 ${need} 天的快照才能算出真实净增。目前已积累 <b>${have}</b> 天，还差 <b>${Math.max(0, need - have)}</b> 天。<br>这个窗口内暂无窗口期新建的仓库可作预热展示。</p>
      <div class="progress"><i style="--w:${pct}%"></i></div>
      <div class="progress-label">SNAPSHOT ${have} / ${need} DAYS</div>
    </div>`;
  }
  return `<div class="empty">
    <div class="code">// EMPTY SET</div>
    <h3>今日榜单空置</h3>
    <p>没有满足筛选条件的仓库。宁可空着，也不拿低质量项目补位。</p>
  </div>`;
}

function renderPanel(column, index, root) {
  const active = index === 0 ? 'true' : 'false';
  const isCold = column.status === 'coldstart';
  const badgeClass = isCold ? 'badge cold' : 'badge';
  const note = isCold
    ? `真增量尚在积累（${column.have || 0}/${column.need || 0} 天）· 当前展示近 ${column.window} 天新建仓库`
    : column.note;

  const body = column.items.length
    ? `<div class="feed">${column.items.map((it, i) => renderCard(it, i, column, root)).join('\n')}</div>`
    : renderEmpty(column);

  return `<section class="panel" id="panel-${esc(column.id)}" data-active="${active}">
  <div class="panel-head">
    <span class="${badgeClass}">${esc(column.badge || '')}</span>
    <span class="note">${esc(note)}</span>
  </div>
  ${body}
</section>`;
}

export function renderPage({ date, columns, archive, root = '', config, poolSize, generatedAt }) {
  const total = columns.reduce((s, c) => s + c.items.length, 0);
  const collecting = columns.filter((c) => c.status === 'collecting' || c.status === 'coldstart');
  const allLive = collecting.length === 0;

  const tabs = columns
    .map(
      (c, i) => `<button class="tab" role="tab" aria-selected="${i === 0}" data-target="panel-${esc(c.id)}">
      <span class="cn">${esc(c.label)}</span>
      <span class="en">${esc(c.en)}</span>
      <span class="num">${c.items.length}</span>
    </button>`,
    )
    .join('\n');

  const banner = allLive
    ? ''
    : `<div class="banner">
        <span class="tag">COLD START</span>
        <span>${collecting.map((c) => c.label).join(' / ')} 的增量口径正在积累快照，当前先以「窗口期新建仓库」预热；满期后自动切换为真实 star 净增。</span>
      </div>`;

  const archiveLinks = (archive || [])
    .slice(0, 14)
    .map((d) => `<a href="${root}archive/${d}.html">${d.replace(/-/g, '.')}</a>`)
    .join('');

  const panels = columns.map((c, i) => renderPanel(c, i, root)).join('\n');

  const ymd = date.replace(/-/g, '.');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(config.title)} · ${esc(date)}</title>
<meta name="description" content="每日 GitHub AI Agent 技能热榜 · ${esc(date)}">
<link rel="stylesheet" href="${root}assets/style.css">
</head>
<body>
<div class="bg-grid"></div>
<div class="bg-floor"></div>

<div class="shell">
  <header class="hud">
    <div class="hud-top">
      <div class="brand">
        <span class="mark">◤◢</span>
        <h1 class="glitch" data-text="${esc(config.title)}">${esc(config.title)}</h1>
      </div>
      <div class="hud-meta">
        <span class="led${allLive ? '' : ' warn'}"></span>
        <span>${allLive ? 'ALL SYSTEMS NOMINAL' : 'PARTIAL SIGNAL'}</span>
        <span class="sep">/</span>
        <span>${columns.reduce((s, c) => s + c.items.length, 0)} ENTRIES</span>
        <span class="sep">/</span>
        <span id="clock">--:--:--</span>
      </div>
    </div>
    <div class="hud-sub">
      <div class="date-block">
        <span class="d-main">${esc(ymd)}</span>
        <span class="d-cn">${esc(cnDate(date))} · 数据窗口 前一日 00:00–24:00 · 发布 08:00</span>
      </div>
      <div class="ticker">${esc(config.subtitle)}　///　POOL ${poolSize}　///　BUILD ${esc(generatedAt)}</div>
    </div>
    ${banner}
  </header>

  <nav class="tabs" role="tablist">
${tabs}
  </nav>

  <main>
${panels}
  </main>

  <footer class="foot">
    <div>
      <div>${esc(config.title)} · 自动生成 ${esc(generatedAt)} (UTC+8)</div>
      <div style="margin-top:6px">口径：总热门＝近 12 月新建按 star；月/周/日＝快照净增，不足则预热降级</div>
    </div>
    <div>
      <div>ARCHIVE</div>
      <div class="archive">${archiveLinks || '<span style="color:var(--text-faint)">暂无往期</span>'}</div>
    </div>
  </footer>
</div>

<div class="scanlines"></div>

<script>
(function () {
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var panels = Array.prototype.slice.call(document.querySelectorAll('.panel'));

  function activate(tab) {
    tabs.forEach(function (t) { t.setAttribute('aria-selected', String(t === tab)); });
    panels.forEach(function (p) { p.setAttribute('data-active', String(p.id === tab.dataset.target)); });
  }

  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () { activate(tab); });
    tab.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') tabs[Math.min(i + 1, tabs.length - 1)].focus();
      if (e.key === 'ArrowLeft') tabs[Math.max(i - 1, 0)].focus();
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT') return;
    var n = parseInt(e.key, 10);
    if (n >= 1 && n <= tabs.length) activate(tabs[n - 1]);
  });

  var clock = document.getElementById('clock');
  function tick() {
    var d = new Date();
    clock.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(function (x) { return String(x).padStart(2, '0'); }).join(':');
  }
  tick();
  setInterval(tick, 1000);
})();
</script>
</body>
</html>`;
}

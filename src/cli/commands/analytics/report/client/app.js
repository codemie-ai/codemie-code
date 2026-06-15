/* eslint-disable */
/**
 * CodeMie Analytics — client app (vanilla JS, no build).
 * Reads window.__ANALYTICS__ (ReportPayload) and renders 7 client-side views.
 * All filtering/aggregation happens here so the report needs no server.
 */
(function () {
  'use strict';

  var DATA = window.__ANALYTICS__;
  var root = document.getElementById('view-root');
  if (!DATA || !root) {
    if (root) root.innerHTML = '<div class="empty">No analytics data embedded in this report.</div>';
    return;
  }

  // sessionId -> record, for the session-detail modal (rows carry data-session).
  var SESSION_BY_ID = (function () { var m = {}; (DATA.sessions || []).forEach(function (s) { m[s.sessionId] = s; }); return m; })();

  // ---- palette ------------------------------------------------------------
  var PALETTE = ['#7C5CFC', '#2297F6', '#F5A534', '#06B6D4', '#259F4C', '#F9303C', '#C084FC', '#E879A6'];
  var AGENT_COLORS = { claude: '#7C5CFC', 'claude-acp': '#9D7BFF', 'claude-desktop': '#B79DFF', gemini: '#F5A534', codex: '#06B6D4', opencode: '#259F4C', 'codemie-code': '#2297F6' };
  var seenAgentColor = {};
  var colorCursor = 0;
  function colorFor(agent) {
    if (AGENT_COLORS[agent]) return AGENT_COLORS[agent];
    if (!seenAgentColor[agent]) { seenAgentColor[agent] = PALETTE[colorCursor % PALETTE.length]; colorCursor++; }
    return seenAgentColor[agent];
  }

  // ---- formatting ---------------------------------------------------------
  function fmtNum(n) { return (n || 0).toLocaleString('en-US'); }
  function fmtUSD(n) {
    if (!n) return '$0.00';
    if (n < 0.01) return '$' + n.toFixed(4);
    if (n < 100) return '$' + n.toFixed(2);
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function fmtDuration(ms) {
    var h = ms / 3600000;
    if (h >= 48) return Math.round(h / 24) + 'd';
    if (h >= 1) return h.toFixed(1) + 'h';
    var m = ms / 60000;
    return Math.max(1, Math.round(m)) + 'm';
  }
  function fmtTokens(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n || 0);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function shortPath(p) { var parts = String(p || '').split('/'); return parts[parts.length - 1] || p; }
  // Human-readable session label: the cleaned first-prompt title, falling back to a short id.
  function sessTitle(s) { return (s && s.title && s.title.trim()) ? s.title.trim() : ('#' + String((s && s.sessionId) || '').slice(0, 8)); }
  function truncStr(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  // First n whitespace-delimited words (the "starting message" preview), '…' when truncated.
  function firstWords(s, n) { s = String(s == null ? '' : s).trim(); var w = s.split(/\s+/); return w.length > n ? w.slice(0, n).join(' ') + '…' : s; }

  // ---- aggregation helpers ------------------------------------------------
  function sum(arr, f) { var t = 0; for (var i = 0; i < arr.length; i++) t += f(arr[i]) || 0; return t; }
  function groupBy(arr, keyFn) {
    var m = new Map();
    for (var i = 0; i < arr.length; i++) {
      var k = keyFn(arr[i]);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(arr[i]);
    }
    return m;
  }
  function successRate(fs) {
    var tot = sum(fs, function (s) { return s.toolCallsTotal; });
    var ok = sum(fs, function (s) { return s.toolCallsSuccess; });
    return tot ? Math.round((ok / tot) * 1000) / 10 : 0;
  }

  // ---- filter state -------------------------------------------------------
  var NOW = Date.parse(DATA.meta.generatedAt) || Date.now();
  // from/to hold epoch-ms local-day bounds; when either is set they override the preset.
  var state = { range: 'all', from: null, to: null, agents: new Set(DATA.meta.agents), project: 'all', view: 'overview' };
  var charts = [];
  function destroyCharts() { for (var i = 0; i < charts.length; i++) { try { charts[i].destroy(); } catch (e) {} } charts = []; }

  function startOfLocalDay(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  // Parse a YYYY-MM-DD value as LOCAL midnight (or local end-of-day) — NOT UTC — so it
  // lines up with the local-day bucketing used everywhere else (dayKey, heatmap, hours).
  function parseLocalDate(str, endOfDay) {
    if (!str) return null;
    var p = String(str).split('-');
    if (p.length !== 3) return null;
    var y = +p[0], m = +p[1], d = +p[2];
    if (!y || !m || !d) return null;
    return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime() : new Date(y, m - 1, d).getTime();
  }

  function rangeBounds() {
    if (state.from != null || state.to != null) {
      return { min: state.from != null ? state.from : 0, max: state.to != null ? state.to : Infinity };
    }
    if (state.range === 'today') return { min: startOfLocalDay(NOW), max: Infinity };
    var spanDays = { '7d': 7, '30d': 30, '90d': 90 }[state.range];
    return { min: spanDays ? NOW - spanDays * 86400000 : 0, max: Infinity };
  }

  function filtered() {
    var b = rangeBounds();
    return DATA.sessions.filter(function (s) {
      return state.agents.has(s.agentName) &&
        (state.project === 'all' || s.project === state.project) &&
        s.startTime >= b.min && s.startTime <= b.max;
    });
  }

  // Human label for the active client-side range (reflects live filters, not the
  // static generation-time meta.rangeLabel) so the applied range is always visible.
  function activeRangeLabel() {
    if (state.from != null || state.to != null) {
      return (state.from != null ? dayKey(state.from) : '…') + ' → ' + (state.to != null ? dayKey(state.to) : '…');
    }
    return { today: 'today', '7d': 'last 7d', '30d': 'last 30d', '90d': 'last 90d' }[state.range] || 'all';
  }

  // ---- chart factory ------------------------------------------------------
  var GRID = 'rgba(255,255,255,0.06)';
  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name); // may have leading space
      return (v && v.trim()) || fallback;
    } catch (e) { return fallback; }
  }
  // Recolor Chart.js for the active theme. Called at the start of every render so a
  // theme switch re-renders charts with theme-correct text/grid colors.
  function applyChartTheme() {
    var light = document.documentElement.classList.contains('light');
    GRID = light ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.06)';
    if (window.Chart) {
      Chart.defaults.color = cssVar('--color-text-muted', light ? '#5f6368' : '#9aa0a6');
      Chart.defaults.font.family = 'Inter, sans-serif';
      Chart.defaults.maintainAspectRatio = false;
    }
  }
  function makeChart(canvas, config) {
    if (!window.Chart) return null;
    var c = new Chart(canvas, config);
    charts.push(c);
    return c;
  }
  function canvasIn(parent, height) {
    var box = document.createElement('div');
    box.className = 'chart-box';
    if (height) box.style.height = height + 'px';
    var cv = document.createElement('canvas');
    box.appendChild(cv);
    parent.appendChild(box);
    return cv;
  }

  var INVOCATION_CHARTS = [
    { kind: 'skill', title: 'Skills invoked', color: '#7c4fff' },
    { kind: 'agent', title: 'Agent subtypes', color: '#ff6b6b' },
    { kind: 'command', title: 'Slash commands', color: '#4a9eff' },
  ];

  function appendToolsAndModels(host, fs, chartFn) {
    var toolAgg = new Map();
    fs.forEach(function (s) {
      (s.tools || []).forEach(function (t) {
        var cur = toolAgg.get(t.toolName) || { total: 0, success: 0, failure: 0 };
        cur.total += t.totalCalls; cur.success += t.successCount; cur.failure += t.failureCount;
        toolAgg.set(t.toolName, cur);
      });
    });
    var tools = Array.from(toolAgg.entries()).map(function (e) { return { name: e[0], total: e[1].total, success: e[1].success, rate: e[1].total ? Math.round((e[1].success / e[1].total) * 100) : 0 }; })
      .sort(function (a, b) { return b.total - a.total; });
    var maxTool = tools.length ? tools[0].total : 1;

    var row = el('div', 'grid-2 mb16');
    var toolCard = card('Tool usage & success rate');
    tools.slice(0, 12).forEach(function (t) {
      var bar = el('div', 'bar-row');
      var color = t.rate >= 90 ? '#259F4C' : (t.rate >= 70 ? '#F5A534' : '#F9303C');
      bar.innerHTML = '<span class="nm">' + esc(t.name) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + Math.max(3, (t.total / maxTool) * 100) + '%;background:' + color + '"></div></div><span class="vl">' + fmtNum(t.total) + ' · ' + t.rate + '%</span>';
      toolCard._body.appendChild(bar);
    });
    if (!tools.length) toolCard._body.appendChild(el('div', 'empty', 'No per-tool data.'));
    row.appendChild(toolCard);

    var modelAgg = new Map();
    fs.forEach(function (s) { (s.perModelCost || []).forEach(function (m) { modelAgg.set(m.model, (modelAgg.get(m.model) || 0) + (m.tokens ? m.tokens.total : 0)); }); });
    var modelCard = card('Tokens by model');
    var mEntries = Array.from(modelAgg.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 8);
    if (mEntries.length) {
      chartFn(canvasIn(modelCard._body), {
        type: 'bar',
        data: { labels: mEntries.map(function (e) { return e[0]; }), datasets: [{ data: mEntries.map(function (e) { return e[1]; }), backgroundColor: mEntries.map(function (_, i) { return PALETTE[i % PALETTE.length]; }), borderRadius: 5 }] },
        options: { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return fmtTokens(c.parsed.x) + ' tokens'; } } } }, scales: { x: { grid: { color: GRID }, ticks: { callback: function (v) { return fmtTokens(v); } } }, y: { grid: { display: false } } } }
      });
    } else {
      modelCard._body.appendChild(el('div', 'empty', 'No token data (sessions unpriced or no native logs).'));
    }
    row.appendChild(modelCard);
    host.appendChild(row);
  }

  function appendInvocationCharts(host, fs, chartFn) {
    INVOCATION_CHARTS.forEach(function (def) {
      var agg = {};
      fs.forEach(function (s) {
        dispatchCounts(s, def.kind).forEach(function (x) {
          agg[x.name] = (agg[x.name] || 0) + x.totalCalls;
        });
      });
      var entries = Object.entries(agg)
        .sort(function (a, b) { return b[1] - a[1]; })
        .slice(0, 10);

      var invCard = card(def.title);
      if (entries.length) {
        chartFn(canvasIn(invCard._body), {
          type: 'bar',
          data: {
            labels: entries.map(function (e) { return e[0]; }),
            datasets: [{
              data: entries.map(function (e) { return e[1]; }),
              backgroundColor: def.color,
              borderRadius: 4,
            }],
          },
          options: {
            indexAxis: 'y',
            plugins: { legend: { display: false } },
            scales: {
              x: { grid: { color: GRID }, ticks: { precision: 0 } },
              y: { grid: { display: false } },
            },
          },
        });
      } else {
        invCard._body.appendChild(el('div', 'empty', 'No data.'));
      }
      host.appendChild(invCard);
    });
  }

  // ---- small DOM builders -------------------------------------------------
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function card(title, sub) {
    var c = el('div', 'card');
    var head = el('div', 'card-header');
    head.appendChild(el('div', 'card-title', esc(title)));
    if (sub) head.appendChild(el('span', 'text-muted', esc(sub)));
    c.appendChild(head);
    var body = el('div', 'card-body');
    c.appendChild(body);
    c._body = body;
    return c;
  }
  function dayKey(ms) { var d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function dayBuckets(fs, valueFn) {
    var m = new Map();
    fs.forEach(function (s) { var k = dayKey(s.startTime); m.set(k, (m.get(k) || 0) + (valueFn ? valueFn(s) : 1)); });
    var keys = Array.from(m.keys()).sort();
    return { labels: keys, values: keys.map(function (k) { return m.get(k); }) };
  }

  // ===================================================================== VIEWS
  var VIEWS = {};

  VIEWS.overview = function (host, fs) {
    host.appendChild(el('h2', 'view-title', 'Overview'));
    host.appendChild(el('p', 'view-sub', fs.length + ' sessions in view · ' + esc(activeRangeLabel()) + ' range'));

    var totalCost = sum(fs, function (s) { return s.costUSD; });
    var priced = DATA.meta.totals.pricedSessions;
    var kpis = [
      ['Sessions', fmtNum(fs.length), ''],
      ['Duration', fmtDuration(sum(fs, function (s) { return s.durationMs; })), 'wall-clock span'],
      ['Turns', fmtNum(sum(fs, function (s) { return s.turns; })), fs.length ? (Math.round(sum(fs, function (s) { return s.turns; }) / fs.length) + ' / session') : ''],
      ['Files touched', fmtNum(sum(fs, function (s) { return s.fileOps; })), 'net ' + (sum(fs, function (s) { return s.netLines; }) >= 0 ? '+' : '') + fmtNum(sum(fs, function (s) { return s.netLines; })) + ' lines'],
      ['Tool calls', fmtNum(sum(fs, function (s) { return s.toolCallsTotal; })), successRate(fs) + '% success'],
      ['Est. cost', totalCost ? fmtUSD(totalCost) : '—', priced < DATA.meta.totals.sessions ? ('priced ' + priced + '/' + DATA.meta.totals.sessions) : 'tokens × pricing']
    ];
    var grid = el('div', 'kpi-grid');
    kpis.forEach(function (k) {
      var c = el('div', 'kpi' + (k[0] === 'Est. cost' && !totalCost ? ' soon' : ''));
      c.appendChild(el('div', 'kpi-label', k[0]));
      c.appendChild(el('div', 'kpi-value', k[1]));
      if (k[2]) c.appendChild(el('div', 'kpi-sub', k[2]));
      grid.appendChild(c);
    });
    host.appendChild(grid);

    // token-usage summary — input / output / cache write / cache read / total.
    // "cache write" = cacheCreation (tokens written to the prompt cache),
    // "cache read"  = cacheRead     (tokens served from the prompt cache).
    var tIn = sum(fs, function (s) { return s.tokens ? s.tokens.input : 0; });
    var tOut = sum(fs, function (s) { return s.tokens ? s.tokens.output : 0; });
    var tcWrite = sum(fs, function (s) { return s.tokens ? s.tokens.cacheCreation : 0; });
    var tcRead = sum(fs, function (s) { return s.tokens ? s.tokens.cacheRead : 0; });
    var tTotal = sum(fs, function (s) { return s.tokens ? s.tokens.total : 0; });
    var tkv = function (v) { return tTotal > 0 ? fmtTokens(v) : '—'; };
    var tokenKpis = [
      ['Input tokens', tkv(tIn), 'prompts sent to the model'],
      ['Output tokens', tkv(tOut), 'completions generated'],
      ['Cache write', tkv(tcWrite), 'tokens written to cache'],
      ['Cache read', tkv(tcRead), 'tokens served from cache'],
      ['Total tokens', tkv(tTotal), priced < DATA.meta.totals.sessions ? ('priced ' + priced + '/' + DATA.meta.totals.sessions + ' sessions') : 'across sessions in view']
    ];
    host.appendChild(el('div', 'kpi-section-label', 'Token usage'));
    var tgrid = el('div', 'kpi-grid kpi-grid-tokens');
    tokenKpis.forEach(function (k) {
      var c = el('div', 'kpi');
      c.appendChild(el('div', 'kpi-label', k[0]));
      c.appendChild(el('div', 'kpi-value' + (tTotal > 0 ? '' : ' muted'), k[1]));
      if (k[2]) c.appendChild(el('div', 'kpi-sub', k[2]));
      tgrid.appendChild(c);
    });
    host.appendChild(tgrid);

    // efficiency headline KPIs (full detail on the Efficiency tab)
    var effCacheReadCost = sum(fs, function (s) { return s.cacheReadCostUSD || 0; });
    var effTotalCost = sum(fs, function (s) { return s.costUSD; });
    var effCacheRead = sum(fs, function (s) { return s.tokens ? s.tokens.cacheRead : 0; });
    var effTurns = sum(fs, function (s) { return s.turns; });
    var effDead = fs.filter(function (s) { return s.costUSD > 0 && (s.filesChanged || 0) === 0 && s.netLines === 0; });
    var effBloat = effTotalCost > 0 ? Math.round((effCacheReadCost / effTotalCost) * 1000) / 10 : 0;
    var effAvgCtx = effTurns ? effCacheRead / effTurns : 0;
    host.appendChild(el('div', 'kpi-section-label', 'Efficiency'));
    var egrid = el('div', 'kpi-grid');
    [['Cache-read cost', effTotalCost ? fmtUSD(effCacheReadCost) : '—', 'spend on context re-reads'],
     ['Bloat %', effTotalCost ? (effBloat + '%') : '—', 'cache reads / total cost'],
     ['Dead sessions', fmtNum(effDead.length), fs.length ? (Math.round((effDead.length / fs.length) * 100) + '% wasted') : ''],
     ['Avg context / call', fmtTokens(Math.round(effAvgCtx)), 'see Efficiency tab']
    ].forEach(function (k) {
      var c = el('div', 'kpi'); c.appendChild(el('div', 'kpi-label', k[0])); c.appendChild(el('div', 'kpi-value', k[1])); if (k[2]) c.appendChild(el('div', 'kpi-sub', k[2])); egrid.appendChild(c);
    });
    host.appendChild(egrid);

    var row = el('div', 'grid-32 mb16');
    var trend = card('Net lines over time');
    row.appendChild(trend);
    var modelsCard = card('Sessions by model');
    row.appendChild(modelsCard);
    host.appendChild(row);

    var buckets = dayBuckets(fs, function (s) { return s.netLines; });
    makeChart(canvasIn(trend._body), {
      type: 'line',
      data: { labels: buckets.labels, datasets: [{ label: 'Net lines', data: buckets.values, fill: true, borderColor: '#2297F6', backgroundColor: 'rgba(34,151,246,0.15)', tension: 0.3, pointRadius: 1 }] },
      options: { plugins: { legend: { display: false } }, scales: { y: { grid: { color: GRID } }, x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } } } }
    });

    var byModel = groupBy(fs, function (s) { return s.models[0] || 'unknown'; });
    var mLabels = Array.from(byModel.keys()), mVals = mLabels.map(function (k) { return byModel.get(k).length; });
    makeChart(canvasIn(modelsCard._body), {
      type: 'doughnut',
      data: { labels: mLabels, datasets: [{ data: mVals, backgroundColor: mLabels.map(function (_, i) { return PALETTE[i % PALETTE.length]; }), borderWidth: 0 }] },
      options: { cutout: '62%', plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, padding: 10 } } } }
    });

    // top projects
    var proj = groupBy(fs, function (s) { return s.project; });
    var pc = card('Top projects', 'files changed · lines added / removed · net');
    var rows = Array.from(proj.entries()).map(function (e) {
      return {
        p: e[0], sessions: e[1].length,
        files: sum(e[1], function (s) { return s.filesChanged || 0; }),
        added: sum(e[1], function (s) { return s.linesAdded; }),
        removed: sum(e[1], function (s) { return s.linesRemoved; }),
        net: sum(e[1], function (s) { return s.netLines; })
      };
    }).sort(function (a, b) { return b.sessions - a.sessions; }).slice(0, 8);
    pc._body.innerHTML = tableHTML(['Project', 'Sessions', 'Files', 'Lines +', 'Lines −', 'Net lines'],
      rows.map(function (r) { return ['<span class="proj-link" data-proj-open="' + esc(r.p) + '" title="' + esc(r.p) + '">' + esc(shortPath(r.p)) + '</span>', fmtNum(r.sessions), tdNum(r.files), tdNum('+' + fmtNum(r.added)), tdNum('−' + fmtNum(r.removed)), tdNum(r.net)]; }));
    pc._body.addEventListener('click', function (ev) {
      var span = ev.target.closest('[data-proj-open]');
      if (!span) return;
      var path = span.getAttribute('data-proj-open');
      openProjectModal(path, proj.get(path) || []);
    });
    host.appendChild(pc);
  };

  VIEWS.agents = function (host, fs) {
    host.appendChild(el('h2', 'view-title', 'Agents · Compare'));
    host.appendChild(el('p', 'view-sub', 'Side-by-side across coding agents. Toggle agents in the top bar to add/remove.'));
    if (!fs.length) { host.appendChild(el('div', 'empty', 'No sessions for the selected agents/range.')); return; }

    var byAgent = groupBy(fs, function (s) { return s.agentName; });
    var agentList = Array.from(byAgent.keys());

    var cols = el('div', 'agent-cols');
    agentList.forEach(function (a) {
      var ss = byAgent.get(a);
      var c = el('div', 'acard'); c.style.setProperty('--ac', colorFor(a));
      c.appendChild(el('h3', null, '<span class="pill"></span>' + esc(a)));
      c.appendChild(el('span', 'text-muted', '<span style="font-size:12px">' + ss.length + ' sessions · ' + Math.round((ss.length / fs.length) * 100) + '% of activity</span>'));
      var mini = el('div', 'mini');
      var stats = [
        ['Net lines', (sum(ss, function (s) { return s.netLines; }) >= 0 ? '+' : '') + fmtNum(sum(ss, function (s) { return s.netLines; }))],
        ['Turns', fmtNum(sum(ss, function (s) { return s.turns; }))],
        ['Tool success', successRate(ss) + '%'],
        ['Avg session', fmtDuration(sum(ss, function (s) { return s.durationMs; }) / ss.length)]
      ];
      stats.forEach(function (st) { var d = el('div'); d.appendChild(el('div', 'l', st[0])); d.appendChild(el('div', 'v', st[1])); mini.appendChild(d); });
      c.appendChild(mini);
      cols.appendChild(c);
    });
    host.appendChild(cols);

    var row = el('div', 'grid-2 mb16');
    var stackCard = card('Sessions over time — by agent');
    var shareCard = card('Share of net lines');
    row.appendChild(stackCard); row.appendChild(shareCard);
    host.appendChild(row);

    // stacked sessions/day by agent
    var allDays = Array.from(new Set(fs.map(function (s) { return dayKey(s.startTime); }))).sort();
    var datasets = agentList.map(function (a) {
      var ss = byAgent.get(a);
      var perDay = {}; ss.forEach(function (s) { var k = dayKey(s.startTime); perDay[k] = (perDay[k] || 0) + 1; });
      return { label: a, data: allDays.map(function (d) { return perDay[d] || 0; }), backgroundColor: colorFor(a) };
    });
    makeChart(canvasIn(stackCard._body), {
      type: 'bar', data: { labels: allDays, datasets: datasets },
      options: { plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, padding: 10 } } }, scales: { x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { stacked: true, grid: { color: GRID } } } }
    });

    makeChart(canvasIn(shareCard._body), {
      type: 'doughnut',
      data: { labels: agentList, datasets: [{ data: agentList.map(function (a) { return Math.abs(sum(byAgent.get(a), function (s) { return s.netLines; })); }), backgroundColor: agentList.map(colorFor), borderWidth: 0 }] },
      options: { cutout: '60%', plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, padding: 10 } } } }
    });

    var detail = card('Per-agent detail');
    // Agent + Top model are categorical (left); the rest are numeric (right). Passing an
    // explicit mask keeps the text "Top model" column left-aligned instead of being treated
    // as numeric by the default "everything but column 0" rule.
    detail._body.innerHTML = tableHTML(['Agent', 'Sessions', 'Turns', 'Files', 'Net lines', 'Top model', 'Tool success', 'Cost'],
      agentList.map(function (a) {
        var ss = byAgent.get(a);
        var topModel = topOf(ss.flatMap(function (s) { return s.models; }));
        return ['<span class="tag tag-sm" style="text-transform:capitalize">' + esc(a) + '</span>', fmtNum(ss.length), tdNum(sum(ss, function (s) { return s.turns; })), tdNum(sum(ss, function (s) { return s.fileOps; })), tdNum(sum(ss, function (s) { return s.netLines; })), '<span class="tag tag-sm">' + esc(topModel || '—') + '</span>', tdNum(successRate(ss) + '%'), tdNum(fmtUSD(sum(ss, function (s) { return s.costUSD; })))];
      }),
      [false, true, true, true, true, false, true, true]);
    host.appendChild(detail);
  };

  VIEWS.projects = function (host, fs) {
    host.appendChild(el('h2', 'view-title', 'Projects'));
    host.appendChild(el('p', 'view-sub', 'Click a project to expand its branches & sessions.'));
    if (!fs.length) { host.appendChild(el('div', 'empty', 'No sessions in view.')); return; }
    var byProj = groupBy(fs, function (s) { return s.project; });
    var c = card('Projects');
    var wrap = el('div', 'table-wrapper');
    var rows = Array.from(byProj.entries()).map(function (e) { return { p: e[0], ss: e[1] }; })
      .sort(function (a, b) { return b.ss.length - a.ss.length; });
    var html = '<table class="table"><thead><tr><th>Project</th><th class="td-number">Sessions</th><th class="td-number">Turns</th><th class="td-number">Files</th><th class="td-number">Lines +</th><th class="td-number">Lines −</th><th class="td-number">Net lines</th><th class="td-number">Tool success</th><th class="td-number">Cost</th></tr></thead><tbody>';
    var crudCells = function (ss) {
      return '<td class="td-number">' + fmtNum(sum(ss, function (s) { return s.filesChanged || 0; })) + '</td>'
        + '<td class="td-number">+' + fmtNum(sum(ss, function (s) { return s.linesAdded; })) + '</td>'
        + '<td class="td-number">−' + fmtNum(sum(ss, function (s) { return s.linesRemoved; })) + '</td>';
    };
    rows.forEach(function (r, i) {
      html += '<tr class="clickable" data-proj="' + i + '" data-proj-path="' + esc(r.p) + '"><td>▸ <span class="proj-link" data-proj-open="' + esc(r.p) + '">' + esc(shortPath(r.p)) + '</span></td><td class="td-number">' + fmtNum(r.ss.length) + '</td><td class="td-number">' + fmtNum(sum(r.ss, function (s) { return s.turns; })) + '</td>' + crudCells(r.ss) + '<td class="td-number">' + fmtNum(sum(r.ss, function (s) { return s.netLines; })) + '</td><td class="td-number">' + successRate(r.ss) + '%</td><td class="td-number">' + fmtUSD(sum(r.ss, function (s) { return s.costUSD; })) + '</td></tr>';
      // branch sub-rows (hidden)
      var byBranch = groupBy(r.ss, function (s) { return s.branch || '(none)'; });
      byBranch.forEach(function (bss, b) {
        html += '<tr class="drill" data-parent="' + i + '" style="display:none"><td style="padding-left:28px">⎇ ' + esc(b) + '</td><td class="td-number">' + bss.length + '</td><td class="td-number">' + fmtNum(sum(bss, function (s) { return s.turns; })) + '</td>' + crudCells(bss) + '<td class="td-number">' + fmtNum(sum(bss, function (s) { return s.netLines; })) + '</td><td class="td-number">' + successRate(bss) + '%</td><td class="td-number">' + fmtUSD(sum(bss, function (s) { return s.costUSD; })) + '</td></tr>';
      });
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
    wrap.addEventListener('click', function (ev) {
      var open = ev.target.closest('[data-proj-open]');
      if (open) {
        var path = open.getAttribute('data-proj-open');
        openProjectModal(path, byProj.get(path) || []);
        return;
      }
      var tr = ev.target.closest('tr[data-proj]');
      if (!tr) return;
      var id = tr.getAttribute('data-proj');
      wrap.querySelectorAll('tr[data-parent="' + id + '"]').forEach(function (sub) { sub.style.display = sub.style.display === 'none' ? '' : 'none'; });
    });
    c._body.style.paddingTop = '0';
    c._body.appendChild(wrap);
    host.appendChild(c);
  };

  VIEWS.toolsmodels = function (host, fs) {
    host.appendChild(el('h2', 'view-title', 'Tools & Models'));
    host.appendChild(el('p', 'view-sub', 'Tool usage across sessions and model token/cost distribution.'));
    if (!fs.length) { host.appendChild(el('div', 'empty', 'No sessions in view.')); return; }
    appendToolsAndModels(host, fs, makeChart);
    appendInvocationCharts(host, fs, makeChart);
  };

  VIEWS.activity = function (host, fs) {
    host.appendChild(el('h2', 'view-title', 'Activity'));
    host.appendChild(el('p', 'view-sub', 'When sessions happen — by weekday and hour (local time).'));
    if (!fs.length) { host.appendChild(el('div', 'empty', 'No sessions in view.')); return; }

    var days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    var grid = {}; var maxCell = 0;
    fs.forEach(function (s) {
      var d = new Date(s.startTime);
      var di = (d.getDay() + 6) % 7; // Mon=0
      var h = d.getHours();
      var key = di + '_' + h;
      grid[key] = (grid[key] || 0) + 1;
      if (grid[key] > maxCell) maxCell = grid[key];
    });
    var hmCard = card('Sessions by weekday × hour');
    var hm = el('div', 'heatmap');
    var html = '<div></div>'; // build the whole grid as one string, then assign once
    for (var h = 0; h < 24; h++) html += '<div class="heat-hr">' + (h % 6 === 0 ? h : '') + '</div>';
    days.forEach(function (dn, di) {
      html += '<div class="heat-lbl">' + dn + '</div>';
      for (var hr = 0; hr < 24; hr++) {
        var v = grid[di + '_' + hr] || 0;
        var a = maxCell ? (v / maxCell) : 0;
        html += '<div class="heat-cell" title="' + dn + ' ' + hr + ':00 — ' + v + ' sessions" style="background:rgba(34,151,246,' + (v ? (0.15 + a * 0.85).toFixed(2) : 0) + ')"></div>';
      }
    });
    hm.innerHTML = html;
    hmCard._body.appendChild(hm);
    host.appendChild(hmCard);

    var row = el('div', 'grid-2');
    var hourCard = card('By hour of day');
    var hours = []; for (var i = 0; i < 24; i++) hours.push(0);
    fs.forEach(function (s) { hours[new Date(s.startTime).getHours()]++; });
    makeChart(canvasIn(hourCard._body), {
      type: 'bar', data: { labels: hours.map(function (_, i) { return i; }), datasets: [{ data: hours, backgroundColor: '#2297F6', borderRadius: 3 }] },
      options: { plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { grid: { color: GRID } } } }
    });
    row.appendChild(hourCard);

    var wdCard = card('By weekday');
    var wd = [0, 0, 0, 0, 0, 0, 0];
    fs.forEach(function (s) { wd[(new Date(s.startTime).getDay() + 6) % 7]++; });
    makeChart(canvasIn(wdCard._body), {
      type: 'bar', data: { labels: days, datasets: [{ data: wd, backgroundColor: '#7C5CFC', borderRadius: 3 }] },
      options: { plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { grid: { color: GRID } } } }
    });
    row.appendChild(wdCard);
    host.appendChild(row);
  };

  VIEWS.efficiency = function (host, fs) {
    host.appendChild(el('h2', 'view-title', 'Efficiency'));
    host.appendChild(el('p', 'view-sub', 'Context usage, waste, and how efficiently sessions convert spend into work. Estimates are labelled.'));
    if (!fs.length) { host.appendChild(el('div', 'empty', 'No sessions in view.')); return; }

    // ---- context & waste KPIs ----
    var totalCacheRead = sum(fs, function (s) { return s.tokens ? s.tokens.cacheRead : 0; });
    var totalTurns = sum(fs, function (s) { return s.turns; });
    var totalCost = sum(fs, function (s) { return s.costUSD; });
    var totalCacheReadCost = sum(fs, function (s) { return s.cacheReadCostUSD || 0; });
    var avgCtx = totalTurns ? totalCacheRead / totalTurns : 0;
    var worst = 0, worstS = null;
    fs.forEach(function (s) {
      var t = s.turns || 0, cr = s.tokens ? s.tokens.cacheRead : 0, v = t ? cr / t : 0;
      if (v > worst) { worst = v; worstS = s; }
    });
    var bloatPct = totalCost > 0 ? Math.round((totalCacheReadCost / totalCost) * 1000) / 10 : 0;

    var grid = el('div', 'kpi-grid');
    [['Avg context / call', fmtTokens(Math.round(avgCtx)), 'cache tokens re-read each call'],
     ['Worst session ctx / call', fmtTokens(Math.round(worst)), worstS ? esc(truncStr(sessTitle(worstS), 28)) : ''],
     ['Cache-read cost', totalCacheReadCost ? fmtUSD(totalCacheReadCost) : '—', totalCost ? (bloatPct + '% of spend') : 'tokens × pricing'],
     ['Bloat %', totalCost ? (bloatPct + '%') : '—', 'spend on context re-reads']
    ].forEach(function (k) {
      var c = el('div', 'kpi'); c.appendChild(el('div', 'kpi-label', k[0])); c.appendChild(el('div', 'kpi-value', k[1])); if (k[2]) c.appendChild(el('div', 'kpi-sub', k[2])); grid.appendChild(c);
    });
    host.appendChild(grid);

    // ---- avg context/call per session (bar) + most bloated sessions (table) ----
    var row1 = el('div', 'grid-2 mb16');
    var ctxCard = card('Avg context / call per session', 'top 20 by context re-read');
    var withCtx = fs.map(function (s) {
      var t = s.turns || 0, cr = s.tokens ? s.tokens.cacheRead : 0;
      return { s: s, v: t ? cr / t : 0 };
    }).filter(function (x) { return x.v > 0; }).sort(function (a, b) { return b.v - a.v; }).slice(0, 20);
    if (withCtx.length) {
      var ctxTitles = withCtx.map(function (x) { return sessTitle(x.s); });
      makeChart(canvasIn(ctxCard._body), {
        type: 'bar',
        data: { labels: withCtx.map(function (x) { return truncStr(sessTitle(x.s), 18); }), datasets: [{ data: withCtx.map(function (x) { return Math.round(x.v); }), backgroundColor: '#F5A534', borderRadius: 4 }] },
        options: { plugins: { legend: { display: false }, tooltip: { callbacks: { title: function (items) { return ctxTitles[items[0].dataIndex]; }, label: function (c) { return fmtTokens(c.parsed.y) + ' / call'; } } } }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 12 } }, y: { grid: { color: GRID }, ticks: { callback: function (v) { return fmtTokens(v); } } } } }
      });
    } else { ctxCard._body.appendChild(el('div', 'empty', 'No cache-read data.')); }
    row1.appendChild(ctxCard);

    var bloatCard = card('Most bloated sessions', 'highest context re-read per call');
    bloatCard._body.style.paddingTop = '0';
    var bloated = fs.map(function (s) {
      var t = s.turns || 0, cr = s.tokens ? s.tokens.cacheRead : 0;
      return { s: s, ctx: t ? cr / t : 0, bloat: s.costUSD > 0 ? ((s.cacheReadCostUSD || 0) / s.costUSD) * 100 : 0 };
    }).filter(function (x) { return x.ctx > 0; }).sort(function (a, b) { return b.ctx - a.ctx; }).slice(0, 10);
    bloatCard._body.innerHTML = '<div class="table-wrapper">' + tableHTML(
      ['Session', 'Agent', 'Model', 'Ctx/call', 'Cache read', 'Cost', 'Bloat%'],
      bloated.map(function (x) {
        var s = x.s;
        return ['<span title="' + esc(sessTitle(s)) + '">' + esc(truncStr(sessTitle(s), 44)) + '</span>',
          '<span class="tag tag-sm" style="text-transform:capitalize">' + esc(s.agentName) + '</span>',
          '<span class="tag tag-sm">' + esc((s.models && s.models[0]) || '—') + '</span>',
          fmtTokens(Math.round(x.ctx)), fmtTokens(s.tokens ? s.tokens.cacheRead : 0), fmtUSD(s.costUSD), (Math.round(x.bloat * 10) / 10) + '%'];
      }),
      [false, false, false, true, true, true, true],
      bloated.map(function (x) { return 'class="clickable" data-session="' + esc(x.s.sessionId) + '"'; })) + '</div>';
    bloatCard._body.addEventListener('click', function (ev) {
      var tr = ev.target.closest('tr[data-session]'); if (!tr) return;
      openSessionModal(SESSION_BY_ID[tr.getAttribute('data-session')]);
    });
    row1.appendChild(bloatCard);
    host.appendChild(row1);

    // ---- dead sessions ----
    var dead = fs.filter(function (s) { return s.costUSD > 0 && (s.filesChanged || 0) === 0 && s.netLines === 0; });
    var deadCost = sum(dead, function (s) { return s.costUSD; });
    var deadCard = card('Dead sessions', 'cost spent, zero files changed and zero net lines — pure inference waste');
    var dkv = el('div', 'kpi-grid'); dkv.style.gridTemplateColumns = 'repeat(3,1fr)';
    [['Dead sessions', fmtNum(dead.length), fs.length ? (Math.round((dead.length / fs.length) * 100) + '% of sessions') : ''],
     ['Wasted cost', fmtUSD(deadCost), totalCost ? (Math.round((deadCost / totalCost) * 100) + '% of spend') : ''],
     ['Avg cost / dead', dead.length ? fmtUSD(deadCost / dead.length) : '—', 'per unproductive session']
    ].forEach(function (k) {
      var c = el('div', 'kpi'); c.appendChild(el('div', 'kpi-label', k[0])); c.appendChild(el('div', 'kpi-value', k[1])); if (k[2]) c.appendChild(el('div', 'kpi-sub', k[2])); dkv.appendChild(c);
    });
    deadCard._body.appendChild(dkv);
    if (dead.length) {
      var topDead = dead.slice().sort(function (a, b) { return b.costUSD - a.costUSD; }).slice(0, 10);
      var dw = el('div', 'table-wrapper');
      dw.innerHTML = tableHTML(['Session', 'Agent', 'Model', 'Turns', 'Cost'],
        topDead.map(function (s) {
          return ['<span title="' + esc(sessTitle(s)) + '">' + esc(truncStr(sessTitle(s), 44)) + '</span>',
            '<span class="tag tag-sm" style="text-transform:capitalize">' + esc(s.agentName) + '</span>',
            '<span class="tag tag-sm">' + esc((s.models && s.models[0]) || '—') + '</span>',
            fmtNum(s.turns), fmtUSD(s.costUSD)];
        }), [false, false, false, true, true]);
      deadCard._body.appendChild(dw);
    }
    host.appendChild(deadCard);

    // ---- session depth + command effectiveness ----
    var row2 = el('div', 'grid-2 mb16');
    var depthCard = card('Session depth', 'turns per session — long runs that never compact/restart');
    var buckets = [['1', function (t) { return t <= 1; }], ['2–5', function (t) { return t >= 2 && t <= 5; }], ['6–10', function (t) { return t >= 6 && t <= 10; }], ['11–25', function (t) { return t >= 11 && t <= 25; }], ['26–50', function (t) { return t >= 26 && t <= 50; }], ['50+', function (t) { return t > 50; }]];
    var counts = buckets.map(function (b) { return fs.filter(function (s) { return b[1](s.turns || 0); }).length; });
    makeChart(canvasIn(depthCard._body), {
      type: 'bar', data: { labels: buckets.map(function (b) { return b[0]; }), datasets: [{ data: counts, backgroundColor: '#7C5CFC', borderRadius: 4 }] },
      options: { plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { grid: { color: GRID }, ticks: { precision: 0 } } } }
    });
    var turnsArr = fs.map(function (s) { return s.turns || 0; }).sort(function (a, b) { return a - b; });
    var median = 0;
    if (turnsArr.length) {
      var mid = Math.floor(turnsArr.length / 2);
      median = turnsArr.length % 2 ? turnsArr[mid] : Math.round((turnsArr[mid - 1] + turnsArr[mid]) / 2);
    }
    var avgTurns = fs.length ? Math.round(totalTurns / fs.length) : 0;
    depthCard._body.appendChild(el('p', 'text-muted', '<span style="font-size:12px">median ' + median + ' · avg ' + avgTurns + ' turns / session</span>'));
    row2.appendChild(depthCard);

    var cmdCard = card('Command effectiveness', 'est. cost per file changed, by command (session cost → its dominant command)');
    // null-proto map: command names are data-derived, so a name like "__proto__" must not alias Object.prototype.
    var cmdAgg = Object.create(null);
    fs.forEach(function (s) {
      var cmds = s.commandInvocations || [];
      if (!cmds.length) return;
      var dom = cmds.slice().sort(function (a, b) { return b.totalCalls - a.totalCalls; })[0];
      var cur = cmdAgg[dom.name] || { cost: 0, artifacts: 0 };
      cur.cost += s.costUSD; cur.artifacts += (s.filesChanged || 0);
      cmdAgg[dom.name] = cur;
    });
    var cmdEntries = Object.keys(cmdAgg).map(function (name) {
      var a = cmdAgg[name];
      return { name: name, perArtifact: a.artifacts > 0 ? a.cost / a.artifacts : 0 };
    }).filter(function (x) { return x.perArtifact > 0; }).sort(function (a, b) { return a.perArtifact - b.perArtifact; }).slice(0, 10);
    if (cmdEntries.length) {
      makeChart(canvasIn(cmdCard._body), {
        type: 'bar',
        data: { labels: cmdEntries.map(function (e) { return e.name; }), datasets: [{ data: cmdEntries.map(function (e) { return Math.round(e.perArtifact * 100) / 100; }), backgroundColor: '#06B6D4', borderRadius: 4 }] },
        options: { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return fmtUSD(c.parsed.x) + ' / file'; } } } }, scales: { x: { grid: { color: GRID }, ticks: { callback: function (v) { return fmtUSD(v); } } }, y: { grid: { display: false } } } }
      });
    } else { cmdCard._body.appendChild(el('div', 'empty', 'No command + artifact data.')); }
    row2.appendChild(cmdCard);
    host.appendChild(row2);

    // ---- code changes ----
    var changeCard = card('Code changes', 'files & lines changed across sessions in view');
    var cg = el('div', 'kpi-grid');
    [['Files changed', fmtNum(sum(fs, function (s) { return s.filesChanged || 0; })), 'written or edited'],
     ['Files written', fmtNum(sum(fs, function (s) { return s.filesWritten || 0; })), 'Write tool'],
     ['Files edited', fmtNum(sum(fs, function (s) { return s.filesEdited || 0; })), 'Edit tool'],
     ['Lines added', '+' + fmtNum(sum(fs, function (s) { return s.linesAdded; })), ''],
     ['Lines removed', '−' + fmtNum(sum(fs, function (s) { return s.linesRemoved; })), ''],
     ['Net lines', (sum(fs, function (s) { return s.netLines; }) >= 0 ? '+' : '') + fmtNum(sum(fs, function (s) { return s.netLines; })), '']
    ].forEach(function (k) {
      var c = el('div', 'kpi'); c.appendChild(el('div', 'kpi-label', k[0])); c.appendChild(el('div', 'kpi-value', k[1])); if (k[2]) c.appendChild(el('div', 'kpi-sub', k[2])); cg.appendChild(c);
    });
    changeCard._body.appendChild(cg);
    changeCard._body.appendChild(el('p', 'text-muted', '<span style="font-size:12px">File deletions and line-level "modified" counts aren\'t tracked; Write counts the whole file as added.</span>'));
    host.appendChild(changeCard);
  };

  VIEWS.cost = function (host, fs) {
    host.appendChild(el('h2', 'view-title', 'Cost'));
    host.appendChild(el('p', 'view-sub', 'Estimated cost (API-equivalent) — token usage × model pricing. On a subscription you don’t pay per token; this is the equivalent metered API value.'));

    var total = sum(fs, function (s) { return s.costUSD; });
    var priced = DATA.meta.totals.pricedSessions, totalSessions = DATA.meta.totals.sessions;

    var banner = el('div', 'alert ' + (priced < totalSessions ? 'alert-warning' : 'alert-info'));
    var msg = 'Priced ' + priced + ' of ' + totalSessions + ' sessions with recoverable token usage. '
      + 'The rest have no readable native log — coding agents rotate/delete old transcripts, so historical '
      + 'token data is incomplete (this does not affect the cost of the sessions that are priced). See Coverage by agent below.';
    if (DATA.meta.unpricedModels && DATA.meta.unpricedModels.length) msg += ' Unpriced models: ' + DATA.meta.unpricedModels.join(', ') + '.';
    banner.textContent = msg; // textContent is safe — do not pre-escape (would double-escape)
    host.appendChild(banner);

    var grid = el('div', 'kpi-grid'); grid.style.gridTemplateColumns = 'repeat(3,1fr)';
    var tok = fs.reduce(function (acc, s) { return acc + (s.tokens ? s.tokens.total : 0); }, 0);
    [['Total est. cost', fmtUSD(total)], ['Total tokens', fmtTokens(tok)], ['Avg cost / session', fs.length ? fmtUSD(total / fs.length) : '—']].forEach(function (k) {
      var c = el('div', 'kpi'); c.appendChild(el('div', 'kpi-label', k[0])); c.appendChild(el('div', 'kpi-value', k[1])); grid.appendChild(c);
    });
    host.appendChild(grid);

    // per-agent coverage — answers "which tools' metrics are included?"
    var cov = DATA.meta.coverage || [];
    if (cov.length) {
      var covCard = card('Coverage by agent', 'sessions with token data, per tool');
      covCard._body.style.paddingTop = '0';
      covCard._body.innerHTML = '<div class="table-wrapper">' + tableHTML(['Agent', 'Sessions', 'Priced', 'Native log', 'Status'],
        cov.map(function (c) {
          var status;
          if (c.total > 0 && c.priced >= c.total) status = '<span class="cov-ok">✓ full</span>';
          else if (c.withLog === 0) status = '<span class="cov-warn">no native log</span>';
          else if (c.priced === 0) status = '<span class="cov-warn">no token reader</span>';
          else status = '<span class="cov-warn">partial</span>';
          return ['<span class="tag tag-sm" style="text-transform:capitalize">' + esc(c.agentName) + '</span>',
            fmtNum(c.total), c.priced + '/' + c.total, fmtNum(c.withLog), status];
        }),
        [false, true, true, true, false]) + '</div>';
      host.appendChild(covCard);
    }

    var row = el('div', 'grid-2 mb16');
    var byAgentCard = card('Cost by agent');
    var byAgent = groupBy(fs, function (s) { return s.agentName; });
    var aList = Array.from(byAgent.keys());
    makeChart(canvasIn(byAgentCard._body), {
      type: 'doughnut', data: { labels: aList, datasets: [{ data: aList.map(function (a) { return sum(byAgent.get(a), function (s) { return s.costUSD; }); }), backgroundColor: aList.map(colorFor), borderWidth: 0 }] },
      options: { cutout: '60%', plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, padding: 10 } }, tooltip: { callbacks: { label: function (c) { return c.label + ': ' + fmtUSD(c.parsed); } } } } }
    });
    row.appendChild(byAgentCard);

    var byModelCard = card('Cost by model');
    var modelCost = new Map();
    fs.forEach(function (s) { (s.perModelCost || []).forEach(function (m) { modelCost.set(m.model, (modelCost.get(m.model) || 0) + m.costUSD); }); });
    var mc = Array.from(modelCost.entries()).filter(function (e) { return e[1] > 0; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 8);
    if (mc.length) {
      makeChart(canvasIn(byModelCard._body), {
        type: 'bar', data: { labels: mc.map(function (e) { return e[0]; }), datasets: [{ data: mc.map(function (e) { return e[1]; }), backgroundColor: mc.map(function (_, i) { return PALETTE[i % PALETTE.length]; }), borderRadius: 5 }] },
        options: { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return fmtUSD(c.parsed.x); } } } }, scales: { x: { grid: { color: GRID }, ticks: { callback: function (v) { return fmtUSD(v); } } }, y: { grid: { display: false } } } }
      });
    } else { byModelCard._body.appendChild(el('div', 'empty', 'No priced model data.')); }
    row.appendChild(byModelCard);
    host.appendChild(row);

    var topCard = card('Most expensive sessions');
    var top = fs.slice().sort(function (a, b) { return b.costUSD - a.costUSD; }).slice(0, 10);
    topCard._body.style.paddingTop = '0';
    topCard._body.innerHTML = '<div class="table-wrapper">' + tableHTML(
      ['Session', 'Agent', 'Project', 'Input', 'Output', 'Cached', 'Total', 'Cost'],
      top.map(function (s) {
        return [esc(s.sessionId.slice(0, 8)),
          '<span class="tag tag-sm" style="text-transform:capitalize">' + esc(s.agentName) + '</span>',
          '<span title="' + esc(s.project) + '">' + esc(shortPath(s.project)) + '</span>',
          fmtTokens(tkIn(s)), fmtTokens(tkOut(s)), fmtTokens(tkCached(s)), fmtTokens(s.tokens ? s.tokens.total : 0), fmtUSD(s.costUSD)];
      }),
      [false, false, false, true, true, true, true, true]) + '</div>';
    host.appendChild(topCard);
  };

  VIEWS.sessions = function (host, fs) {
    host.appendChild(el('h2', 'view-title', 'Sessions'));
    host.appendChild(el('p', 'view-sub', fs.length + ' sessions · search by project, agent, branch, or id.'));
    var bar = el('div', 'mb16');
    var input = el('input', 'input search-input'); input.placeholder = 'Search sessions…';
    bar.appendChild(input); host.appendChild(bar);
    var c = card('All sessions'); c._body.style.paddingTop = '0';
    var holder = el('div', 'table-wrapper'); c._body.appendChild(holder); host.appendChild(c);
    // Delegated row → modal. Attached ONCE on the persistent holder (draw() re-sets innerHTML
    // on every keystroke, so a listener inside draw would stack and fire N times).
    holder.addEventListener('click', function (ev) {
      var tr = ev.target.closest('tr[data-session]'); if (!tr) return;
      openSessionModal(SESSION_BY_ID[tr.getAttribute('data-session')]);
    });

    function draw(q) {
      var list = fs.slice().sort(function (a, b) { return b.startTime - a.startTime; });
      if (q) {
        var ql = q.toLowerCase();
        list = list.filter(function (s) { return (s.sessionId + ' ' + s.agentName + ' ' + s.project + ' ' + s.branch).toLowerCase().indexOf(ql) >= 0; });
      }
      var shown = list.slice(0, 300);
      holder.innerHTML = tableHTML(
        ['Date', 'Agent', 'Project', 'Branch', 'Turns', 'Net lines', 'Input', 'Output', 'Cached', 'Cost'],
        shown.map(function (s) {
          return [new Date(s.startTime).toISOString().slice(0, 16).replace('T', ' '),
            '<span class="tag tag-sm" style="text-transform:capitalize">' + esc(s.agentName) + '</span>',
            '<span title="' + esc(s.project) + '">' + esc(shortPath(s.project)) + '</span>', esc(s.branch || '—'),
            fmtNum(s.turns), fmtNum(s.netLines), fmtTokens(tkIn(s)), fmtTokens(tkOut(s)), fmtTokens(tkCached(s)), fmtUSD(s.costUSD)];
        }),
        [false, false, false, false, true, true, true, true, true, true],
        shown.map(function (s) { return 'class="clickable" data-session="' + esc(s.sessionId) + '"'; }));
      if (list.length > 300) holder.appendChild(el('p', 'text-muted', '<span style="font-size:12px">Showing first 300 of ' + list.length + '.</span>'));
    }
    input.addEventListener('input', function () { draw(input.value.trim()); });
    draw('');
  };

  // ---- session-detail modal ----------------------------------------------
  var modalCharts = []; // owned by the modal; NOT in the global charts[] (decoupled from destroyCharts()).
  var modalEsc = null;
  function makeModalChart(canvas, config) {
    if (!window.Chart) return null;
    var c = new Chart(canvas, config);
    modalCharts.push(c);
    return c;
  }
  function closeSessionModal() {
    modalCharts.forEach(function (c) { try { c.destroy(); } catch (e) {} });
    modalCharts = [];
    if (modalEsc) { document.removeEventListener('keydown', modalEsc); modalEsc = null; }
    var ov = document.getElementById('session-modal'); if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  }
  var MODAL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtWhen(ms) { var d = new Date(ms); return MODAL_MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function hashStr(s) { var h = 0; s = String(s); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  // Lighter, borderless stat grid (label + value), replacing the heavy box-in-box KPI cards.
  function statsEl(items) { // items: [label, value(html-safe), sub]
    var g = el('div', 'modal-stats');
    items.forEach(function (k) {
      var c = el('div', 'mstat');
      c.appendChild(el('div', 'mlabel', esc(k[0])));
      c.appendChild(el('div', 'mval', k[1])); // value is formatter output (fmt*), not user text
      if (k[2]) c.appendChild(el('div', 'msub', esc(k[2])));
      g.appendChild(c);
    });
    return g;
  }
  function sumCalls(list) { return (list || []).reduce(function (a, n) { return a + (n.totalCalls || 0); }, 0); }
  // Name→count list for a dispatch kind, derived from the timed native-log dispatches (the timeline's
  // source) so counts/chips stay consistent with it; falls back to the tracked named-invocation
  // counts when this session has no dispatch data (e.g. older/tracked-only sessions).
  function dispatchCounts(s, kind) {
    var disp = (s.dispatches || []).filter(function (d) { return d.kind === kind; });
    if (disp.length) {
      var m = {};
      disp.forEach(function (d) { m[d.name] = (m[d.name] || 0) + 1; });
      return Object.keys(m).map(function (n) { return { name: n, totalCalls: m[n] }; });
    }
    return kind === 'agent' ? (s.agentInvocations || []) : kind === 'skill' ? (s.skillInvocations || []) : (s.commandInvocations || []);
  }
  function chipsEl(title, list) { // list: NamedInvocationStats[]
    var sec = el('div', 'dispatch-col');
    sec.appendChild(el('h4', null, esc(title) + ' (' + (list ? list.length : 0) + ')'));
    if (!list || !list.length) { sec.appendChild(el('div', 'text-muted', '<span style="font-size:12px">none</span>')); return sec; }
    var wrap = el('div', 'modal-chips');
    list.slice().sort(function (a, b) { return b.totalCalls - a.totalCalls; }).forEach(function (n) {
      wrap.appendChild(el('span', 'chip', esc(n.name) + '<b>×' + fmtNum(n.totalCalls) + '</b>'));
    });
    sec.appendChild(wrap); return sec;
  }
  // One timeline row: label + track with a positioned bar + a right-aligned duration. All text esc()'d.
  function tlRow(label, color, leftPct, wPct, durText, barText, strong) {
    var row = el('div', 'tl-row');
    row.appendChild(el('div', 'tl-label' + (strong ? ' tl-label-strong' : ''), esc(label)));
    var track = el('div', 'tl-track');
    var bar = el('div', 'tl-bar');
    bar.style.left = 'calc(min(' + leftPct + '%, 100% - 28px))'; bar.style.width = wPct + '%'; bar.style.background = color;
    if (barText) {
      bar.classList.add('tl-bar-has-text');
      bar.innerHTML = '<span class="tl-bar-text">' + esc(barText) + '</span>';
    }
    bar.title = label + ' · ' + durText; // .title property = safe (not parsed as HTML)
    track.appendChild(bar); row.appendChild(track);
    row.appendChild(el('div', 'tl-dur', esc(durText)));
    return row;
  }
  // Precise wall-clock timing for short timeline steps. The general report formatter rounds
  // sub-minute values up to one minute, which is useful for sessions but misleading here.
  function fmtTimelineDuration(ms) {
    ms = Math.max(0, ms || 0);
    if (ms < 1000) return Math.round(ms) + 'ms';
    if (ms < 60000) return (Math.round(ms / 100) / 10) + 's';
    if (ms < 3600000) return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
    return Math.floor(ms / 3600000) + 'h ' + Math.round((ms % 3600000) / 60000) + 'm';
  }
  // Side panel content for a selected timeline step.
  function tlDetailEl(d) {
    var panel = el('div', '');
    if (!d) {
      panel.appendChild(el('div', 'tl-side-empty', 'Click a timeline step to see details.'));
      return panel;
    }
    var color = PALETTE[hashStr(d.kind + ':' + d.name) % PALETTE.length];
    var nameEl = el('div', 'tl-side-name');
    var dot = el('span', 'tl-side-dot'); dot.style.background = color;
    nameEl.appendChild(dot);
    nameEl.appendChild(document.createTextNode(d.kind + ' · ' + d.name));
    panel.appendChild(nameEl);
    var hasCost = d.costUSD != null;
    var hasTok = d.tokens != null;
    panel.appendChild(statsEl([
      ['Cost', hasCost ? fmtUSD(d.costUSD) : '—', ''],
      ['Tokens', hasTok ? fmtTokens(d.tokens.total) : '—', ''],
      ['Duration', fmtTimelineDuration(d.durationMs), ''],
    ]));
    if (hasTok) {
      var tok = d.tokens;
      var total = Math.max(tok.total, 1);
      var barEl = el('div', 'tl-tok-bar');
      var segs = [
        { val: tok.input,         color: '#7C5CFC' },
        { val: tok.output,        color: '#F5A534' },
        { val: tok.cacheRead,     color: '#259F4C' },
        { val: tok.cacheCreation, color: '#3B82F6' },
      ].filter(function(s) { return s.val > 0; });
      segs.forEach(function(s) {
        var seg = el('div', 'tl-tok-seg');
        seg.style.flex = String(s.val / total * 100);
        seg.style.background = s.color;
        barEl.appendChild(seg);
      });
      var tokSec = el('div', 'tl-side-section');
      tokSec.appendChild(el('div', 'tl-side-label', 'Token breakdown'));
      tokSec.appendChild(barEl);
      tokSec.appendChild(statsEl([
        ['Input',       fmtTokens(tok.input),         ''],
        ['Output',      fmtTokens(tok.output),        ''],
        ['Cache read',  fmtTokens(tok.cacheRead),     ''],
        ['Cache write', fmtTokens(tok.cacheCreation), ''],
      ]));
      panel.appendChild(tokSec);
    }
    if (d.tools && d.tools.length) {
      var toolSec = el('div', 'tl-side-section');
      toolSec.appendChild(el('div', 'tl-side-label', 'Tools called'));
      var chips = el('div', 'modal-chips');
      d.tools.forEach(function(t) {
        chips.appendChild(el('span', 'chip', esc(t.name) + '<b>\xd7' + fmtNum(t.calls) + '</b>'));
      });
      toolSec.appendChild(chips);
      panel.appendChild(toolSec);
    }
    return panel;
  }
  // Gantt of top-level agent dispatches: session span on top, each agent bar positioned
  // by wall-clock start time relative to the session start (proportional scaling).
  // Skills and commands are excluded — they have no separate transcript or cost to show.
  // min-width 28px (CSS) keeps short agents visible and clickable without distorting the scale.
  function timelineEl(s) {
    var dispatches = (s.dispatches || []).filter(function (d) { return d.kind === 'agent'; }).sort(function (a, b) { return a.start - b.start; });
    // Scale bars to the agent activity window, not the full session duration.
    // Agent bars fill the track proportionally relative to each other; absolute
    // start offset (vs. session start) is shown in the side panel detail view.
    var actStart = dispatches.length ? dispatches.reduce(function (m, d) { return Math.min(m, d.start); }, Infinity) : s.startTime;
    var actEnd = dispatches.length ? dispatches.reduce(function (m, d) { return Math.max(m, d.start + (d.durationMs || 0)); }, -Infinity) : s.startTime + s.durationMs;
    var ganttSpan = Math.max(1, actEnd - actStart);

    var container = el('div', 'tl-container');
    var gantt = el('div', 'tl-gantt timeline');
    var sidePane = el('div', 'tl-side');

    var selected = dispatches[0] || null;
    sidePane.appendChild(tlDetailEl(selected));

    function selectDispatch(d, barEl) {
      gantt.querySelectorAll('.tl-bar[data-dispatch]').forEach(function(b) {
        b.style.outline = b === barEl ? '2px solid rgba(255,255,255,0.55)' : 'none';
      });
      sidePane.innerHTML = '';
      sidePane.appendChild(tlDetailEl(d));
    }

    gantt.appendChild(tlRow('session', '#259F4C', 0, 100, fmtTimelineDuration(s.durationMs), fmtUSD(s.costUSD), true));

    var occ = {};
    dispatches.forEach(function (d) {
      var key = d.kind + ':' + d.name;
      var total = dispatches.filter(function (x) { return x.kind === d.kind && x.name === d.name; }).length;
      occ[key] = (occ[key] || 0) + 1;
      var label = d.kind + ' · ' + d.name + (total > 1 ? ' #' + occ[key] : '');
      var leftPct = Math.max(0, (d.start - actStart) / ganttSpan * 100);
      var wPct = (d.durationMs || 0) / ganttSpan * 100;
      if (leftPct + wPct > 100) wPct = Math.max(0, 100 - leftPct);
      var barText = d.costUSD != null && wPct >= 8 ? fmtUSD(d.costUSD) : '';
      var color = PALETTE[hashStr(key) % PALETTE.length];
      var row = tlRow(label, color, leftPct, wPct, fmtTimelineDuration(d.durationMs), barText, false);
      var bar = row.querySelector('.tl-bar');
      if (bar) {
        bar.setAttribute('data-dispatch', key);
        if (d === selected) bar.style.outline = '2px solid rgba(255,255,255,0.55)';
      }
      row.style.cursor = 'pointer';
      row.addEventListener('click', function () { selectDispatch(d, bar); });
      gantt.appendChild(row);
    });

    container.appendChild(gantt);
    container.appendChild(sidePane);
    return container;
  }
  function openSessionModal(s, onBack) {
    if (!s) return;
    closeSessionModal();
    var ov = el('div', 'modal-overlay'); ov.id = 'session-modal';
    var modal = el('div', 'modal');

    // header — every interpolation through esc(); title is arbitrary user text (XSS vector).
    var head = el('div', 'modal-head');
    var htxt = el('div');
    // onBack (optional): when this modal was reached from another modal (e.g. the project
    // sessions list), render a Back affordance that returns there instead of just closing.
    if (onBack) {
      var back = el('button', 'modal-back', '← Back');
      back.setAttribute('aria-label', 'Back to project');
      back.addEventListener('click', function () { closeSessionModal(); onBack(); });
      htxt.appendChild(back);
    }
    htxt.appendChild(el('div', 'modal-title', esc(truncStr(firstWords(sessTitle(s), 10), 120))));
    var metaBits = [s.agentName, (s.models && s.models[0]) || null, shortPath(s.project), s.branch].filter(Boolean);
    htxt.appendChild(el('div', 'modal-meta', metaBits.map(function (b) { return esc(b); }).join('  ·  ')));
    head.appendChild(htxt);
    var close = el('button', 'modal-close', '✕'); close.setAttribute('aria-label', 'Close'); close.addEventListener('click', closeSessionModal);
    head.appendChild(close);
    modal.appendChild(head);

    var body = el('div', 'modal-body');

    // Cost & Time / Token Usage / Activity — light borderless stats, equal-height cards.
    var t = s.tokens || { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
    var grid3 = el('div', 'grid-3');
    var costCard = card('Cost & Time'); costCard._body.appendChild(statsEl([
      ['Cost', fmtUSD(s.costUSD), 'API-equivalent'],
      ['Cache-read', s.cacheReadCostUSD ? fmtUSD(s.cacheReadCostUSD) : '—', ''],
      ['Duration', fmtDuration(s.durationMs || 0), ''],
      ['Started', '<span class="mval-sm">' + esc(fmtWhen(s.startTime)) + '</span>', '']
    ]));
    var tokCard = card('Token usage'); tokCard._body.appendChild(statsEl([
      ['Input', fmtTokens(t.input), ''], ['Output', fmtTokens(t.output), ''],
      ['Cache read', fmtTokens(t.cacheRead), ''], ['Cache create', fmtTokens(t.cacheCreation), ''],
      ['Total', fmtTokens(t.total), '']
    ]));
    var actCard = card('Activity'); actCard._body.appendChild(statsEl([
      ['Turns / API', fmtNum(s.turns), ''],
      ['Tool calls', fmtNum(s.toolCallsTotal), (s.toolCallsTotal ? Math.round((s.toolCallsSuccess / s.toolCallsTotal) * 100) + '% ok' : '')],
      ['Agents', fmtNum(sumCalls(dispatchCounts(s, 'agent'))), ''],
      ['Skills', fmtNum(sumCalls(dispatchCounts(s, 'skill'))), ''],
      ['Commands', fmtNum(sumCalls(dispatchCounts(s, 'command'))), '']
    ]));
    grid3.appendChild(costCard); grid3.appendChild(tokCard); grid3.appendChild(actCard);
    body.appendChild(grid3);

    // Code changes
    var ccCard = card('Code changes'); ccCard._body.appendChild(statsEl([
      ['Files changed', fmtNum(s.filesChanged || 0), 'written or edited'],
      ['Lines added', '+' + fmtNum(s.linesAdded || 0), ''],
      ['Lines removed', '−' + fmtNum(s.linesRemoved || 0), ''],
      ['Net lines', ((s.netLines || 0) >= 0 ? '+' : '') + fmtNum(s.netLines || 0), '']
    ]));
    body.appendChild(ccCard);

    // Token & cost growth chart (backfilled per-turn series; honest fallback when absent)
    var growth = card('Token & cost growth', 'cumulative per turn — from the native log');
    var series = s.costSeries || [];
    if (series.length >= 2 && window.Chart) {
      var useTs = series[0].t > 1e12; // epoch ms vs turn ordinal
      var t0 = series[0].t;
      var labels = series.map(function (p) { return useTs ? fmtDuration(Math.max(0, p.t - t0)) : ('turn ' + p.t); });
      var cv = canvasIn(growth._body, 220);
      makeModalChart(cv, {
        type: 'line',
        data: { labels: labels, datasets: [
          { label: 'Cost ($)', data: series.map(function (p) { return Math.round(p.cost * 10000) / 10000; }), borderColor: '#7C5CFC', backgroundColor: 'rgba(124,92,252,0.12)', fill: true, yAxisID: 'y', tension: 0.25, pointRadius: 0 },
          { label: 'Tokens', data: series.map(function (p) { return p.tokens; }), borderColor: '#F5A534', backgroundColor: 'transparent', fill: false, yAxisID: 'y1', tension: 0.25, pointRadius: 0 }
        ] },
        options: { interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: true } },
          scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } },
            y: { position: 'left', grid: { color: GRID }, ticks: { callback: function (v) { return fmtUSD(v); } } },
            y1: { position: 'right', grid: { display: false }, ticks: { callback: function (v) { return fmtTokens(v); } } } } }
      });
    } else {
      growth._body.appendChild(el('div', 'empty', 'Per-turn data not available for this session.'));
    }
    body.appendChild(growth);

    // Timeline — Gantt of all top-level agent, skill, and command dispatches.
    var hasDispatches = (s.dispatches || []).length > 0;
    var hasCostData = (s.dispatches || []).some(function (d) { return d.kind === 'agent' && d.costUSD != null; });
    var tlSubtitle = hasDispatches ? (hasCostData ? 'click a step for cost, token & timing details · long idle gaps compressed' : 'click a step for timing details · long idle gaps compressed') : '';
    var tlCard = card('Timeline', tlSubtitle);
    if (hasDispatches) {
      tlCard._body.appendChild(timelineEl(s));
    } else {
      tlCard._body.appendChild(el('div', 'empty', 'No agent, skill, or command dispatches recorded for this session.'));
    }
    body.appendChild(tlCard);

    appendToolsAndModels(body, [s], makeModalChart);
    appendInvocationCharts(body, [s], makeModalChart);

    modal.appendChild(body);
    ov.appendChild(modal);
    ov.addEventListener('click', function (ev) { if (ev.target === ov) closeSessionModal(); });
    modalEsc = function (ev) { if (ev.key === 'Escape') closeSessionModal(); };
    document.addEventListener('keydown', modalEsc);
    document.body.appendChild(ov);
  }

  // ---- project-sessions modal --------------------------------------------
  var projModalEsc = null;
  function closeProjectModal() {
    if (projModalEsc) { document.removeEventListener('keydown', projModalEsc); projModalEsc = null; }
    var ov = document.getElementById('project-modal'); if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  }
  function openProjectModal(projectPath, sessions) {
    closeProjectModal();
    var sorted = sessions.slice().sort(function (a, b) { return b.startTime - a.startTime; });
    var ov = el('div', 'modal-overlay'); ov.id = 'project-modal';
    var modal = el('div', 'modal');

    var head = el('div', 'modal-head');
    var htxt = el('div');
    htxt.appendChild(el('div', 'modal-title', esc(shortPath(projectPath))));
    htxt.appendChild(el('div', 'modal-meta', esc(projectPath)));
    head.appendChild(htxt);
    var close = el('button', 'modal-close', '✕'); close.setAttribute('aria-label', 'Close'); close.addEventListener('click', closeProjectModal);
    head.appendChild(close);
    modal.appendChild(head);

    var body = el('div', 'modal-body');
    var totalCost = sum(sessions, function (s) { return s.costUSD || 0; });
    var totalTurns = sum(sessions, function (s) { return s.turns || 0; });
    var netLines = sum(sessions, function (s) { return s.netLines || 0; });
    body.appendChild(statsEl([
      ['Sessions', fmtNum(sessions.length)],
      ['Total cost', fmtUSD(totalCost)],
      ['Turns', fmtNum(totalTurns)],
      ['Net lines', (netLines >= 0 ? '+' : '') + fmtNum(netLines)]
    ]));

    var tbl = el('div', 'table-wrapper proj-sessions');
    tbl.innerHTML = tableHTML(
      ['Session', 'Date', 'Turns', 'Cost', ''],
      sorted.map(function (s) {
        return [
          // Truncate to a short preview (~12 words / 100 chars): keeps the table compact and
          // avoids exposing the full first-prompt text in the project list.
          esc(truncStr(firstWords(sessTitle(s), 12), 100)),
          esc(fmtWhen(s.startTime)),
          fmtNum(s.turns || 0),
          fmtUSD(s.costUSD || 0),
          '<button class="btn-open" data-open-session="' + esc(s.sessionId) + '">Open ↗</button>'
        ];
      }),
      [false, false, true, true, false]
    );
    tbl.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-open-session]');
      if (!btn) return;
      var sid = btn.getAttribute('data-open-session');
      closeProjectModal();
      // Pass an onBack closure so the session modal can return to this project list.
      openSessionModal(SESSION_BY_ID[sid], function () { openProjectModal(projectPath, sessions); });
    });
    body.appendChild(tbl);
    modal.appendChild(body);
    ov.appendChild(modal);
    ov.addEventListener('click', function (ev) { if (ev.target === ov) closeProjectModal(); });
    projModalEsc = function (ev) { if (ev.key === 'Escape') closeProjectModal(); };
    document.addEventListener('keydown', projModalEsc);
    document.body.appendChild(ov);
  }

  // ---- table + misc helpers ----------------------------------------------
  function tdNum(v) { return '<span class="td-number">' + (typeof v === 'number' ? fmtNum(v) : v) + '</span>'; }
  // numericCols: optional boolean[] marking right-aligned numeric columns. Default = every
  // column except the first (back-compat). Text columns (agent, project, branch, status) must
  // be left-aligned, so callers with interleaved/leading text pass an explicit mask.
  function tableHTML(headers, rows, numericCols, rowAttrs) {
    var isNum = numericCols || headers.map(function (_, i) { return i > 0; });
    var h = '<table class="table"><thead><tr>';
    headers.forEach(function (x, i) { h += '<th' + (isNum[i] ? ' class="td-number"' : '') + '>' + esc(x) + '</th>'; });
    h += '</tr></thead><tbody>';
    if (!rows.length) h += '<tr><td colspan="' + headers.length + '" class="text-muted">No data</td></tr>';
    rows.forEach(function (r, ri) {
      var attrs = rowAttrs && rowAttrs[ri] ? ' ' + rowAttrs[ri] : '';
      h += '<tr' + attrs + '>' + r.map(function (cell, i) { return '<td' + (isNum[i] ? ' class="td-number"' : '') + '>' + cell + '</td>'; }).join('') + '</tr>';
    });
    return h + '</tbody></table>';
  }
  // tokens shorthand: cached = cacheRead + cacheCreation (the prompt-cache reuse + writes)
  function tkIn(s) { return s.tokens ? s.tokens.input : 0; }
  function tkOut(s) { return s.tokens ? s.tokens.output : 0; }
  function tkCached(s) { return s.tokens ? (s.tokens.cacheRead + s.tokens.cacheCreation) : 0; }
  function topOf(arr) { var m = {}; arr.forEach(function (x) { m[x] = (m[x] || 0) + 1; }); var best = null, bc = 0; for (var k in m) if (m[k] > bc) { bc = m[k]; best = k; } return best; }

  // ---- render + controls --------------------------------------------------
  function setTheme(light) {
    document.documentElement.classList.toggle('light', !!light);
    try { localStorage.setItem('codemie-analytics-theme', light ? 'light' : 'dark'); } catch (e) {}
    render(); // recolor charts for the new theme
  }

  function render() {
    closeSessionModal();
    applyChartTheme();
    destroyCharts();
    root.innerHTML = '';
    (VIEWS[state.view] || VIEWS.overview)(root, filtered());
    document.querySelectorAll('.nav-i').forEach(function (n) { n.classList.toggle('active', n.getAttribute('data-view') === state.view); });
  }

  function buildControls() {
    // nav
    document.querySelectorAll('.nav-i').forEach(function (n) {
      n.addEventListener('click', function () { state.view = n.getAttribute('data-view'); render(); });
    });
    // range presets (incl. Today) — selecting one clears any custom date range
    var dFrom = document.getElementById('date-from');
    var dTo = document.getElementById('date-to');
    document.querySelectorAll('#range-seg button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.range = b.getAttribute('data-range');
        state.from = null; state.to = null;
        if (dFrom) dFrom.value = '';
        if (dTo) dTo.value = '';
        document.querySelectorAll('#range-seg button').forEach(function (x) { x.classList.toggle('on', x === b); });
        render();
      });
    });
    // custom date range — applies on change, deactivates the preset segment
    function onDateChange() {
      state.from = parseLocalDate(dFrom && dFrom.value, false);
      state.to = parseLocalDate(dTo && dTo.value, true);
      if (state.from != null || state.to != null) {
        state.range = 'custom';
        document.querySelectorAll('#range-seg button').forEach(function (x) { x.classList.remove('on'); });
      }
      render();
    }
    if (dFrom) dFrom.addEventListener('change', onDateChange);
    if (dTo) dTo.addEventListener('change', onDateChange);
    var dClear = document.getElementById('date-clear');
    if (dClear) dClear.addEventListener('click', function () {
      state.from = null; state.to = null;
      if (dFrom) dFrom.value = '';
      if (dTo) dTo.value = '';
      state.range = 'all';
      document.querySelectorAll('#range-seg button').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-range') === 'all'); });
      render();
    });
    // agent chips
    var chips = document.getElementById('agent-chips');
    DATA.meta.agents.forEach(function (a) {
      var chip = el('span', 'chip-tog');
      chip.innerHTML = '<span class="dot" style="background:' + colorFor(a) + '"></span>' + esc(a);
      chip.addEventListener('click', function () {
        if (state.agents.has(a)) { state.agents.delete(a); chip.classList.add('off'); }
        else { state.agents.add(a); chip.classList.remove('off'); }
        render();
      });
      chips.appendChild(chip);
    });
    // project select
    var sel = document.getElementById('project-select');
    var projects = Array.from(new Set(DATA.sessions.map(function (s) { return s.project; }))).sort();
    sel.innerHTML = '<option value="all">All projects (' + projects.length + ')</option>' + projects.map(function (p) { return '<option value="' + esc(p) + '">' + esc(shortPath(p)) + '</option>'; }).join('');
    sel.addEventListener('change', function () { state.project = sel.value; render(); });
    // footer
    document.getElementById('side-foot').innerHTML = fmtNum(DATA.meta.totals.sessions) + ' sessions<br>' + DATA.meta.agents.length + ' agents<br>generated ' + esc((DATA.meta.generatedAt || '').slice(0, 10));
    // theme switch (bottom-left)
    var sw = document.getElementById('theme-switch');
    if (sw) {
      var label = sw.querySelector('.ts-text');
      function syncThemeText() { if (label) label.textContent = document.documentElement.classList.contains('light') ? 'Light' : 'Dark'; }
      function toggleTheme() { setTheme(!document.documentElement.classList.contains('light')); syncThemeText(); }
      sw.addEventListener('click', toggleTheme);
      sw.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTheme(); } });
      syncThemeText();
    }
  }

  // apply saved theme before first paint. Default = dark (CodeMie's product default);
  // only an explicit saved choice flips it to light.
  (function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('codemie-analytics-theme'); } catch (e) {}
    document.documentElement.classList.toggle('light', saved === 'light');
  })();

  buildControls();
  render();
})();

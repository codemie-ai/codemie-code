/*
 * © 2026 EPAM Systems, Inc. ("EPAM"). All rights reserved.
 * EPAM intellectual property, provided under a limited license — see LICENSE.
 * Ownership and all IP rights remain with EPAM and are NOT transferred by use,
 * incorporation, or cloning into any repository.
 */

/*!
 * CodeMie page controls — theme switch + presenter toolbar.
 * Injected by scripts/inject-controls.js. No dependencies.
 *
 * Adapts to the page it lands on:
 *   deck  — the page has .slide / [data-slide] elements: Nav switches slides
 *           and Focus opens a two-up presenter window.
 *   page  — anything else: Nav scrolls between headings, Focus is hidden.
 *
 * Always present: Laser, Timer, Fullscreen, Theme.
 * The theme boot script lives inline in <head> so light paints first.
 */
(function () {
  'use strict';

  var THEME_KEY = 'codemie-theme';
  var root = document.documentElement;
  var PRESENTER = new URLSearchParams(location.search).get('presenter') === '1';

  var ICON = {
    nav: '<path d="M12 18.5 4.5 21 12 3l7.5 18-7.5-2.5z"/>',
    laser: '<path d="M4 4l3.9 13.6a1.2 1.2 0 0 0 2.2.3l2.1-3.1 4.9 4.9a1.07 1.07 0 0 0 1.5 0l1.05-1.05a1.07 1.07 0 0 0 0-1.5l-4.9-4.9 3.1-2.1a1.2 1.2 0 0 0-.3-2.2z"/>',
    focus: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
    timer: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    full: '<path d="M4 8V6a2 2 0 0 1 2-2h2M4 16v2a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v2M16 20h2a2 2 0 0 0 2-2v-2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    left: '<path d="M15 6l-6 6 6 6"/>',
    right: '<path d="M9 6l6 6-6 6"/>'
  };
  function svg(d) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  }
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  /* ---------------- targets: slides, else headings ---------------- */
  var slides = Array.prototype.slice.call(document.querySelectorAll('[data-slide], .slide'));
  var DECK = slides.length > 1;
  var targets = slides;

  if (!DECK) {
    targets = Array.prototype.slice.call(
      document.querySelectorAll('[data-section], main section[id], .card > .card-header .card-title, h2')
    ).filter(function (n) { return n.offsetParent !== null || n.getClientRects().length; });
  }

  function labelOf(node) {
    if (DECK) {
      var h = node.querySelector('.s-title, .title-h, .demo-h, h1, h2, h3');
      return h ? h.textContent.trim() : 'Slide';
    }
    return (node.textContent || '').trim().slice(0, 90) || 'Section';
  }

  /* ---------------- toolbar ---------------- */
  var pos = document.body.getAttribute('data-controls-position') === 'bottom' ? 'bottom' : 'top';
  var wrap = el('div', 'cm-controls');
  wrap.setAttribute('data-pos', pos);
  var bar = el('div', 'cm-bar');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Page controls');

  function tool(id, icon, text, title) {
    var b = el('button', 'cm-tool', svg(icon) + '<span>' + text + '</span>');
    b.type = 'button';
    b.id = id;
    b.title = title;
    return b;
  }

  var bNav = tool('cmNav', ICON.nav, 'Nav', 'Navigation (arrows, Home, End)');
  bNav.setAttribute('aria-expanded', 'false');
  var bLaser = tool('cmLaser', ICON.laser, 'Laser', 'Laser pointer (L, Escape to exit)');
  bLaser.setAttribute('aria-pressed', 'false');
  var bFocus = tool('cmFocus', ICON.focus, 'Focus', 'Open presenter view on a second display');
  var bTimer = tool('cmTimer', ICON.timer, 'Timer', 'Timer (T, Shift+T resets)');
  bTimer.setAttribute('aria-pressed', 'false');
  var bFull = tool('cmFull', ICON.full, 'Full', 'Fullscreen (F)');
  bFull.setAttribute('aria-pressed', 'false');
  var bTheme = tool('cmTheme', ICON.moon, 'Dark', 'Switch colour theme');

  if (targets.length > 1) bar.appendChild(bNav);
  bar.appendChild(bLaser);
  if (DECK) bar.appendChild(bFocus);
  bar.appendChild(bTimer);
  bar.appendChild(bFull);
  bar.appendChild(el('span', 'cm-sep'));
  bar.appendChild(bTheme);
  wrap.appendChild(bar);

  var nav = el('div', 'cm-nav');
  nav.hidden = true;
  var step = el('div', 'cm-step');
  var stepPrev = el('button', null, svg(ICON.left));
  stepPrev.type = 'button';
  stepPrev.setAttribute('aria-label', 'Previous');
  var stepCount = el('span', null, '1 / ' + targets.length);
  var stepNext = el('button', null, svg(ICON.right));
  stepNext.type = 'button';
  stepNext.setAttribute('aria-label', 'Next');
  step.append(stepPrev, stepCount, stepNext);
  var list = el('ol', 'cm-list');
  nav.append(step, list);
  wrap.appendChild(nav);

  var status = el('p', 'cm-status');
  status.hidden = true;
  status.setAttribute('role', 'status');
  wrap.appendChild(status);
  document.body.appendChild(wrap);

  var laser = el('span', 'cm-laser');
  laser.hidden = true;
  laser.setAttribute('aria-hidden', 'true');
  var timerBadge = el('output', 'cm-timer', '00:00');
  timerBadge.hidden = true;
  timerBadge.setAttribute('role', 'timer');
  document.body.append(laser, timerBadge);

  /* ---------------- navigation ---------------- */
  var index = 0;

  targets.forEach(function (node, i) {
    var li = document.createElement('li');
    var b = document.createElement('button');
    b.type = 'button';
    var n = el('span', 'cm-n');
    n.textContent = String(i + 1);
    var lab = document.createElement('span');
    lab.textContent = labelOf(node);
    b.append(n, lab);
    b.addEventListener('click', function () { go(i); });
    li.appendChild(b);
    list.appendChild(li);
  });

  // still: set the position without scrolling, so a page opens on its title, not its first card.
  function go(i, still) {
    if (!targets.length) return;
    index = Math.max(0, Math.min(targets.length - 1, i));
    if (DECK) {
      targets.forEach(function (s, n) { s.classList.toggle('is-active', n === index); });
    } else if (!still) {
      targets[index].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    stepCount.textContent = (index + 1) + ' / ' + targets.length;
    stepPrev.disabled = index === 0;
    stepNext.disabled = index === targets.length - 1;
    Array.prototype.forEach.call(list.querySelectorAll('button'), function (b, n) {
      b.setAttribute('aria-current', n === index ? 'true' : 'false');
    });
    syncPresenter();
    window.dispatchEvent(new CustomEvent('codemie:navigate', { detail: { index: index, total: targets.length } }));
  }
  function move(d) { go(index + d); }
  stepPrev.addEventListener('click', function () { move(-1); });
  stepNext.addEventListener('click', function () { move(1); });
  bNav.addEventListener('click', function () {
    nav.hidden = !nav.hidden;
    bNav.setAttribute('aria-expanded', String(!nav.hidden));
  });

  /* ---------------- laser ---------------- */
  var laserOn = false;
  function setLaser(on) {
    laserOn = on;
    bLaser.setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('cm-laser-on', on);
    laser.hidden = !on;
  }
  bLaser.addEventListener('click', function () { setLaser(!laserOn); });
  window.addEventListener('pointermove', function (e) {
    if (!laserOn) return;
    laser.style.left = e.clientX + 'px';
    laser.style.top = e.clientY + 'px';
  });

  /* ---------------- timer ---------------- */
  var timerOn = false, startedAt = null, tick = 0;
  function fmt(total) {
    var h = Math.floor(total / 3600);
    var m = String(Math.floor(total / 60) % 60).padStart(2, '0');
    var s = String(total % 60).padStart(2, '0');
    return (h ? h + ':' : '') + m + ':' + s;
  }
  function paintTimer() {
    var t = fmt(startedAt === null ? 0 : Math.floor((Date.now() - startedAt) / 1000));
    timerBadge.textContent = t;
    var pv = document.getElementById('cmPvTimer');
    if (pv) pv.textContent = t;
  }
  function setTimer(on) {
    timerOn = on;
    bTimer.setAttribute('aria-pressed', String(on));
    timerBadge.hidden = !on;
    window.clearInterval(tick);
    if (on) {
      if (startedAt === null) startedAt = Date.now();
      paintTimer();
      tick = window.setInterval(paintTimer, 500);
    }
  }
  function resetTimer() { startedAt = Date.now(); paintTimer(); }
  bTimer.addEventListener('click', function () { setTimer(!timerOn); });

  /* ---------------- fullscreen ---------------- */
  function toggleFull() {
    if (document.fullscreenElement) { if (document.exitFullscreen) document.exitFullscreen(); return; }
    if (root.requestFullscreen) root.requestFullscreen();
  }
  bFull.addEventListener('click', toggleFull);
  document.addEventListener('fullscreenchange', function () {
    bFull.setAttribute('aria-pressed', String(Boolean(document.fullscreenElement)));
  });

  /* ---------------- theme ---------------- */
  function applyTheme(t, persist) {
    root.classList.toggle('light', t === 'light');
    root.setAttribute('data-theme', t);
    if (persist !== false) { try { localStorage.setItem(THEME_KEY, t); } catch (e) {} }
    bTheme.innerHTML = svg(t === 'light' ? ICON.moon : ICON.sun) +
      '<span>' + (t === 'light' ? 'Dark' : 'Light') + '</span>';
    retheme();
    window.dispatchEvent(new CustomEvent('codemie:theme', { detail: { theme: t } }));
  }
  bTheme.addEventListener('click', function () {
    applyTheme(root.classList.contains('light') ? 'dark' : 'light', true);
  });

  /* Chart.js pages get axis/legend colours refreshed for free. Pages that bake
     colours into datasets should listen for codemie:theme and rebuild. */
  function retheme() {
    if (typeof window.Chart === 'undefined') return;
    var css = getComputedStyle(root);
    var muted = (css.getPropertyValue('--color-text-muted') || '#888').trim();
    var grid = (css.getPropertyValue('--color-chart-grid') || '').trim() ||
      (root.classList.contains('light') ? 'rgba(51,51,51,0.12)' : 'rgba(127,127,127,0.18)');
    window.Chart.defaults.color = muted;
    window.Chart.defaults.borderColor = grid;
    var reg = window.Chart.instances || {};
    Object.keys(reg).forEach(function (k) {
      var c = reg[k];
      try {
        if (c.options && c.options.plugins && c.options.plugins.title) c.options.plugins.title.color = muted;
        c.update('none');
      } catch (e) {}
    });
  }

  /* ---------------- presenter window ---------------- */
  var presenterWin = null;
  function say(msg) {
    if (!msg) { status.hidden = true; return; }
    status.textContent = msg;
    status.hidden = false;
    window.setTimeout(function () { status.hidden = true; }, 6000);
  }
  bFocus.addEventListener('click', function () {
    if (presenterWin && !presenterWin.closed) { presenterWin.focus(); return; }
    var url = location.href.split('#')[0].split('?')[0] + '?presenter=1';
    var w = window.open(url, 'codemie-presenter', 'width=1180,height=720');
    if (!w) { say('Pop-up blocked. Allow pop-ups to open Focus view.'); return; }
    presenterWin = w;
  });
  function syncPresenter() {
    if (!presenterWin || presenterWin.closed) return;
    try { presenterWin.postMessage({ type: 'cm-sync', index: index }, '*'); } catch (e) {}
  }
  window.addEventListener('message', function (e) {
    // Trust the window reference, not the origin: file:// pages report a null origin.
    if (!presenterWin || e.source !== presenterWin) return;
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'cm-ready') syncPresenter();
    else if (d.type === 'cm-nav' && (d.delta === 1 || d.delta === -1)) move(d.delta);
  });
  window.addEventListener('beforeunload', function () {
    if (presenterWin && !presenterWin.closed) presenterWin.close();
  });

  /* ---------------- keyboard ---------------- */
  function typing(t) {
    return t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || ''));
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && laserOn) { e.preventDefault(); setLaser(false); return; }
    if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    var k = e.key, low = k.toLowerCase();
    if (low === 'l') { e.preventDefault(); setLaser(!laserOn); }
    else if (low === 't' && !e.shiftKey) { e.preventDefault(); setTimer(!timerOn); }
    else if (low === 't' && e.shiftKey) { e.preventDefault(); resetTimer(); }
    else if (low === 'f') { e.preventDefault(); toggleFull(); }
    else if (low === 'n' && targets.length > 1) { e.preventDefault(); bNav.click(); }
    else if (targets.length > 1 && (k === 'ArrowRight' || k === 'PageDown' || k === ' ')) { e.preventDefault(); move(1); }
    else if (targets.length > 1 && (k === 'ArrowLeft' || k === 'PageUp')) { e.preventDefault(); move(-1); }
    else if (targets.length > 1 && k === 'Home') { e.preventDefault(); go(0); }
    else if (targets.length > 1 && k === 'End') { e.preventDefault(); go(targets.length - 1); }
  });

  var wakeTimer = 0;
  function wake(ms) {
    wrap.classList.add('is-awake');
    window.clearTimeout(wakeTimer);
    wakeTimer = window.setTimeout(function () { wrap.classList.remove('is-awake'); }, ms);
  }
  window.addEventListener('pointermove', function (e) {
    var near = pos === 'top' ? e.clientY < 140 : e.clientY > window.innerHeight - 140;
    if (near) wake(1800);
  });
  // Shown once on opening, so a reader learns it is there; not under ?static, the screenshot mode.
  if (!/[?&]static\b/.test(location.search)) wake(2500);

  /* ---------------- presenter surface (?presenter=1) ---------------- */
  function buildPresenter() {
    root.classList.add('cm-presenter-mode');
    var pv = el('section', 'cm-presenter',
      '<header class="cm-pv-head">' +
        '<span>Presenter view &mdash; move this window to your second display</span>' +
        '<b id="cmPvTimer">00:00</b><b id="cmPvCount">1 / 1</b>' +
      '</header>' +
      '<div class="cm-pv-main">' +
        '<section class="cm-pv-col"><h2>Current</h2><div class="cm-pv-stage" id="cmPvCur"></div></section>' +
        '<section class="cm-pv-col" id="cmPvNextCol"><h2>Next</h2><div class="cm-pv-stage" id="cmPvNextStage"></div></section>' +
      '</div>' +
      '<aside class="cm-pv-notes" id="cmPvNotes"></aside>' +
      '<footer class="cm-pv-foot">' +
        '<button type="button" id="cmPvPrev">' + svg(ICON.left) + ' Previous</button>' +
        '<button type="button" id="cmPvNext">Next ' + svg(ICON.right) + '</button>' +
      '</footer>');
    pv.setAttribute('aria-label', 'Presenter view');
    document.body.appendChild(pv);

    var i = 0;
    var cur = document.getElementById('cmPvCur');
    // The next-slide preview has its own id; cmPvNext is the Next button.
    var nxt = document.getElementById('cmPvNextStage');
    var nxtCol = document.getElementById('cmPvNextCol');
    var notes = document.getElementById('cmPvNotes');
    var count = document.getElementById('cmPvCount');

    /* A cloned <canvas> keeps its box but not its bitmap — copy the pixels over. */
    function copyCanvases(from, to) {
      var a = from.querySelectorAll('canvas'), b = to.querySelectorAll('canvas');
      for (var n = 0; n < a.length && n < b.length; n++) {
        if (!a[n].width || !a[n].height) continue;
        b[n].width = a[n].width; b[n].height = a[n].height;
        try { b[n].getContext('2d').drawImage(a[n], 0, 0); } catch (e) {}
      }
    }
    function mount(frame, node) {
      frame.replaceChildren();
      if (!node) return;
      var w = node.offsetWidth || 1280, h = node.offsetHeight || 720;
      var clone = node.cloneNode(true);
      clone.classList.add('cm-snap');
      clone.removeAttribute('id');
      clone.querySelectorAll('[id]').forEach(function (n) { n.removeAttribute('id'); });
      clone.querySelectorAll('button, input, select, textarea').forEach(function (n) { n.disabled = true; });
      clone.querySelectorAll('a').forEach(function (n) { n.removeAttribute('href'); });
      clone.setAttribute('aria-hidden', 'true');
      clone.setAttribute('inert', '');
      frame.appendChild(clone);
      copyCanvases(node, clone);
      var r = frame.getBoundingClientRect();
      var scale = Math.min((r.width || w) / w, (r.height || h) / h);
      clone.style.width = w + 'px';
      clone.style.height = h + 'px';
      clone.style.transform = 'translate(' + ((r.width - w * scale) / 2) + 'px,' +
        ((r.height - h * scale) / 2) + 'px) scale(' + scale + ')';
    }
    function paint() {
      i = Math.max(0, Math.min(targets.length - 1, i));
      mount(cur, targets[i]);
      mount(nxt, targets[i + 1]);
      nxtCol.classList.toggle('is-empty', !targets[i + 1]);
      count.textContent = (i + 1) + ' / ' + targets.length;
      var n = targets[i] && (targets[i].getAttribute('data-notes') || targets[i].getAttribute('data-presenter-notes'));
      notes.textContent = n || 'No presenter notes for this slide.';
      document.getElementById('cmPvPrev').disabled = i <= 0;
      document.getElementById('cmPvNext').disabled = i >= targets.length - 1;
    }
    function ask(d) {
      if (window.opener && !window.opener.closed) {
        try { window.opener.postMessage({ type: 'cm-nav', delta: d }, '*'); return; } catch (e) {}
      }
      i += d; paint();
    }
    document.getElementById('cmPvPrev').addEventListener('click', function () { ask(-1); });
    document.getElementById('cmPvNext').addEventListener('click', function () { ask(1); });
    document.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); ask(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); ask(-1); }
    }, true);
    window.addEventListener('message', function (e) {
      if (!window.opener || e.source !== window.opener) return;
      if (e.data && e.data.type === 'cm-sync' && typeof e.data.index === 'number') { i = e.data.index; paint(); }
    });

    var t0 = Date.now();
    window.setInterval(function () {
      document.getElementById('cmPvTimer').textContent = fmt(Math.floor((Date.now() - t0) / 1000));
    }, 500);
    window.addEventListener('resize', paint);
    window.setTimeout(paint, 60);
    window.setTimeout(paint, 700);
    if (window.opener && !window.opener.closed) {
      try { window.opener.postMessage({ type: 'cm-ready' }, '*'); } catch (e) {}
    }
  }

  /* ---------------- boot ---------------- */
  applyTheme(root.classList.contains('light') ? 'light' : 'dark', false);
  if (targets.length) go(0, true);
  if (PRESENTER && DECK) buildPresenter();

  window.codemieControls = {
    go: go, next: function () { move(1); }, prev: function () { move(-1); },
    setTheme: function (t) { applyTheme(t === 'dark' ? 'dark' : 'light', true); },
    toggleLaser: function () { setLaser(!laserOn); },
    toggleTimer: function () { setTimer(!timerOn); },
    resetTimer: resetTimer,
    targets: targets, isDeck: DECK
  };
})();

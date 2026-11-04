/*!
 * CodeMie deck runtime: puts the slides on a 1600 × 900 stage scaled to the window.
 * Injected after controls.js by scripts/inject-controls.js, only on pages with slides; the controls
 * switch slides, deck.js frames them.
 *
 *   <body data-deck="Deck name">                    left side of every footer, and the close's marker (else <title>)
 *   <section class="slide" data-section="Problem"   section marker above the title
 *            data-notes="…">                         speaker notes for the presenter view
 *   data-backup       after the close: numbered B1, B2, outside the count
 *   data-foot="none"  no footer on this slide; a cover or a close never has one
 *   #4 in the address opens slide 4; ?static drops the fade, for screenshots and review
 *   .waffle > i[data-n]  expands into that many squares; svg.dg gets the #ah arrowhead markers
 */
(function () {
  'use strict';

  var slides = Array.prototype.slice.call(document.querySelectorAll('[data-slide], .slide'));
  if (slides.length < 2) return;
  var root = document.documentElement;
  root.classList.add('cm-deck');
  if (/[?&]static\b/.test(location.search)) root.classList.add('deck-static');
  // The stage shows once every slide is sized (settle, below); this is the fallback if that stalls.
  var ready = function () { root.classList.add('deck-ready'); };
  setTimeout(ready, 2500);

  /* ---------------- stage ---------------- */
  var stage = document.querySelector('.deck-stage');
  if (!stage) {
    var deck = document.createElement('div');
    deck.className = 'deck';
    stage = document.createElement('main');
    stage.className = 'deck-stage';
    deck.appendChild(stage);
    slides[0].parentNode.insertBefore(deck, slides[0]);
    slides.forEach(function (s) { stage.appendChild(s); });
  }

  /* ---------------- section markers and footers ---------------- */
  var name = document.body.getAttribute('data-deck') || document.title;
  var main = slides.filter(function (s) { return !s.hasAttribute('data-backup'); });
  var backup = slides.filter(function (s) { return s.hasAttribute('data-backup'); });
  var two = function (n) { return (n < 10 ? '0' : '') + n; };
  slides.forEach(function (s) {
    var cover = s.classList.contains('cover');
    var close = s.classList.contains('close');
    var section = s.getAttribute('data-section');
    // The close has no title to mark: its marker names the deck, and it takes no footer.
    var mark = section || (close ? name : '');
    if (mark && !cover && !s.querySelector('.deck-section')) {
      var marker = document.createElement('p');
      marker.className = 'deck-section';
      marker.textContent = mark;
      s.insertBefore(marker, s.firstChild);
    }
    if (cover || close || s.getAttribute('data-foot') === 'none' || s.querySelector('.deck-foot')) return;
    var foot = document.createElement('footer');
    var left = document.createElement('span');
    var deckName = document.createElement('b');
    var page = document.createElement('span');
    var i = main.indexOf(s);
    foot.className = 'deck-foot';
    page.className = 'pg';
    deckName.textContent = name;
    left.appendChild(deckName);
    if (section) left.appendChild(document.createTextNode(' · ' + section));
    page.textContent = i === -1 ? 'B' + (backup.indexOf(s) + 1) : two(i + 1) + ' / ' + two(main.length);
    foot.append(left, page);
    s.appendChild(foot);
  });

  /* ---------------- icons ---------------- */
  // <i class="ico" data-i="server"></i> becomes that line drawing. Each names a real thing; there
  // is deliberately no sparkle, rocket or bulb. scripts/build.js reads these names to check a deck.
  var ICONS = {
    alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.5v.01"/>',
    bot: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4.5V8M3 13v3M21 13v3M9.5 13v1M14.5 13v1"/>',
    box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
    chart: '<path d="M4 20h16M7 16v-4M12 16V7M17 16v-6"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    cloud: '<path d="M7.5 18h9a4.5 4.5 0 0 0 .6-8.96A6 6 0 0 0 5.6 10.3 3.9 3.9 0 0 0 7.5 18z"/>',
    code: '<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>',
    coin: '<circle cx="12" cy="12" r="8.5"/><path d="M14.6 9.4c-.4-.9-1.4-1.5-2.6-1.5-1.5 0-2.6.8-2.6 2 0 2.6 5.2 1.4 5.2 4.1 0 1.2-1.1 2.1-2.6 2.1-1.2 0-2.2-.6-2.6-1.5M12 6.4v1.5M12 16.1v1.5"/>',
    database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>',
    flow: '<rect x="3" y="3.5" width="7" height="6" rx="1.5"/><rect x="14" y="14.5" width="7" height="6" rx="1.5"/><path d="M10 6.5h3.5a2.5 2.5 0 0 1 2.5 2.5v5.5"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
    git: '<circle cx="6" cy="5.5" r="2.2"/><circle cx="6" cy="18.5" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 7.7v8.6M18 10.2c0 4.3-6 3.5-10.6 6.6"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.7 5.4 3.7 8.5s-1.2 5.9-3.7 8.5c-2.5-2.6-3.7-5.4-3.7-8.5S9.5 6.1 12 3.5z"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
    laptop: '<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M3 19h18"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7l8.5 6 8.5-6"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>',
    plug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.4-4.4"/>',
    server: '<rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="16" height="6" rx="1.5"/><path d="M8 7h.01M8 17h.01"/>',
    shield: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
    ticket: '<path d="M4 6h16v4a2 2 0 0 0 0 4v4H4v-4a2 2 0 0 0 0-4z"/><path d="M14 6v12"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21c.6-3.8 3.6-6 7.5-6s6.9 2.2 7.5 6"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.5-3.3 3.1-5.3 6.5-5.3s6 2 6.5 5.3M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.9c2 .7 3.3 2.5 3.6 5.1"/>'
  };
  Array.prototype.forEach.call(document.querySelectorAll('i.ico[data-i]'), function (el) {
    var d = ICONS[el.getAttribute('data-i')];
    if (d) el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg>';
  });

  /* ---------------- figures written in short ---------------- */
  // <i class="ok" data-n="27"></i> in a .waffle becomes 27 squares.
  Array.prototype.forEach.call(document.querySelectorAll('.waffle > [data-n]'), function (cell) {
    var n = parseInt(cell.getAttribute('data-n'), 10) || 1;
    cell.removeAttribute('data-n');
    for (var k = 1; k < n; k++) cell.parentNode.insertBefore(cell.cloneNode(false), cell.nextSibling);
  });
  // Arrowheads for svg.dg drawings: marker-end="url(#ah)", or #ah1, #ah2, #ah3 in the category colours.
  if (document.querySelector('svg.dg') && !document.getElementById('ah')) {
    var heads = [['ah', 'var(--color-text-muted)'], ['ah1', 'var(--color-chart-blue)'],
      ['ah2', 'var(--color-chart-purple)'], ['ah3', 'var(--color-chart-cyan)']];
    var lib = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    lib.setAttribute('width', '0');
    lib.setAttribute('height', '0');
    lib.setAttribute('aria-hidden', 'true');
    lib.style.position = 'absolute';
    lib.innerHTML = '<defs>' + heads.map(function (h) {
      return '<marker id="' + h[0] + '" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse"' +
        ' markerWidth="12" markerHeight="12" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" style="fill:' + h[1] + '"/></marker>';
    }).join('') + '</defs>';
    document.body.appendChild(lib);
  }

  // A range in a title or a lede ("4–8 h", "15–20") never breaks at its dash, nor does a short
  // hyphenated word ("AI-agent", "end-to-end").
  Array.prototype.forEach.call(document.querySelectorAll('.slide :is(h1, h2, .lede)'), function (head) {
    var walk = document.createTreeWalker(head, NodeFilter.SHOW_TEXT), nodes = [], t;
    while ((t = walk.nextNode())) if (/\d\s?[–-]\s?\d|[^\s-]-[^\s-]/.test(t.nodeValue)) nodes.push(t);
    nodes.forEach(function (node) {
      var frag = document.createDocumentFragment(), text = node.nodeValue, last = 0, m,
        re = /[$€£]?\d[\d.,]*\s?[–-]\s?\d[\d.,]*\s?(?:[%+]|[^\s\d.,;:!?)]{1,6}(?=[\s.,;:!?)]|$))?|(?<![\p{L}\p{N}-])[\p{L}\p{N}]{1,10}(?:-[\p{L}\p{N}]{1,10}){1,2}(?![\p{L}\p{N}-])/gu;
      while ((m = re.exec(text))) {
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        var keep = document.createElement('span');
        keep.style.whiteSpace = 'nowrap';
        keep.textContent = m[0];
        frag.appendChild(keep);
        last = m.index + m[0].length;
      }
      frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });
  });

  // A short key phrase in a title ("level 2", up to 16 characters) stays on one line; a longer one wraps.
  Array.prototype.forEach.call(document.querySelectorAll('.slide :is(h1, h2) > span:not(.chip)'), function (s) {
    if (s.textContent.trim().length <= 16) s.style.whiteSpace = 'nowrap';
  });

  /* ---------------- fit the stage to the window ---------------- */
  function fit() {
    var pad = document.fullscreenElement ? 0 : 48;
    var scale = Math.min((window.innerWidth - pad) / 1600, (window.innerHeight - pad) / 900);
    root.style.setProperty('--deck-scale', Math.max(scale, 0.2).toFixed(4));
  }
  window.addEventListener('resize', fit);
  document.addEventListener('fullscreenchange', fit);
  fit();

  /* ---------------- each body sized to its slide ---------------- */
  // Every slide is laid out while hidden, so each one can be measured. A sparse body grows from
  // 20 px towards 26 px while its content fills under three quarters of the space and every box
  // still holds its text; a crowded one steps down to 15 px. A slide that still overflows is
  // marked and named in the console.
  var BASE = 20, MOST = 26, LEAST = 15;
  function natural(body) {
    body.style.flex = 'none';
    body.style.height = 'auto';
    var h = body.offsetHeight;
    body.style.flex = '';
    body.style.height = '';
    return h;
  }
  // True when a line of text runs past the box that holds it. Arrows and markers drawn outside
  // a box are not text, so they never count.
  var range = document.createRange();
  function cramped(body) {
    var walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT), t, box, r;
    while ((t = walk.nextNode())) {
      if (!/\S/.test(t.nodeValue) || t.parentElement.closest('svg')) continue;
      box = t.parentElement;
      while (box !== body && getComputedStyle(box).display === 'inline') box = box.parentElement;
      range.selectNodeContents(t);
      r = range.getBoundingClientRect();
      var b = box.getBoundingClientRect();
      if (r.width && (r.right > b.right + 1 || r.left < b.left - 1)) return true;
    }
    return false;
  }
  // How much of a body's height its content takes, from the boxes as drawn: a split or a row of
  // columns counts by what is inside it, a ladder or a chart frame by the space it stretches over.
  function filled(body) {
    var top = Infinity, bottom = -Infinity, box = body.getBoundingClientRect();
    Array.prototype.forEach.call(body.children, function (k) {
      if (k.matches('.fine, .note')) return;
      var parts = k.matches('.split, .cols-2, .cols-3, .cols-4') ? k.children : [k];
      Array.prototype.forEach.call(parts, function (q) {
        var r = q.getBoundingClientRect();
        if (r.height) { top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom); }
      });
    });
    return bottom > top && box.height ? Math.min(100, Math.round((bottom - top) / box.height * 100)) : 100;
  }
  function settle() {
    slides.forEach(function (s, n) {
      var body = s.querySelector('.slide-body');
      if (body) {
        var size = BASE;
        var room = body.clientHeight;
        body.style.fontSize = '';
        while (size < MOST && natural(body) < room * 0.6 && !cramped(body)) {
          body.style.fontSize = (size + 1) + 'px';
          if (natural(body) > room * 0.75 || cramped(body)) {
            body.style.fontSize = size > BASE ? size + 'px' : '';
            break;
          }
          size += 1;
        }
        while ((body.scrollHeight > body.clientHeight + 1 || cramped(body)) && size > LEAST) {
          size -= 1;
          body.style.fontSize = size + 'px';
        }
        var fill = filled(body);
        body.setAttribute('data-fill', fill);
        // Content that fills under 70% of the body sits in its middle, not under the title.
        if (fill < 70) body.classList.add('mid');
      }
      var over = (body && body.scrollHeight > body.clientHeight + 1) ||
        s.scrollHeight > s.clientHeight + 1 || s.scrollWidth > s.clientWidth + 1;
      s.toggleAttribute('data-overflow', !!over);
      if (over) console.warn('CodeMie deck: slide ' + (n + 1) + ' overflows the stage; cut words or split it.');
    });
    wire();
    stir();
    ready();
  }

  /* ---------------- hub connectors ---------------- */
  // .hub: input rows, the core, output rows. One dashed curve joins each row to the core, in the
  // row's colour, drawn once the text is sized. Layout offsets, so the stage's scale cannot move them.
  var NS = 'http://www.w3.org/2000/svg';
  function at(el, hub) {
    var x = 0, y = 0;
    while (el && el !== hub) { x += el.offsetLeft; y += el.offsetTop; el = el.offsetParent; }
    return { x: x, y: y };
  }
  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll('.slide .hub'), function (hub) {
      var old = hub.querySelector(':scope > .hub-wires');
      if (old) old.remove();
      var cols = Array.prototype.slice.call(hub.children);
      if (cols.length < 2) return;
      var core = cols[1].matches('.pane, .focus') ? cols[1] : cols[1].querySelector('.pane, .focus') || cols[1];
      var c = at(core, hub), svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'hub-wires');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('width', hub.offsetWidth);
      svg.setAttribute('height', hub.offsetHeight);
      [cols[0], cols[2]].forEach(function (side, out) {
        var rows = side ? side.querySelectorAll('.rows > :not(.cap)') : [];
        Array.prototype.forEach.call(rows, function (row, i) {
          var r = at(row, hub), ry = r.y + row.offsetHeight / 2;
          var cy = c.y + core.offsetHeight * (i + 1) / (rows.length + 1);
          var x1 = out ? c.x + core.offsetWidth : r.x + row.offsetWidth, y1 = out ? cy : ry;
          var x2 = out ? r.x : c.x, y2 = out ? ry : cy, mx = (x1 + x2) / 2;
          var path = document.createElementNS(NS, 'path');
          path.setAttribute('d', 'M' + x1 + ' ' + y1 + 'C' + mx + ' ' + y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2);
          var k = String(row.className).match(/\bc[0-5]\b/);
          if (k) path.setAttribute('class', k[0]);
          svg.appendChild(path);
        });
      });
      hub.appendChild(svg);
    });
  }

  /* ---------------- motion ---------------- */
  // A slide's parts rise in turn as it opens: each part is the smallest of these that holds no
  // other, so a visual's rows, steps or cards come one by one. Titles stay put. deck.css turns it
  // off for ?static, reduced motion and print.
  var PARTS = '.slide-body > *, .split > *, .zone > *, :is(.cols-2, .cols-3, .cols-4) > *, .rows > *, ' +
    '.into > :first-child > *, .into > :not(:first-child), .hub > :not(.hub-wires), .chain > *, .ladder > *, ' +
    '.steps > li, .kpis > *, .layers > *, .bars > *, .hbars > *, .callouts > li, .decisions > li, ' +
    '.cover-art > *, .slide.close > p';
  function stir() {
    slides.forEach(function (s) {
      var n = 0;
      Array.prototype.forEach.call(s.querySelectorAll(PARTS), function (el) {
        if (el.querySelector(PARTS)) return;
        el.classList.add('rise');
        el.style.setProperty('--i', Math.min(n++, 12));
      });
    });
  }

  if (document.fonts && document.fonts.ready) document.fonts.ready.then(settle);
  else settle();

  /* ---------------- #N in the address bar ---------------- */
  var controls = window.codemieControls;
  function fromHash() {
    var n = parseInt(location.hash.slice(1), 10);
    if (n > 0 && controls) controls.go(n - 1);
  }
  window.addEventListener('codemie:navigate', function (e) {
    if (history.replaceState) history.replaceState(null, '', '#' + (e.detail.index + 1));
  });
  window.addEventListener('hashchange', fromHash);
  fromHash();
})();

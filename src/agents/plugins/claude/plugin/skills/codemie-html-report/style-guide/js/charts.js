/**
 * CodeMie chart theming for Chart.js, embedded by scripts/inject-charts.mjs.
 *
 * Chart.js resolves colours once and paints them onto a canvas, so a chart drawn in the light theme
 * keeps light-theme series, grid lines and labels after the switch. CodeMieCharts reads every colour
 * from the page's live design tokens and re-applies them on the codemie:theme event the controls fire.
 *
 *     CodeMieCharts.create('spend', { type: 'bar', data: { labels: [...], datasets: [{ label: 'USD', data: [...] }] } });
 *
 * Series take blue, purple and cyan in the product's order, then grey for "other": green, amber and
 * red mean status on a report, so a series gets one only by naming its token ({ token: 'error' }).
 * Options passed to create() win over these defaults, functions such as tick callbacks included.
 */
window.CodeMieCharts = (function () {
  var SERIES = ['chart-blue', 'chart-purple', 'chart-cyan', 'chart-other'];
  var ARC = ['doughnut', 'pie', 'polarArea'];
  var CARTESIAN = ['bar', 'line', 'scatter', 'bubble'];
  var charts = [];

  /** A design token, --color-<name>, as a CSS colour; with alpha, as rgba(). */
  function color(name, alpha) {
    var raw = getComputedStyle(document.documentElement).getPropertyValue('--color-' + name).trim();
    if (!raw) return 'transparent';
    if (alpha === undefined) return raw;
    var hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
    var rgb = hex
      ? (hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1]).match(/../g).map(function (h) { return parseInt(h, 16); })
      : (/^rgba?\(([^)]+)\)$/i.exec(raw) || [, ''])[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3);
    return rgb.length === 3 ? 'rgba(' + rgb.join(', ') + ', ' + alpha + ')' : raw;
  }

  /** The token for series i: blue, purple, cyan, then grey for every later series. */
  function series(i) {
    return SERIES[Math.min(i, SERIES.length - 1)];
  }

  function palette(count) {
    var out = [];
    for (var i = 0; i < count; i++) out.push(color(series(i)));
    return out;
  }

  /** Axis, grid, legend and tooltip styling for the theme that is live now. */
  function defaults(type, count, onSlide, family) {
    var muted = color('text-muted');
    var grid = color('chart-grid');
    var arc = ARC.indexOf(type) !== -1;
    // A slide is 1600 px wide and shown smaller, so its charts need larger text than a page's.
    // The family is the canvas's own: Geist Mono on a page, as the app's charts, Geist on a slide.
    var font = { size: onSlide ? 16 : 12, family: family };
    var axis = function () {
      return { grid: { color: grid }, border: { color: grid }, ticks: { color: muted, font: font } };
    };
    var options = {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      color: muted,
      borderColor: grid,
      plugins: {
        // One series needs no key: the card title names it.
        legend: { display: arc || count > 1, labels: { color: muted, font: font, boxWidth: 10, boxHeight: 10, usePointStyle: true } },
        tooltip: {
          backgroundColor: color('bg-elevated'),
          titleColor: color('text-primary'),
          bodyColor: color('text-secondary'),
          titleFont: font,
          bodyFont: font,
          borderColor: color('border-panel'),
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
        },
      },
    };
    // An arc chart given x and y scales would grow axes around the doughnut.
    if (CARTESIAN.indexOf(type) !== -1) options.scales = { x: axis(), y: axis() };
    return options;
  }

  function isPlain(value) {
    return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
  }

  /** Deep-merge `base` under `own`: whatever the caller set wins. */
  function under(own, base) {
    var out = {};
    var key;
    for (key in base) out[key] = base[key];
    for (key in own) out[key] = isPlain(own[key]) && isPlain(base[key]) ? under(own[key], base[key]) : own[key];
    return out;
  }

  /** Colour the datasets that set no colour of their own, from the palette or their named token. */
  function paint(type, datasets, auto) {
    var arc = ARC.indexOf(type) !== -1;
    datasets.forEach(function (d, i) {
      if (!auto[i]) return;
      if (arc) {
        d.backgroundColor = palette((d.data || []).length);
        d.borderColor = color('bg-card');
        d.borderWidth = 2;
        return;
      }
      var name = d.token || series(i);
      d.borderColor = color(name);
      if (type === 'line') {
        d.backgroundColor = color(name, 0.15);
        d.pointBackgroundColor = d.borderColor;
        if (d.pointRadius === undefined) d.pointRadius = 2;
      } else {
        d.backgroundColor = d.borderColor;
        if (type === 'bar') {
          d.borderWidth = 0;
          if (d.borderRadius === undefined) d.borderRadius = 4;
        }
      }
    });
  }

  /** Draw a themed chart into a canvas (an element or its id) and keep it themed. */
  function create(target, config) {
    var canvas = typeof target === 'string' ? document.getElementById(target) : target;
    if (!canvas) throw new Error('CodeMieCharts: no canvas "' + target + '"');
    if (typeof window.Chart === 'undefined') {
      throw new Error('CodeMieCharts: Chart.js is missing; put <script>/* __CODEMIE_CHARTS__ */</script> before this script and run scripts/build.mjs');
    }
    if (!canvas.hasAttribute('role')) canvas.setAttribute('role', 'img');
    var datasets = (config.data && config.data.datasets) || [];
    var auto = datasets.map(function (d) { return !(d.backgroundColor || d.borderColor); });
    paint(config.type, datasets, auto);
    var own = config.options || {};
    var onSlide = !!(canvas.closest && canvas.closest('.slide'));
    var family = getComputedStyle(canvas).fontFamily;
    var setup = { type: config.type, data: config.data, options: under(own, defaults(config.type, datasets.length, onSlide, family)) };
    if (config.plugins) setup.plugins = config.plugins;
    var chart = new window.Chart(canvas, setup);
    charts.push({ chart: chart, type: config.type, own: own, auto: auto, onSlide: onSlide, family: family });
    // A canvas paints with whatever face has loaded; draw again once the embedded ones have.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { chart.update('none'); });
    return chart;
  }

  // Recolour in place rather than rebuild: an update keeps the reader's hover and tooltip.
  window.addEventListener('codemie:theme', function () {
    charts.forEach(function (entry) {
      paint(entry.type, entry.chart.data.datasets, entry.auto);
      entry.chart.options = under(entry.own, defaults(entry.type, entry.chart.data.datasets.length, entry.onSlide, entry.family));
      entry.chart.update('none');
    });
  });

  return { create: create, color: color, palette: palette };
})();

// Company Dashboard wallboard renderer.
// Scales the fixed 1920×1080 board to the viewport, keeps the clock live,
// and re-fetches /api/data every minute.

(function () {
  'use strict';

  var DATA_REFRESH_MS = 60 * 1000;
  var board = document.getElementById('board');
  var wrap = document.getElementById('wrap');

  // ----- scaling -----
  function rescale() {
    var scale = (window.innerWidth || 1920) / 1920;
    board.style.transform = 'scale(' + scale + ')';
    wrap.style.height = Math.round(1080 * scale) + 'px';
  }
  window.addEventListener('resize', rescale);
  rescale();

  // ----- clock -----
  var MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  var DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  function tickClock() {
    var d = new Date();
    var h = d.getHours();
    var ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    var m = String(d.getMinutes()).padStart(2, '0');
    document.getElementById('clock').textContent = h + ':' + m + ' ' + ampm;
    document.getElementById('dateStr').textContent =
      DAYS[d.getDay()] + ' ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
  }
  tickClock();
  setInterval(tickClock, 15000);

  // ----- helpers -----
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // $397.9K / $1.3M style, with the unit in a muted smaller span.
  function moneyShort(n) {
    var unit = '', v = n;
    if (n >= 1e6) { unit = 'M'; v = n / 1e6; }
    else if (n >= 1e3) { unit = 'K'; v = n / 1e3; }
    var s = unit ? (v >= 100 ? v.toFixed(0) : v.toFixed(1)) : String(Math.round(v));
    var span = document.createDocumentFragment();
    span.appendChild(document.createTextNode('$' + s));
    if (unit) {
      var u = el('span', 'unit', unit);
      span.appendChild(u);
    }
    return span;
  }

  function axisMoney(n) {
    if (n >= 1e6) return '$' + (n / 1e6 >= 10 ? Math.round(n / 1e6) : (n / 1e6).toFixed(1).replace(/\.0$/, '.0')) + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }

  // ----- charts -----
  // Weekly buckets from a 180-day daily series: [0..89] = prior period,
  // [90..179] = current. 13 buckets of 7 days each (last bucket may be short).
  function weeklyBuckets(daily, offset) {
    var out = [];
    for (var w = 0; w < 13; w++) {
      var s = 0;
      for (var i = w * 7; i < Math.min((w + 1) * 7, 90); i++) s += daily[offset + i] || 0;
      out.push(s);
    }
    return out;
  }

  var VB_W = 640, VB_H = 330, X0 = 70, X1 = 620, Y_TOP = 30, Y_BOT = 270;

  function pts(values, max) {
    var coords = [];
    for (var i = 0; i < values.length; i++) {
      var x = X0 + (X1 - X0) * (i / (values.length - 1));
      var y = Y_BOT - (Y_BOT - Y_TOP) * (max > 0 ? values[i] / max : 0);
      coords.push([Math.round(x), Math.round(y)]);
    }
    return coords;
  }

  function poly(coords, attrs) {
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    p.setAttribute('points', coords.map(function (c) { return c.join(','); }).join(' '));
    p.setAttribute('fill', 'none');
    for (var k in attrs) p.setAttribute(k, attrs[k]);
    return p;
  }

  function niceMax(n) {
    if (n <= 0) return 1000;
    var pow = Math.pow(10, Math.floor(Math.log10(n)));
    var steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] * pow >= n) return steps[i] * pow;
    }
    return 10 * pow;
  }

  function renderChart(plotId, monthsId, daily, color, seriesStartYmd) {
    var current = weeklyBuckets(daily, 90);
    var prior = weeklyBuckets(daily, 0);
    var max = niceMax(Math.max.apply(null, current.concat(prior)));

    var plot = $(plotId);
    plot.innerHTML = '';
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + VB_W + ' ' + VB_H);
    svg.setAttribute('preserveAspectRatio', 'none');

    [Y_TOP, (Y_TOP + Y_BOT) / 2, Y_BOT].forEach(function (y, i) {
      var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', X0); line.setAttribute('x2', X1);
      line.setAttribute('y1', y); line.setAttribute('y2', y);
      line.setAttribute('stroke', i === 2 ? '#3f4141' : '#2e2f2f');
      line.setAttribute('stroke-width', '1');
      svg.appendChild(line);
    });

    svg.appendChild(poly(pts(prior, max), {
      stroke: '#6e6c66', 'stroke-width': '2', 'stroke-dasharray': '6 6',
    }));

    // Current period: solid through the last complete week, then a sparse
    // dotted segment to the in-progress week (matches the design's live tail).
    var cur = pts(current, max);
    var solid = cur.slice(0, cur.length - 1);
    svg.appendChild(poly(solid, {
      stroke: color, 'stroke-width': '3', 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
    svg.appendChild(poly(cur.slice(cur.length - 2), {
      stroke: color, 'stroke-width': '3', 'stroke-dasharray': '2 8', 'stroke-linecap': 'round',
    }));
    plot.appendChild(svg);

    // End-of-line dot as an HTML overlay (a real circle). Drawing it in the
    // SVG would stretch it into an ellipse, since the viewBox uses
    // preserveAspectRatio="none" to make the lines fill the plot.
    var last = solid[solid.length - 1];
    var dot = el('span', 'chart-dot');
    dot.style.left = (last[0] / VB_W * 100) + '%';
    dot.style.top = (last[1] / VB_H * 100) + '%';
    dot.style.background = color;
    plot.appendChild(dot);

    // HTML axis labels overlaid on the gridlines (crisp — not scaled SVG text).
    [[Y_TOP, max], [(Y_TOP + Y_BOT) / 2, max / 2], [Y_BOT, 0]].forEach(function (g) {
      var lab = el('span', 'axis-label', axisMoney(g[1]));
      lab.style.top = (g[0] / VB_H * 100) + '%';
      plot.appendChild(lab);
    });

    // Month ticks: first month after the current period starts, mid, current.
    var months = $(monthsId);
    months.innerHTML = '';
    var start = new Date(seriesStartYmd + 'T12:00:00');
    start.setDate(start.getDate() + 90); // current period start
    [0, 45, 89].forEach(function (off) {
      var d = new Date(start.getTime() + off * 86400e3);
      months.appendChild(el('span', null, MONTHS[d.getMonth()]));
    });
  }

  // ----- render -----
  function render(data) {
    // Hero: MTD
    var mtdDdr = $('mtd-ddr'); mtdDdr.innerHTML = ''; mtdDdr.appendChild(moneyShort(data.sales.ddr.mtd));
    var mtdNw = $('mtd-nuway'); mtdNw.innerHTML = ''; mtdNw.appendChild(moneyShort(data.sales.nuway.mtd));
    var ms = new Date(data.monthStart + 'T12:00:00');
    var td = new Date(data.today + 'T12:00:00');
    var range = MONTHS[ms.getMonth()] + ' ' + ms.getDate() + ' — ' + MONTHS[td.getMonth()] + ' ' + td.getDate();
    $('mtd-range-1').textContent = range;
    $('mtd-range-2').textContent = range;

    // Hero: calls
    function fillPair(prefix, pair) {
      $(prefix + '-oh').textContent = pair.oh.today.total;
      $(prefix + '-ks').textContent = pair.ks.today.total;
      var missed = pair.oh.today.missed + pair.ks.today.missed;
      $(prefix + '-missed').innerHTML = '';
      $(prefix + '-missed').appendChild(document.createTextNode(missed + ' MISSED '));
      var dim = el('span', 'dim', '— OH ' + pair.oh.today.missed + ' · KS ' + pair.ks.today.missed);
      $(prefix + '-missed').appendChild(dim);
      var dOh = pair.oh.today.total - pair.oh.yesterdaySameTime;
      var dKs = pair.ks.today.total - pair.ks.yesterdaySameTime;
      var line = $(prefix + '-delta');
      line.innerHTML = '';
      line.className = 'mono-line ' + (dOh + dKs > 0 ? 'success' : dOh + dKs < 0 ? '' : '');
      var fmt = function (n) { return (n >= 0 ? '+' : '') + n; };
      line.appendChild(document.createTextNode('OH ' + fmt(dOh) + ' '));
      line.appendChild(el('span', 'dim', '·'));
      line.appendChild(document.createTextNode(' KS ' + fmt(dKs) + ' '));
      line.appendChild(el('span', 'dim', 'VS YESTERDAY'));
    }
    fillPair('calls-sales', data.calls.nuwaySales);
    fillPair('calls-svc', data.calls.nuwayService);

    $('calls-ddr').textContent = data.calls.ddrSales.today.total;
    $('calls-ddr-missed').textContent = data.calls.ddrSales.today.missed + ' MISSED';
    var dDdr = data.calls.ddrSales.today.total - data.calls.ddrSales.yesterdaySameTime;
    var ddrLine = $('calls-ddr-delta');
    ddrLine.innerHTML = '';
    ddrLine.className = 'mono-line ' + (dDdr > 0 ? 'success' : '');
    ddrLine.appendChild(document.createTextNode((dDdr >= 0 ? '+' : '') + dDdr + ' '));
    ddrLine.appendChild(el('span', 'dim', 'VS YESTERDAY'));

    // Charts — monochrome bone per the final design
    renderChart('chart-ddr', 'months-ddr', data.sales.ddr.series, '#f7f5f0', data.sales.seriesStart);
    renderChart('chart-nuway', 'months-nuway', data.sales.nuway.series, '#f7f5f0', data.sales.seriesStart);

    // Inventory — OH + KS per row
    var inv = $('inventory');
    inv.innerHTML = '';
    var maxQty = Math.max.apply(null, data.inventory.map(function (i) { return i.qty; }).concat([1]));
    function invCell(qty, loc) {
      var cell = el('span', 'inv-cell');
      cell.appendChild(el('span', 'inv-qty', String(qty)));
      cell.appendChild(el('span', 'inv-loc', loc));
      return cell;
    }
    data.inventory.forEach(function (item) {
      var row = el('div', 'inv-row');
      var name = el('span', 'inv-name');
      name.appendChild(el('span', 'inv-label', item.label));
      var bar = el('span', 'inv-bar');
      var fill = el('span', 'inv-bar-fill');
      fill.style.width = Math.max(1, Math.round(item.qty / maxQty * 100)) + '%';
      bar.appendChild(fill);
      name.appendChild(bar);
      row.appendChild(name);
      row.appendChild(invCell(item.oh, 'OH'));
      row.appendChild(invCell(item.ks, 'KS'));
      inv.appendChild(row);
    });

    // Calls — this week vs last week (inbound)
    var c30 = $('calls30');
    c30.innerHTML = '';
    data.calls.week.forEach(function (r) {
      var row = el('div', 'calls30-row');
      row.appendChild(el('span', 'calls30-name', r.label));
      var nums = el('span', 'calls30-nums');
      var cur = el('span', 'calls30-num', String(r.thisWeek));
      // Ahead of last week's same-point pace → green; behind → red.
      if (r.thisWeek > r.lastWeek) cur.classList.add('up');
      else if (r.thisWeek < r.lastWeek) cur.classList.add('down');
      nums.appendChild(cur);
      nums.appendChild(el('span', 'calls30-last', String(r.lastWeek)));
      row.appendChild(nums);
      c30.appendChild(row);
    });

    // Talk time today — top agent
    var tt = data.calls.talkTime;
    $('talk-name').textContent = tt && tt.name ? tt.name : '—';
    if (tt && tt.seconds > 0) {
      var mins = Math.floor(tt.seconds / 60);
      var secs = tt.seconds % 60;
      $('talk-dur').textContent = (mins >= 60 ? Math.floor(mins / 60) + 'H ' + (mins % 60) + 'M' : mins + 'M ' + secs + 'S');
    } else {
      $('talk-dur').textContent = '—';
    }

    // Sold this week ledger
    var ledger = $('soldWeek');
    ledger.innerHTML = '';
    var dow = (new Date().getDay() + 6) % 7; // 0 = Monday
    var weekFrac = Math.min(1, (dow + 1) / 7);
    data.soldWeek.forEach(function (r) {
      var row = el('div', 'ledger-row');
      var count = el('span', 'ledger-count');
      count.appendChild(el('span', 'ledger-sold', String(r.sold)));
      count.appendChild(el('span', 'ledger-target', '/' + r.target));
      row.appendChild(count);
      row.appendChild(el('span', 'ledger-name', r.label));
      var cls = r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : r.sold === 0 ? 'zero' : 'flat';
      var txt = r.delta > 0 ? '+' + r.delta : r.delta < 0 ? String(r.delta) : r.sold === 0 ? '0' : '—';
      row.appendChild(el('span', 'ledger-delta ' + cls, txt));
      // Badge: on/ahead of full-week target = success; under half of the
      // pro-rated pace = review; in between = no badge (design shows both).
      var badge = null;
      if (r.sold >= r.target) badge = ['success', 'On target'];
      else if (r.sold < r.target * weekFrac * 0.5) badge = ['danger', 'Review'];
      if (badge) {
        var b = el('span', 'badge ' + badge[0]);
        b.appendChild(el('span', 'badge-dot'));
        b.appendChild(document.createTextNode(badge[1]));
        row.appendChild(b);
      }
      ledger.appendChild(row);
    });
  }

  function refresh() {
    fetch('/api/data', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && !data.error) render(data);
      })
      .catch(function () { /* transient — wallboard keeps last render */ });
  }
  refresh();
  setInterval(refresh, DATA_REFRESH_MS);
})();

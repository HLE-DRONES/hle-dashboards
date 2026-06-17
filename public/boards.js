// Dashboard registry — one entry per board in this project.
//
// To add a dashboard:
//   1. Flip its `soon` entry below to a live one (drop `soon: true`), or add
//      a new { path, label } (e.g. { path: '/marketing', label: 'Marketing' }).
//   2. Create public/<name>.html (served at /<name> by the Worker) with the
//      same header band — include <nav class="band-nav" id="band-nav"> and
//      this script — and add a `path === '/<name>'` branch in src/worker.js.
//   3. Give it its own data endpoint in src/worker.js if it needs one.
//
// Every page that includes this script renders the nav with the current
// board active. `soon: true` entries render dimmed and non-clickable.

(function () {
  'use strict';

  var BOARDS = [
    { path: '/sales', label: 'Sales Dashboard' },
    { path: '/marketing', label: 'Marketing', soon: true },
    { path: '/inventory', label: 'Inventory', soon: true },
  ];

  var nav = document.getElementById('band-nav');
  if (!nav) return;
  var here = window.location.pathname.replace(/\/$/, '') || '/';
  BOARDS.forEach(function (b) {
    var target = b.path.replace(/\/$/, '') || '/';
    var node;
    if (b.soon) {
      node = document.createElement('span');
      node.className = 'soon';
      node.textContent = b.label;
      node.title = 'Coming soon';
    } else {
      node = document.createElement('a');
      node.href = b.path;
      node.textContent = b.label;
      if (target === here) node.className = 'active';
    }
    nav.appendChild(node);
  });
})();

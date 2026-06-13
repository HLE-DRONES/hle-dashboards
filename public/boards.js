// Dashboard registry — one entry per board in this project.
//
// To add a dashboard:
//   1. Add { path, label } here (e.g. { path: '/sales', label: 'Sales' }).
//   2. Create public/<name>.html (the Worker's asset handler serves
//      /sales from sales.html automatically) with the same header band,
//      including <nav class="band-nav" id="band-nav"> and this script.
//   3. Give it its own data endpoint in src/worker.js if it needs one.
//
// Every page that includes this script gets the nav rendered with the
// current board highlighted.

(function () {
  'use strict';

  var BOARDS = [
    { path: '/', label: 'Company Dashboard' },
    // Future dashboards go here:
    // { path: '/sales', label: 'Sales' },
  ];

  var nav = document.getElementById('band-nav');
  if (!nav) return;
  var here = window.location.pathname.replace(/\/$/, '') || '/';
  BOARDS.forEach(function (b) {
    var a = document.createElement('a');
    a.href = b.path;
    a.textContent = b.label;
    var target = b.path.replace(/\/$/, '') || '/';
    if (target === here) a.className = 'active';
    nav.appendChild(a);
  });
})();

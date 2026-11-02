// Brisbane transit: every train, bus and ferry in greater Brisbane where the timetable puts it, moving
// over a line drawing of the network in the Scope's style: trains violet, buses amber, ferries teal,
// each with a short trail showing which way it's heading. Each day one train line is the "line of the
// day": the map frames it and draws its track heavy.
// Two modes: moving (from now, at 300 times real speed) and real time.
// Runs from lib/seq-transit.js, Translink's timetable packed by tools/build-transit.py (no internet
// needed). Times are Brisbane's (UTC+10, no daylight saving) wherever the screen is.
(function () {
  const FAST = 300;                    // moving mode: 300 seconds of timetable per second (an hour in 12 seconds)
  const TRAIL = 180;                   // each vehicle's trail: back to where it was this many timetable seconds ago
  const BNE = 10 * 3600 * 1000;        // Brisbane is UTC+10 all year
  const SAVE_KEY = 'transit.mode';
  // a colour for each kind of vehicle, a shade for dark themes and one for light
  const COLOURS = {
    dark: { train: '#a98bff', bus: '#f2a541', ferry: '#3ccfcf' },
    light: { train: '#6236d0', bus: '#c46a00', ferry: '#00838a' },
  };

  // unpack the timetable once, the first time the visual is drawn
  let net = null;
  const lengths = pts => {
    const cos = Math.cos(pts[0][1] * Math.PI / 180), len = [0];
    for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot((pts[i][0] - pts[i - 1][0]) * cos, pts[i][1] - pts[i - 1][1]));
    return len;
  };
  function unpack(d) {
    const seg = new Map();   // "a,b" -> the line between two stations
    for (const [a, b, ferry, p] of d.segments) {
      const pts = []; for (let i = 0; i < p.length; i += 2) pts.push([p[i], p[i + 1]]);
      const len = lengths(pts);
      seg.set(a + ',' + b, { a, b, ferry: !!ferry, pts, len, total: len[len.length - 1] || 1e-9 });
    }
    // train and ferry trips, per service: pattern and start (quarter minutes, stored as gaps from the trip before)
    const services = d.trips.map(flat => {
      const trips = []; let start = 0;
      for (let i = 0; i < flat.length; i += 2) { start += flat[i + 1]; trips.push([d.patterns[flat[i]], start]); }
      return trips;
    });
    // bus paths (whole 1/10000 degrees, as steps), and each typical day's bus trips: path, start, minutes running
    const paths = d.bus.paths.map(flat => {
      const pts = []; let x = 0, y = 0;
      for (let i = 0; i < flat.length; i += 2) { x += flat[i]; y += flat[i + 1]; pts.push([x / 1e4, y / 1e4]); }
      const len = lengths(pts);
      return { pts, len, total: len[len.length - 1] || 1e-9 };
    });
    const bus = {};
    for (const kind of ['wk', 'sa', 'su']) {
      const flat = d.bus[kind] || [], trips = []; let start = 0;
      for (let i = 0; i < flat.length; i += 3) { start += flat[i + 1]; trips.push([paths[flat[i]], start, flat[i + 2]]); }
      bus[kind] = trips;
    }
    return { st: d.stations, seg, services, days: d.days, dayKeys: Object.keys(d.days), lines: d.lines, paths, bus };
  }

  // which train and ferry services run on a Brisbane date (yyyymmdd); a date outside the timetable
  // borrows the first date in it on the same weekday, so an old timetable file still shows a normal day
  const weekday = key => new Date(Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6))).getUTCDay();
  function servicesOn(key) {
    if (net.days[key]) return net.days[key];
    const same = net.dayKeys.find(k => weekday(k) === weekday(key));
    return same ? net.days[same] : [];
  }
  const busDay = key => ({ 6: 'sa', 0: 'su' })[weekday(key)] || 'wk';
  const keyOf = ms => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

  // where a train or ferry is, q quarter minutes after its start: [segment, fraction along it] or null
  function place(pattern, q) {
    const [, s, t] = pattern;
    if (q < 0 || q > t[t.length - 1]) return null;
    for (let i = 0; i < s.length - 1; i++) {
      const dep = t[2 * i], arr = t[2 * i + 1], next = i + 2 < s.length ? t[2 * i + 2] : arr;
      if (q <= next) {
        const f = q >= arr ? 1 : q <= dep ? 0 : (q - dep) / (arr - dep);   // waiting at a station counts as the end of the run in
        const a = s[i], b = s[i + 1], fwd = a < b, g = net.seg.get(fwd ? a + ',' + b : b + ',' + a);
        return g ? [g, fwd ? f : 1 - f] : null;
      }
    }
    return null;
  }
  // a point a fraction of the way along a line (a segment or a bus path), in longitude and latitude
  function along(g, f) {
    const want = Math.max(0, Math.min(1, f)) * g.total, L = g.len;
    let lo = 1, hi = L.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (L[m] < want) lo = m + 1; else hi = m; }
    const k = (want - L[lo - 1]) / ((L[lo] - L[lo - 1]) || 1e-9), p = g.pts[lo - 1], q = g.pts[lo];
    return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k];
  }

  // every vehicle running at a Brisbane time (ms), with where it was TRAIL seconds before: today's trips,
  // and last night's that run on past midnight
  function vehicles(ms) {
    const local = ms + BNE, sod = (local % 86400000) / 1000, out = [];
    for (const [k, extra] of [[keyOf(local), 0], [keyOf(local - 86400000), 86400]]) {
      const now = sod + extra;
      // trains and ferries, from the full timetable
      const q = now / 15, q0 = (now - TRAIL) / 15;
      for (const svc of servicesOn(k)) for (const [pat, start] of net.services[svc]) {
        if (start > q) break;                      // trips are in start order
        const at = place(pat, q - start);
        if (!at) continue;
        const was = place(pat, Math.max(0, q0 - start)) || at;
        out.push({ kind: pat[0] === 1 ? 'ferry' : 'train', pat, g: at[0], at: along(at[0], at[1]), was: along(was[0], was[1]) });
      }
      // buses, at an even pace along their path from first stop to last
      const m = now / 60, m0 = (now - TRAIL) / 60;
      for (const [path, start, mins] of net.bus[busDay(k)]) {
        if (start > m) break;
        if (m > start + mins) continue;
        out.push({ kind: 'bus', at: along(path, (m - start) / mins), was: along(path, Math.max(0, m0 - start) / mins) });
      }
    }
    return out;
  }

  function transit(cv) {
    const view = fitCanvas(cv, frame), c = view.c;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!window.SEQ_TRANSIT) {
      // the timetable file is missing: say so rather than draw nothing
      requestAnimationFrame(function missing() {
        view.fit(); const cs = getComputedStyle(document.documentElement);
        c.fillStyle = cs.getPropertyValue('--bg'); c.fillRect(0, 0, view.W, view.H);
        c.fillStyle = cs.getPropertyValue('--dim'); c.font = '600 13px ' + (cs.getPropertyValue('--font-label') || 'sans-serif');
        c.fillText('NO TIMETABLE (LIB/SEQ-TRANSIT.JS)', 28, 60);
      });
      return;
    }
    if (!net) net = unpack(window.SEQ_TRANSIT);

    // today's line (by Brisbane date, so every screen agrees), and the stations and track that make it up
    const today = Math.floor((Date.now() + BNE) / 86400000);
    const [lineName, lineStations] = net.lines[today % net.lines.length];
    const onLine = new Set(lineStations), END = lineStations[0];
    const lineSeg = g => onLine.has(g.a) && onLine.has(g.b) && !g.ferry;
    // a train is on today's line when it runs to the line's far end and is on the line's track now
    const runsToEnd = new Map();
    const ofLine = veh => { let r = runsToEnd.get(veh.pat); if (r === undefined) runsToEnd.set(veh.pat, r = veh.pat[1].includes(END)); return r && lineSeg(veh.g); };
    const CENTRAL = net.st.findIndex(s => s[0] === 'Central');

    let mode = 'moving';
    try { if (localStorage.getItem(SAVE_KEY) === 'now') mode = 'now'; } catch (e) {}
    let sim = Date.now(), lastT = 0;            // the moving clock (Brisbane time, ms); starts now
    let proj = null, projFor = '';              // the map projection, worked out again when the canvas changes size
    const webCanvas = document.createElement('canvas'); let webFor = '';   // the bus web, drawn once and reused

    // fit the line of the day (and Central) into the map area, at least 16 km tall so the city reads
    function project(W, H) {
      const pts = lineStations.concat(CENTRAL).map(i => net.st[i]);
      let x0 = Math.min(...pts.map(p => p[1])), x1 = Math.max(...pts.map(p => p[1]));
      let y0 = Math.min(...pts.map(p => p[2])), y1 = Math.max(...pts.map(p => p[2]));
      const cos = Math.cos((y0 + y1) / 2 * Math.PI / 180), MIN = 0.145;
      if (y1 - y0 < MIN) { const m = (y0 + y1) / 2; y0 = m - MIN / 2; y1 = m + MIN / 2; }
      const box = { l: 24, r: W * 0.62, t: 52, b: H - 40 };
      const k = Math.min((box.r - box.l) / ((x1 - x0) * cos), (box.b - box.t) / (y1 - y0));
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, cx = (box.l + box.r) / 2, cy = (box.t + box.b) / 2;
      return { box, xy: (lon, lat) => [cx + (lon - mx) * cos * k, cy - (lat - my) * k] };
    }

    function frame(t) {
      if (!cv.isConnected) return;
      view.fit(); const W = view.W, H = view.H;
      if (projFor !== W + 'x' + H) { proj = project(W, H); projFor = W + 'x' + H; }
      const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0; lastT = t;
      // moving: the clock runs fast from now, and comes back to now after a day
      if (mode === 'moving' && !still) { sim += dt * FAST * 1000; if (sim > Date.now() + 86400000) sim = Date.now(); }
      const ms = mode === 'now' ? Date.now() : sim;

      const cs = getComputedStyle(document.documentElement), v = k => cs.getPropertyValue(k).trim();
      const INK = v('--ink'), D = v('--line2'), L = v('--line'), G = v('--grid') || L, BG = v('--bg'), DIM = v('--dim') || D;
      const LABEL = v('--font-label') || 'sans-serif';
      const rgb = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(BG), dark = !rgb || (parseInt(rgb[1], 16) + parseInt(rgb[2], 16) + parseInt(rgb[3], 16)) < 384;
      const COL = COLOURS[dark ? 'dark' : 'light'];
      const text = (s, x, y, col, size, weight = 600, stretch = 'condensed') => { c.fillStyle = col; c.font = weight + ' ' + size + 'px ' + LABEL; c.fontStretch = stretch; c.fillText(s, x, y); };
      const { box, xy } = proj;
      const route = (ctx, pts) => { ctx.beginPath(); pts.forEach(([lon, lat], i) => { const [x, y] = xy(lon, lat); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); };

      // grid paper
      c.fillStyle = BG; c.fillRect(0, 0, W, H);
      c.fillStyle = G; for (let x = 0; x <= W; x += 20) c.fillRect(x, 0, 1, H); for (let y = 0; y <= H; y += 20) c.fillRect(0, y, W, 1);
      c.fillStyle = L; for (let x = 0; x <= W; x += 100) c.fillRect(x, 0, 1, H); for (let y = 0; y <= H; y += 100) c.fillRect(0, y, W, 1);

      // the bus web: hundreds of routes, so drawn once onto its own canvas, again only for a new size or theme
      const webKey = cv.width + 'x' + cv.height + projFor + COL.bus;
      if (webFor !== webKey) {
        webFor = webKey; webCanvas.width = cv.width; webCanvas.height = cv.height;
        const w = webCanvas.getContext('2d'); w.setTransform(cv.width / W, 0, 0, cv.height / H, 0, 0);
        w.beginPath(); w.rect(0, 0, box.r + 16, H); w.clip();
        w.strokeStyle = COL.bus; w.globalAlpha = 0.11; w.lineWidth = 0.6; w.lineJoin = 'round';
        for (const p of net.paths) route(w, p.pts);
      }
      c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(webCanvas, 0, 0); c.restore();

      // the map, kept to its own area so lines running off it stop short of the panel
      c.save(); c.beginPath(); c.rect(0, 0, box.r + 16, H); c.clip();
      c.lineCap = 'round'; c.lineJoin = 'round';
      // ferry routes dashed, the rail network fine, then today's line heavy on top
      c.strokeStyle = COL.ferry; c.globalAlpha = 0.7; c.lineWidth = 1; c.setLineDash([2, 4]);
      for (const g of net.seg.values()) if (g.ferry) route(c, g.pts);
      c.setLineDash([]); c.globalAlpha = 1; c.strokeStyle = D; c.lineWidth = 1.5;
      for (const g of net.seg.values()) if (!g.ferry && !lineSeg(g)) route(c, g.pts);
      c.strokeStyle = INK; c.lineWidth = 2.6;
      for (const g of net.seg.values()) if (lineSeg(g)) route(c, g.pts);
      for (const i of lineStations) { const [x, y] = xy(net.st[i][1], net.st[i][2]); c.beginPath(); c.arc(x, y, 2.6, 0, 6.2832); c.fillStyle = BG; c.fill(); c.strokeStyle = INK; c.lineWidth = 1.2; c.stroke(); }

      // the vehicles: buses first (there are most of them), then ferries and trains on top
      const all = vehicles(ms), count = { train: 0, bus: 0, ferry: 0 };
      let mine = 0;
      for (const kind of ['bus', 'ferry', 'train']) {
        const col = COL[kind], r = kind === 'bus' ? 1.7 : 3;
        for (const veh of all) {
          if (veh.kind !== kind) continue;
          count[kind]++;
          const [x, y] = xy(...veh.at), [wx, wy] = xy(...veh.was);
          // the trail: a fading line back to where it was
          if (Math.abs(x - wx) + Math.abs(y - wy) > 0.5) {
            const grad = c.createLinearGradient(wx, wy, x, y); grad.addColorStop(0, col + '00'); grad.addColorStop(1, col + 'cc');
            c.beginPath(); c.moveTo(wx, wy); c.lineTo(x, y); c.strokeStyle = grad; c.lineWidth = r * 0.9; c.stroke();
          }
          c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fillStyle = col; c.fill();
          if (kind === 'train' && ofLine(veh)) { mine++; c.beginPath(); c.arc(x, y, 6.5, 0, 6.2832); c.strokeStyle = INK; c.lineWidth = 1.2; c.stroke(); }
        }
      }
      // the far end of today's line, named on a plate so the track doesn't run through it
      {
        const [x, y] = xy(net.st[END][1], net.st[END][2]), name = net.st[END][0].toUpperCase();
        c.font = '600 12px ' + LABEL; c.fontStretch = 'condensed';
        const w = c.measureText(name).width, lx = Math.min(box.r - w, x + 8);
        c.fillStyle = BG; c.fillRect(lx - 3, y - 18, w + 6, 15); text(name, lx, y - 6, INK, 12);
      }
      c.restore();

      // the panel: everything running, a key with each kind's count, today's line, the time, the credit
      const px = W * 0.66, pw = W * 0.3;
      const clock = new Date(ms + BNE), hh = clock.getUTCHours(), mm = clock.getUTCMinutes();
      const time = (hh % 12 || 12) + ':' + String(mm).padStart(2, '0') + (hh < 12 ? ' AM' : ' PM');
      c.fillStyle = BG; c.fillRect(20, 12, 150, 24); text('BRISBANE TRANSIT', 28, 28, INK, 14);
      text(String(count.train + count.bus + count.ferry), px, 82, INK, 46, 800, 'expanded');
      text('ON THE MOVE · ' + time + (mode === 'moving' ? ' (×' + FAST + ')' : ''), px, 102, DIM, 12);
      c.fillStyle = INK; c.fillRect(px, 118, pw, 1.5);
      [['TRAINS', 'train'], ['BUSES', 'bus'], ['FERRIES', 'ferry']].forEach(([label, kind], n) => {
        const y = 142 + n * 22;
        c.beginPath(); c.arc(px + 5, y - 4, 4, 0, 6.2832); c.fillStyle = COL[kind]; c.fill();
        text(label, px + 16, y, INK, 13);
        c.textAlign = 'right'; text(String(count[kind]), px + pw, y, INK, 13); c.textAlign = 'left';
      });
      c.fillStyle = L; c.fillRect(px, 196, pw, 1);
      text('LINE OF THE DAY', px, 218, DIM, 12);
      let size = 22; c.font = '800 ' + size + 'px ' + LABEL; c.fontStretch = 'expanded';
      while (c.measureText(lineName.toUpperCase()).width > pw && size > 12) { size--; c.font = '800 ' + size + 'px ' + LABEL; c.fontStretch = 'expanded'; }
      text(lineName.toUpperCase(), px, 246, INK, size, 800, 'expanded');
      text(mine + (mine === 1 ? ' TRAIN' : ' TRAINS') + ' ON IT (RINGED) · ' + lineStations.length + ' STATIONS', px, 266, DIM, 12);
      text('TIMETABLE DATA: TRANSLINK, CC BY 4.0', px, H - 18, DIM, 10);

      if (!still) requestAnimationFrame(frame);
    }
    // a still picture (reduced motion) is drawn again each minute, so it stays current
    if (still) { const tick = () => { if (cv.isConnected) { requestAnimationFrame(frame); setTimeout(tick, 60000); } }; tick(); }
    else requestAnimationFrame(frame);

    return {
      mode: () => mode,
      setMode(m) {
        mode = m === 'now' ? 'now' : 'moving'; sim = Date.now();
        try { localStorage.setItem(SAVE_KEY, mode); } catch (e) {}
        if (still) requestAnimationFrame(frame);
      },
    };
  }

  (window.VISUALS = window.VISUALS || []).push({
    id: 'transit', name: 'Brisbane transit', draw: transit,
    modes: [['moving', 'Moving'], ['now', 'Real time']],
  });
})();

// Brisbane transit: every train (and ferry) in South East Queensland where the timetable puts it right
// now, on a line drawing of the network in the Scope's style. Each day one line is the "line of the
// day": the map frames it, its track is drawn in ink and its trains in the accent.
// Two modes: now (real time), and the whole of today replayed fast.
// Runs from lib/seq-transit.js, Translink's timetable packed by tools/build-transit.py (no internet
// needed). Times are Brisbane's (UTC+10, no daylight saving) wherever the screen is.
(function () {
  const FAST = 600;                    // the replay: 600 seconds of timetable per second (a day in 2.4 minutes)
  const DAY_STARTS = 4 * 3600;         // the replay runs from 4 am to 4 am, when the trains are quiet
  const BNE = 10 * 3600 * 1000;        // Brisbane is UTC+10 all year
  const SAVE_KEY = 'transit';
  const memory = {
    get() { try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || {}; } catch (e) { return {}; } },
    set(v) { try { localStorage.setItem(SAVE_KEY, JSON.stringify(v)); } catch (e) {} },
  };

  // unpack the timetable once, the first time the visual is drawn
  let net = null;
  function unpack(d) {
    const st = d.stations;
    const seg = new Map();   // "a,b" -> the line between two stations, with running lengths for finding points along it
    for (const [a, b, ferry, p] of d.segments) {
      const pts = []; for (let i = 0; i < p.length; i += 2) pts.push([p[i], p[i + 1]]);
      const cos = Math.cos(pts[0][1] * Math.PI / 180), len = [0];
      for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot((pts[i][0] - pts[i - 1][0]) * cos, pts[i][1] - pts[i - 1][1]));
      seg.set(a + ',' + b, { a, b, ferry: !!ferry, pts, len, total: len[len.length - 1] || 1e-9 });
    }
    // trips, per service: pattern and start time (in quarter minutes, stored as gaps from the trip before)
    const services = d.trips.map(flat => {
      const trips = []; let start = 0;
      for (let i = 0; i < flat.length; i += 2) { start += flat[i + 1]; trips.push([d.patterns[flat[i]], start]); }
      return trips;
    });
    const dayKeys = Object.keys(d.days);
    return { st, seg, services, days: d.days, dayKeys, lines: d.lines };
  }

  // which services run on a Brisbane date (yyyymmdd); a date outside the timetable borrows the first
  // date in it on the same weekday, so an old timetable file still shows a normal day
  const weekday = key => new Date(Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6))).getUTCDay();
  function servicesOn(key) {
    if (net.days[key]) return net.days[key];
    const same = net.dayKeys.find(k => weekday(k) === weekday(key));
    return same ? net.days[same] : [];
  }
  const keyOf = ms => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

  // where a trip is, q quarter minutes after its start: [segment, fraction along it, travelling a->b?] or null
  function place(pattern, q) {
    const [, s, t] = pattern;
    if (q < 0 || q > t[t.length - 1]) return null;
    for (let i = 0; i < s.length - 1; i++) {
      const dep = t[2 * i], arr = t[2 * i + 1], next = i + 2 < s.length ? t[2 * i + 2] : arr;
      if (q <= arr || q <= next) {
        const f = q >= arr ? 1 : q <= dep ? 0 : (q - dep) / (arr - dep);   // stopped at a station counts as the end of the run in
        const a = s[i], b = s[i + 1], fwd = a < b, g = net.seg.get(fwd ? a + ',' + b : b + ',' + a);
        return g ? [g, fwd ? f : 1 - f] : null;
      }
    }
    return null;
  }
  // a point a fraction of the way along a segment, in longitude and latitude
  function along(g, f) {
    const want = f * g.total, L = g.len;
    let i = 1; while (i < L.length - 1 && L[i] < want) i++;
    const k = (want - L[i - 1]) / ((L[i] - L[i - 1]) || 1e-9), p = g.pts[i - 1], q = g.pts[i];
    return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k];
  }

  // every vehicle running at a Brisbane time (ms): today's trips, and last night's that run past midnight
  function vehicles(ms) {
    const local = ms + BNE, key = keyOf(local), sod = (local % 86400000) / 1000;
    const out = [];
    for (const [k, extra] of [[key, 0], [keyOf(local - 86400000), 86400]]) {
      const q = (sod + extra) / 15;
      for (const svc of servicesOn(k)) for (const [pat, start] of net.services[svc]) {
        if (start > q) break;                      // trips are in start order
        const at = place(pat, q - start);
        if (at) out.push({ ferry: pat[0] === 1, g: at[0], f: at[1], pat });
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
    const onLine = new Set(lineStations);
    const lineSeg = g => onLine.has(g.a) && onLine.has(g.b) && !g.ferry;
    // a train is on today's line when it runs to the line's far end and is on the line's track now
    // (so a train sharing the city tracks but bound elsewhere isn't counted)
    const END = lineStations[0], runsToEnd = new Map();
    const ofLine = veh => { let r = runsToEnd.get(veh.pat); if (r === undefined) runsToEnd.set(veh.pat, r = veh.pat[1].includes(END)); return r && lineSeg(veh.g); };
    const CENTRAL = net.st.findIndex(s => s[0] === 'Central');

    let mode = memory.get().mode === 'fast' ? 'fast' : 'now';
    let replay = 0, lastT = 0;      // the replay clock, in seconds after 4 am today
    let proj = null, projFor = '';  // the map projection, worked out again when the canvas changes size

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
      // the time shown: now, or the replay clock running through today from 4 am
      const midnight = Math.floor((Date.now() + BNE) / 86400000) * 86400000 - BNE;
      if (mode === 'fast' && !still) replay = (replay + dt * FAST) % 86400;
      const ms = mode === 'now' ? Date.now() : midnight + (DAY_STARTS + replay) * 1000;

      const cs = getComputedStyle(document.documentElement), v = k => cs.getPropertyValue(k).trim();
      const INK = v('--ink'), D = v('--line2'), L = v('--line'), G = v('--grid') || L, A = v('--accent'), BG = v('--bg'), DIM = v('--dim') || D;
      const LABEL = v('--font-label') || 'sans-serif';
      const text = (s, x, y, col, size, weight = 600, stretch = 'condensed') => { c.fillStyle = col; c.font = weight + ' ' + size + 'px ' + LABEL; c.fontStretch = stretch; c.fillText(s, x, y); };
      const { box, xy } = proj;

      // grid paper
      c.fillStyle = BG; c.fillRect(0, 0, W, H);
      c.fillStyle = G; for (let x = 0; x <= W; x += 20) c.fillRect(x, 0, 1, H); for (let y = 0; y <= H; y += 20) c.fillRect(0, y, W, 1);
      c.fillStyle = L; for (let x = 0; x <= W; x += 100) c.fillRect(x, 0, 1, H); for (let y = 0; y <= H; y += 100) c.fillRect(0, y, W, 1);

      // the map, kept to its own area so lines running off it stop short of the panel
      c.save(); c.beginPath(); c.rect(0, 0, box.r + 16, H); c.clip();
      const stroke = g => { c.beginPath(); g.pts.forEach(([lon, lat], i) => { const [x, y] = xy(lon, lat); i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.stroke(); };
      // ferry routes dashed, the rest of the network fine, then today's line heavy on top
      c.lineCap = 'round'; c.lineJoin = 'round';
      c.strokeStyle = D; c.lineWidth = 1; c.setLineDash([2, 4]);
      for (const g of net.seg.values()) if (g.ferry) stroke(g);
      c.setLineDash([]); c.lineWidth = 1.2;
      for (const g of net.seg.values()) if (!g.ferry && !lineSeg(g)) stroke(g);
      c.strokeStyle = INK; c.lineWidth = 2.6;
      for (const g of net.seg.values()) if (lineSeg(g)) stroke(g);
      // today's stations as small rings on the line
      for (const i of lineStations) { const [x, y] = xy(net.st[i][1], net.st[i][2]); c.beginPath(); c.arc(x, y, 2.6, 0, 6.2832); c.fillStyle = BG; c.fill(); c.strokeStyle = INK; c.lineWidth = 1.2; c.stroke(); }

      // the vehicles: ferries hollow, trains solid, today's line's trains in the accent
      const all = vehicles(ms);
      let trains = 0, ferries = 0, mine = 0;
      for (const veh of all) {
        const [x, y] = xy(...along(veh.g, veh.f));
        if (veh.ferry) { ferries++; c.beginPath(); c.arc(x, y, 2.4, 0, 6.2832); c.fillStyle = BG; c.fill(); c.strokeStyle = INK; c.lineWidth = 1; c.stroke(); continue; }
        trains++;
        const hot = ofLine(veh); if (hot) mine++;
        c.beginPath(); c.arc(x, y, hot ? 4 : 3, 0, 6.2832); c.fillStyle = hot ? A : INK; c.fill();
        if (hot) { c.beginPath(); c.arc(x, y, 7, 0, 6.2832); c.strokeStyle = A; c.lineWidth = 1; c.stroke(); }
      }
      // names at the two ends of today's line, on plates so the track doesn't run through them
      for (const i of [lineStations[0], CENTRAL]) {
        const [x, y] = xy(net.st[i][1], net.st[i][2]), name = net.st[i][0].toUpperCase();
        c.font = '600 12px ' + LABEL; c.fontStretch = 'condensed';
        const w = c.measureText(name).width, lx = Math.min(box.r - w, x + 8);
        c.fillStyle = BG; c.fillRect(lx - 3, y - 18, w + 6, 15); text(name, lx, y - 6, INK, 12);
      }
      c.restore();

      // the panel: trains running, today's line, ferries, the time, and the credit
      const px = W * 0.66, pw = W * 0.3;
      const clock = new Date(ms + BNE), hh = clock.getUTCHours(), mm = clock.getUTCMinutes();
      const time = (hh % 12 || 12) + ':' + String(mm).padStart(2, '0') + (hh < 12 ? ' AM' : ' PM');
      c.fillStyle = BG; c.fillRect(20, 12, 150, 24); text('BRISBANE TRANSIT', 28, 28, INK, 14);
      text(String(trains), px, 82, INK, 46, 800, 'expanded');
      text('TRAINS RUNNING · ' + time + (mode === 'fast' ? ' (REPLAY)' : ''), px, 102, DIM, 12);
      c.fillStyle = INK; c.fillRect(px, 118, pw, 1.5);
      text('LINE OF THE DAY', px, 142, DIM, 12);
      let size = 22; c.font = '800 ' + size + 'px ' + LABEL; c.fontStretch = 'expanded';
      while (c.measureText(lineName.toUpperCase()).width > pw && size > 12) { size--; c.font = '800 ' + size + 'px ' + LABEL; c.fontStretch = 'expanded'; }
      text(lineName.toUpperCase(), px, 170, A, size, 800, 'expanded');
      text(mine + (mine === 1 ? ' TRAIN' : ' TRAINS') + ' ON IT · ' + lineStations.length + ' STATIONS', px, 192, INK, 13);
      c.fillStyle = L; c.fillRect(px, 204, pw, 1);
      text(ferries + (ferries === 1 ? ' FERRY' : ' FERRIES') + ' ON THE WATER', px, 226, INK, 13);
      text('TIMETABLE DATA: TRANSLINK, CC BY 4.0', px, H - 18, DIM, 10);

      if (!still) requestAnimationFrame(frame);
    }
    // a still picture (reduced motion) is drawn again each minute, so it stays current
    if (still) { const tick = () => { if (cv.isConnected) { requestAnimationFrame(frame); setTimeout(tick, 60000); } }; tick(); }
    else requestAnimationFrame(frame);

    return {
      mode: () => mode,
      setMode(m) { mode = m === 'fast' ? 'fast' : 'now'; memory.set({ mode }); if (still) requestAnimationFrame(frame); },
    };
  }

  (window.VISUALS = window.VISUALS || []).push({
    id: 'transit', name: 'Brisbane transit', draw: transit,
    modes: [['now', 'Now'], ['fast', 'Today, fast']],
  });
})();

/* ======================================================================
   Weather Detector dashboard
   - Polls history.php once per second (never overlapping requests).
   - Draws the chart on a <canvas> by hand: no libraries, no CDN.
   - All times are shown in Asia/Manila regardless of the viewer's clock.
   ====================================================================== */
(() => {
  'use strict';

  // ---- Settings -------------------------------------------------------
  const CONFIG = {
    endpoint: 'history.php',   // relative, so it follows wherever the page is served from
    fetchLimit: 300,           // rows requested per refresh
    refreshMs: 1000,           // poll interval
    timeoutMs: 4000,           // give up on one request after this long
    staleAfterS: 10,           // "Arduino offline" warning threshold
    tableRows: 10,
    status: {
      minReadings: 12,         // need at least this many previous readings
      maxReadings: 60,         // average over up to this many previous readings
      thresholdC: 2            // +/- degrees from the average that counts as not normal
    },
    timeZone: 'Asia/Manila'
  };

  const METRICS = {
    temperatureC: { label: 'Temperature', unit: '°C',  decimals: 1 },
    humidityPct:  { label: 'Humidity',    unit: '%',   decimals: 1 },
    pressureHpa:  { label: 'Pressure',    unit: 'hPa', decimals: 1 },
    altitudeM:    { label: 'Altitude',    unit: 'm',   decimals: 1 },
    rainRaw:      { label: 'Rain (raw)',  unit: '',    decimals: 0 },
    gasRaw:       { label: 'Gas (raw)',   unit: '',    decimals: 0 }
  };

  // ---- State ----------------------------------------------------------
  const state = {
    rows: [],            // oldest -> newest, each row gets a numeric .t (ms since epoch)
    serverEpoch: null,   // server clock (seconds) from the last good response
    metric: 'temperatureC',
    windowPoints: 120,
    hoverIndex: null,    // index inside the visible window, or null
    inFlight: false
  };

  const $ = (id) => document.getElementById(id);

  // ---- Formatting helpers --------------------------------------------
  const dateTimeFmt = new Intl.DateTimeFormat('en-PH', {
    timeZone: CONFIG.timeZone,
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  });
  const clockFmt = new Intl.DateTimeFormat('en-PH', {
    timeZone: CONFIG.timeZone,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  });

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const fmt = (v, d) => (isNum(v) ? v.toFixed(d) : '—');

  // ---- Fetching -------------------------------------------------------
  function historyUrl() {
    return new URL(CONFIG.endpoint + '?limit=' + CONFIG.fetchLimit, window.location.href).href;
  }

  async function fetchHistory() {
    if (state.inFlight) return;            // previous request still running
    state.inFlight = true;

    const shownUrl = historyUrl();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONFIG.timeoutMs);

    try {
      // The extra _ parameter defeats any proxy/browser caching.
      const res = await fetch(shownUrl + '&_=' + Date.now(), { cache: 'no-store', signal: ctrl.signal });
      const text = await res.text();

      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw new Error('HTTP ' + res.status + ': the server did not return JSON. Response began with: "' +
                        text.slice(0, 120).replace(/\s+/g, ' ') + '"');
      }
      if (!res.ok || !json.success) {
        throw new Error('HTTP ' + res.status + ': ' + (json.error || 'unknown server error') +
                        (json.debug ? ' (' + json.debug + ')' : ''));
      }
      if (!Array.isArray(json.data)) {
        throw new Error('The response has no "data" list.');
      }

      state.rows = json.data.map((r) => Object.assign({}, r, { t: Date.parse(r.recordedAt) }));
      state.serverEpoch = isNum(json.serverEpoch) ? json.serverEpoch : Date.now() / 1000;

      hideError();
      render();
    } catch (err) {
      const msg = err.name === 'AbortError'
        ? 'The request timed out after ' + (CONFIG.timeoutMs / 1000) + ' seconds.'
        : (err instanceof TypeError ? 'Could not reach the server (' + err.message + ').' : err.message);
      showError(msg, shownUrl);
    } finally {
      clearTimeout(timer);
      state.inFlight = false;
    }
  }

  // ---- Error / connection UI -----------------------------------------
  function setConn(kind, text) {
    $('conn').dataset.state = kind;
    $('connText').textContent = text;
  }

  function showError(message, url) {
    $('errMsg').textContent = message;
    $('errUrl').textContent = url;
    $('errorBox').hidden = false;
    $('staleBox').hidden = true;
    setConn('error', 'Disconnected');
  }

  function hideError() {
    $('errorBox').hidden = true;
  }

  // ---- Rendering ------------------------------------------------------
  function render() {
    const rows = state.rows;
    const latest = rows.length ? rows[rows.length - 1] : null;

    updateLatest(latest);
    updateStale(latest);
    updateStatus(rows);
    updateChart();
    updateTable(rows);
  }

  function updateLatest(latest) {
    const bmp = latest && latest.bmp180Available;
    $('vTemp').textContent = latest ? fmt(latest.temperatureC, 1) : '—';
    $('vHum').textContent  = latest ? fmt(latest.humidityPct, 1) : '—';
    $('vPres').textContent = bmp ? fmt(latest.pressureHpa, 1) : 'n/a';
    $('vAlt').textContent  = bmp ? fmt(latest.altitudeM, 1) : 'n/a';
    $('vRain').textContent = latest ? String(latest.rainRaw) : '—';
    $('vGas').textContent  = latest ? String(latest.gasRaw) : '—';
  }

  function updateStale(latest) {
    const box = $('staleBox');

    if (!latest) {
      box.hidden = false;
      $('staleMsg').textContent =
        'The database has no readings yet. Power the Arduino, check that it joined the hotspot, and watch its Serial Monitor for "POST ok".';
      setConn('stale', 'Connected, no data yet');
      return;
    }

    // Compare against the SERVER's clock so a wrong phone/PC clock can't cause false alarms.
    const ageS = Math.max(0, Math.round(state.serverEpoch - latest.t / 1000));
    if (ageS > CONFIG.staleAfterS) {
      box.hidden = false;
      $('staleMsg').textContent =
        'The newest reading is ' + formatAge(ageS) + ' old (' + dateTimeFmt.format(latest.t) +
        '). The Arduino may be off, out of hotspot range, or unable to reach the PC.';
      setConn('stale', 'Connected, Arduino quiet');
    } else {
      box.hidden = true;
      setConn('ok', 'Live · updated ' + clockFmt.format(latest.t));
    }
  }

  function formatAge(s) {
    if (s < 60) return s + ' s';
    if (s < 3600) return Math.floor(s / 60) + ' min ' + (s % 60) + ' s';
    return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min';
  }

  // ---- Temperature status panel --------------------------------------
  function computeStatus(rows) {
    const n = rows.length;
    if (n === 0) return { kind: 'wait', used: 0 };

    const latest = rows[n - 1];
    // up to 60 readings BEFORE the latest one
    const previous = rows.slice(Math.max(0, n - 1 - CONFIG.status.maxReadings), n - 1)
                         .map((r) => r.temperatureC)
                         .filter(isNum);

    if (!isNum(latest.temperatureC) || previous.length < CONFIG.status.minReadings) {
      return { kind: 'wait', used: previous.length, current: latest.temperatureC };
    }

    const avg = previous.reduce((a, b) => a + b, 0) / previous.length;
    const diff = latest.temperatureC - avg;
    const kind = diff > CONFIG.status.thresholdC ? 'above'
               : diff < -CONFIG.status.thresholdC ? 'below'
               : 'normal';
    return { kind, used: previous.length, current: latest.temperatureC, avg, diff };
  }

  function updateStatus(rows) {
    const s = computeStatus(rows);
    const words = {
      above: 'ABOVE NORMAL',
      below: 'BELOW NORMAL',
      normal: 'NORMAL',
      wait: 'COLLECTING DATA'
    };
    const notes = {
      above: 'The temperature is more than ' + CONFIG.status.thresholdC + ' °C above the recent average.',
      below: 'The temperature is more than ' + CONFIG.status.thresholdC + ' °C below the recent average.',
      normal: 'The temperature is within ' + CONFIG.status.thresholdC + ' °C of the recent average.',
      wait: 'Needs ' + CONFIG.status.minReadings + ' earlier readings to compare (' + s.used + ' so far).'
    };

    $('statusPanel').dataset.kind = s.kind;
    $('statusWord').textContent = words[s.kind];
    $('statusNote').textContent = notes[s.kind];
    $('stCurrent').textContent = fmt(s.current, 1);
    $('stAvg').textContent = fmt(s.avg, 2);
    $('stDiff').textContent = isNum(s.diff) ? (s.diff > 0 ? '+' : '') + s.diff.toFixed(2) : '—';
    $('stCount').textContent = String(s.used);
  }

  // ---- Table ----------------------------------------------------------
  function updateTable(rows) {
    const body = $('tableBody');
    body.textContent = '';

    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.className = 'muted';
      td.textContent = 'No readings yet.';
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }

    const recent = rows.slice(-CONFIG.tableRows).reverse();   // newest first
    for (const r of recent) {
      const bmp = r.bmp180Available;
      const cells = [
        [dateTimeFmt.format(r.t), false],
        [fmt(r.temperatureC, 1), true],
        [fmt(r.humidityPct, 1), true],
        [bmp ? fmt(r.pressureHpa, 1) : 'n/a', true],
        [bmp ? fmt(r.altitudeM, 1) : 'n/a', true],
        [String(r.rainRaw), true],
        [String(r.gasRaw), true]
      ];
      const tr = document.createElement('tr');
      for (const [text, numeric] of cells) {
        const td = document.createElement('td');
        if (numeric) td.className = 'num';
        td.textContent = text;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  }

  // ---- Chart ----------------------------------------------------------
  function visiblePoints() {
    return state.rows.slice(-state.windowPoints);
  }

  function updateChart() {
    const m = METRICS[state.metric];
    const pts = visiblePoints();
    $('chartHeading').textContent = 'History chart: ' + m.label + (m.unit ? ' (' + m.unit + ')' : '');
    $('chartCaption').textContent = pts.length
      ? 'Showing the last ' + pts.length + ' readings. Touch or hover the chart to read a value.'
      : 'No readings to plot yet.';
    drawChart();
  }

  function drawChart() {
    const canvas = $('chart');
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(220, Math.floor(rect.width));
    const h = Math.max(160, Math.floor(rect.height));

    // Match the backing store to the display size so lines stay sharp on phones.
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const css = getComputedStyle(document.documentElement);
    const col = (name) => css.getPropertyValue(name).trim();
    const cInk = col('--ink'), cMuted = col('--ink-muted'), cLine = col('--line');
    const cAccent = col('--accent'), cSurface = col('--surface-2');

    const m = METRICS[state.metric];
    const pts = visiblePoints();
    const vals = pts.map((r) => r[state.metric]);
    const valid = vals.filter(isNum);

    ctx.font = '12px ' + getComputedStyle(document.body).fontFamily;

    if (!valid.length) {
      ctx.fillStyle = cMuted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pts.length ? 'No data for this sensor (BMP180 not detected?)' : 'Waiting for readings…', w / 2, h / 2);
      return;
    }

    // Y range with a little breathing room
    let min = Math.min(...valid);
    let max = Math.max(...valid);
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.08;
    min -= pad; max += pad;

    const L = 58, R = 14, T = 12, B = 28;
    const pw = w - L - R;
    const ph = h - T - B;
    const xAt = (i) => L + (pts.length === 1 ? pw / 2 : (i / (pts.length - 1)) * pw);
    const yAt = (v) => T + (1 - (v - min) / (max - min)) * ph;
    const dec = m.decimals === 0 ? 0 : ((max - min) < 2 ? 2 : m.decimals);

    // Grid + Y labels
    ctx.lineWidth = 1;
    ctx.strokeStyle = cLine;
    ctx.fillStyle = cMuted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let k = 0; k <= 4; k++) {
      const y = Math.round(T + (ph * k) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(L, y);
      ctx.lineTo(w - R, y);
      ctx.stroke();
      ctx.fillText((max - ((max - min) * k) / 4).toFixed(dec), L - 8, y);
    }

    // X labels: first, middle, last
    ctx.textBaseline = 'top';
    const labelIdx = pts.length > 2 ? [0, Math.floor((pts.length - 1) / 2), pts.length - 1] : pts.map((_, i) => i);
    labelIdx.forEach((i, n) => {
      ctx.textAlign = n === 0 ? 'left' : (n === labelIdx.length - 1 ? 'right' : 'center');
      ctx.fillText(clockFmt.format(pts[i].t), xAt(i), h - B + 8);
    });

    // Data line (gaps where a value is null)
    ctx.strokeStyle = cAccent;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let penDown = false;
    vals.forEach((v, i) => {
      if (!isNum(v)) { penDown = false; return; }
      const x = xAt(i), y = yAt(v);
      if (!penDown) { ctx.moveTo(x, y); penDown = true; } else { ctx.lineTo(x, y); }
    });
    ctx.stroke();

    // Marker on the newest valid point
    for (let i = vals.length - 1; i >= 0; i--) {
      if (isNum(vals[i])) {
        ctx.fillStyle = cAccent;
        ctx.beginPath();
        ctx.arc(xAt(i), yAt(vals[i]), 4, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
    }

    // Hover / touch read-out
    const hi = state.hoverIndex;
    if (hi !== null && hi >= 0 && hi < pts.length && isNum(vals[hi])) {
      const x = xAt(hi), y = yAt(vals[hi]);

      ctx.strokeStyle = cMuted;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, T);
      ctx.lineTo(x, T + ph);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = cAccent;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();

      const line1 = fmt(vals[hi], m.decimals) + (m.unit ? ' ' + m.unit : '');
      const line2 = clockFmt.format(pts[hi].t);
      ctx.font = '600 13px ' + getComputedStyle(document.body).fontFamily;
      const bw = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + 16;
      const bh = 40;
      let bx = x + 10;
      if (bx + bw > w - 4) bx = x - 10 - bw;
      let by = Math.min(Math.max(y - bh / 2, T), T + ph - bh);

      ctx.fillStyle = cSurface;
      ctx.strokeStyle = cLine;
      ctx.beginPath();
      ctx.rect(bx, by, bw, bh);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = cInk;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(line1, bx + 8, by + 5);
      ctx.font = '12px ' + getComputedStyle(document.body).fontFamily;
      ctx.fillStyle = cMuted;
      ctx.fillText(line2, bx + 8, by + 22);
    }
  }

  function setHoverFromEvent(ev) {
    const pts = visiblePoints();
    if (!pts.length) return;
    const rect = $('chart').getBoundingClientRect();
    const L = 58, R = 14;
    const pw = rect.width - L - R;
    const frac = (ev.clientX - rect.left - L) / pw;
    const idx = Math.round(frac * (pts.length - 1));
    state.hoverIndex = Math.min(Math.max(idx, 0), pts.length - 1);
    drawChart();
  }

  // ---- Wiring ---------------------------------------------------------
  function init() {
    $('metricSelect').addEventListener('change', (e) => {
      state.metric = e.target.value;
      state.hoverIndex = null;
      updateChart();
    });
    $('windowSelect').addEventListener('change', (e) => {
      state.windowPoints = parseInt(e.target.value, 10);
      state.hoverIndex = null;
      updateChart();
    });

    const canvas = $('chart');
    canvas.addEventListener('pointermove', setHoverFromEvent);
    canvas.addEventListener('pointerdown', setHoverFromEvent);
    canvas.addEventListener('pointerleave', () => { state.hoverIndex = null; drawChart(); });

    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => drawChart()).observe(canvas);
    } else {
      window.addEventListener('resize', drawChart);
    }

    fetchHistory();
    setInterval(fetchHistory, CONFIG.refreshMs);
  }

  init();
})();

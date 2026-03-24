import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

import { parseGPX } from './gpx.js';
import { buildStatsProfile, calcStats, statsAtProgress } from './stats.js';
import { createMap, renderTrack, toggleMapStyle } from './map.js';
import { drawElevation, updatePlayhead } from './elevation.js';
import { showHUD, updateHUD, showLoader, hideLoader, hideDropOverlay } from './ui.js';
import { Flyover } from './flyover.js';

/** Quintic smoothstep — matches flyover intro/outro feel. */
function smoothCamEasing(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// ── Init map immediately (sits behind the drop overlay)
const map = createMap('map');

/** Currently active Flyover instance (null when no track loaded). */
let flyover = null;
// 保存播放前的视角参数
let initialView = null;

/** Active track coords (needed for re-fitting after flyover ends). */
let activeCoords = null;

/** Active cumulative HUD stats profile for the loaded track. */
let activeStatsProfile = null;

/** Full stats shown when the route is idle at the start/end states. */
let fullStats = null;

let recordModeEnabled = false;
let pendingCountdown = null;
const RECORD_MODE_LABEL = '录屏';

// ── Player UI helpers ─────────────────────────────────
const playBtn    = /** @type {HTMLButtonElement} */ (document.getElementById('play-btn'));
const playerEl   = /** @type {HTMLElement}       */ (document.getElementById('player'));
const followBtn  = /** @type {HTMLButtonElement} */ (document.getElementById('follow-btn'));
const mapStyleBtn = /** @type {HTMLButtonElement} */ (document.getElementById('map-style-btn'));
const recordModeBtn = /** @type {HTMLButtonElement} */ (document.getElementById('record-mode-btn'));
const speedBtns  = /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('.speed-btn'));

function setPlayIcon(isPlaying) {
  playBtn.innerHTML = isPlaying
    ? '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><rect x="5" y="4" width="4" height="16" rx="1"/><rect x="15" y="4" width="4" height="16" rx="1"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><polygon points="6,3 20,12 6,21"/></svg>';
}

function clearRecordingCountdown() {
  if (pendingCountdown) {
    clearInterval(pendingCountdown.intervalId);
    clearTimeout(pendingCountdown.timeoutId);
    pendingCountdown = null;
  }
  playBtn.classList.remove('armed');
  if (recordModeBtn) {
    recordModeBtn.classList.remove('pending', 'counting');
    recordModeBtn.textContent = RECORD_MODE_LABEL;
  }
}

function startPlayback() {
  if (!flyover) return;
  // 记录播放前的视角参数
  const center = map.getCenter();
  initialView = {
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };
  flyover.play();
  setPlayIcon(true);
}

function beginRecordingCountdown() {
  clearRecordingCountdown();
  let remaining = 3;
  playBtn.classList.add('armed');
  if (recordModeBtn) {
    recordModeBtn.classList.add('pending', 'counting');
    recordModeBtn.textContent = String(remaining);
  }

  const intervalId = setInterval(() => {
    remaining -= 1;
    if (remaining > 0 && recordModeBtn) recordModeBtn.textContent = String(remaining);
  }, 1000);

  const timeoutId = setTimeout(() => {
    clearRecordingCountdown();
    startPlayback();
  }, 3000);

  pendingCountdown = { intervalId, timeoutId };
}

setPlayIcon(false);

playBtn?.addEventListener('click', () => {
  if (!flyover) return;
  if (pendingCountdown) {
    clearRecordingCountdown();
    setPlayIcon(false);
    return;
  }
  if (flyover.playing) {
    flyover.pause();
    setPlayIcon(false);
  } else {
    if (recordModeEnabled) beginRecordingCountdown();
    else startPlayback();
  }
});

recordModeBtn?.addEventListener('click', () => {
  recordModeEnabled = !recordModeEnabled;
  recordModeBtn.classList.toggle('active', recordModeEnabled);
  if (!recordModeEnabled) clearRecordingCountdown();
  if (!pendingCountdown) recordModeBtn.textContent = RECORD_MODE_LABEL;
});

followBtn?.addEventListener('click', () => {
  const on = followBtn.classList.toggle('active');
  if (flyover) {
    flyover.followCam = on;
    if (on) flyover.snapToFollow();
  }
});

mapStyleBtn?.addEventListener('click', () => {
  const next = toggleMapStyle(map);
  mapStyleBtn.textContent = next === 'outdoor' ? '🛰 卫星' : '🏔 户外';
  // When switching to satellite, satellite tiles at playback zoom may not be
  // cached yet. Trigger a preload immediately so first playback is smooth.
  if (next === 'satellite') preloadPlaybackTiles();
});

// When the user manually drags the map, turn off follow-cam so playback
// keeps the current view instead of snapping back to the track position.
map.on('dragend', () => {
  if (followBtn?.classList.contains('active')) {
    followBtn.classList.remove('active');
    if (flyover) flyover.followCam = false;
  }
});

speedBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    speedBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    flyover?.setSpeed(parseFloat(btn.dataset.speed));
  });
});

// Space bar → toggle play/pause
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && flyover) {
    e.preventDefault();
    playBtn?.click();
  }
});

// Flyover progress → update elevation playhead
window.addEventListener('flyover:progress', (e) => {
  const progress = /** @type {CustomEvent} */ (e).detail.progress;
  updatePlayhead(progress);
  if (activeStatsProfile) updateHUD(statsAtProgress(activeStatsProfile, progress));
});

// Flyover finished → reset icon, optionally fly back to full track overview
window.addEventListener('flyover:ended', (e) => {
  clearRecordingCountdown();
  setPlayIcon(false);
  if (fullStats) updateHUD(fullStats);
  const restoredView = /** @type {CustomEvent} */ (e).detail?.restoredView;
  if (restoredView) return;
  // 优先用 initialView 平滑复位
  if (initialView) {
    map.easeTo({
      center: initialView.center,
      zoom: initialView.zoom,
      pitch: initialView.pitch,
      bearing: initialView.bearing,
      offset: [0, 0],
      duration: 2000,
      easing: smoothCamEasing,
    });
    initialView = null;
    return;
  }
  // fallback: 没有初始视角时用 fitBounds
  if (!activeCoords) return;
  const lons = activeCoords.map((c) => c[0]);
  const lats = activeCoords.map((c) => c[1]);
  map.fitBounds(
    [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    {
      padding:  { top: 150, bottom: 290, left: 100, right: 100 },
      pitch:    0,
      bearing:  0,
      duration: 2000,
      maxZoom:  14,
      easing:   smoothCamEasing,
    },
  );
});

// ───────────────────────────────────────────────
//  Tile preloader — invisible two-frame jumpTo at playback zoom/pitch so
//  MapLibre enqueues tile fetches before the user hits play.
// ───────────────────────────────────────────────
function preloadPlaybackTiles() {
  if (!flyover || flyover.playing || flyover.progress > 0) return;
  if (!activeCoords) return;
  // Try to warm satellite tiles even when user is currently in outdoor mode.
  // Satellite is a raster layer; if tiles "pop" in, it appears as flicker.
  if (!map.getLayer('satellite-layer')) return;

  const sv = {
    center:  map.getCenter(),
    zoom:    map.getZoom(),
    bearing: map.getBearing(),
    pitch:   map.getPitch(),
  };

  const prevOpacity = (() => {
    try { return map.getPaintProperty('satellite-layer', 'raster-opacity'); } catch { return 0; }
  })();
  const prevFade = (() => {
    try { return map.getPaintProperty('satellite-layer', 'raster-fade-duration'); } catch { return 350; }
  })();

  // If satellite is currently off (opacity=0), lift it a tiny bit so MapLibre still considers the layer.
  // Keep it low enough to avoid noticeable flashing during the prewarm.
  const prevOpacityNum = (typeof prevOpacity === 'number') ? prevOpacity : Number(prevOpacity);
  const targetOpacity = Number.isFinite(prevOpacityNum) && prevOpacityNum > 0 ? prevOpacityNum : 0.01;

  map.setPaintProperty('satellite-layer', 'raster-opacity', targetOpacity);
  map.setPaintProperty('satellite-layer', 'raster-fade-duration', 0); // prewarm quickly; fade only matters for display.

  const n = activeCoords.length;
  const idxs = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.floor((n - 1) * f));
  const uniqIdxs = Array.from(new Set(idxs));

  const zoom = flyover.zoom;
  const pitch = 55; // match follow-cam
  const bearing = 0;

  // Jump across several gpx segments so satellite tiles are queued across the route area.
  let i = 0;
  const step = () => {
    if (!flyover || flyover.playing) return; // stop if playback started
    if (i >= uniqIdxs.length) {
      // Restore original style params + view.
      try {
        map.setPaintProperty('satellite-layer', 'raster-opacity', prevOpacity);
        map.setPaintProperty('satellite-layer', 'raster-fade-duration', prevFade);
      } catch {
        // ignore
      }
      map.jumpTo({ center: sv.center, zoom: sv.zoom, bearing: sv.bearing, pitch: sv.pitch });
      return;
    }

    const idx = uniqIdxs[i++];
    const c = activeCoords[idx].slice(0, 2);
    map.jumpTo({ center: c, zoom, pitch, bearing });
    requestAnimationFrame(step);
  };

  requestAnimationFrame(step);
}

// ───────────────────────────────────────────────
//  Core: load a File → parse → render
// ───────────────────────────────────────────────
function processFile(file) {
  if (!file?.name.toLowerCase().endsWith('.gpx')) {
    alert('请选择 .gpx 格式文件');
    return;
  }

  showLoader();

  const reader = new FileReader();

  reader.onload = (e) => {
    try {
      const { name, coords } = parseGPX(/** @type {string} */ (e.target.result));
      const stats = calcStats(coords);
      const statsProfile = buildStatsProfile(coords);

      hideDropOverlay();

      const go = () => {
        hideLoader();
        renderTrack(map, coords);
        showHUD(stats, name);
        drawElevation(coords);

        // Tear down any previous flyover and create a fresh one
        clearRecordingCountdown();
        setPlayIcon(false);
        flyover?.destroy();
        activeCoords = coords;
        activeStatsProfile = statsProfile;
        fullStats = stats;
        flyover = new Flyover(map, coords);
        flyover.followCam = followBtn?.classList.contains('active') ?? true;
        playerEl?.classList.add('visible');

        // Preload tiles at playback zoom/pitch while the fitBounds overview
        // animation runs. Delayed past the 1800 ms fitBounds duration.
        setTimeout(() => preloadPlaybackTiles(), 2200);
      };

      if (map.isStyleLoaded()) go();
      else map.once('load', go);
    } catch (err) {
      console.error(err);
      hideLoader();
      alert('解析 GPX 失败：' + err.message);
    }
  };

  reader.readAsText(file, 'UTF-8');
}

// ───────────────────────────────────────────────
//  Drop zone interactions
// ───────────────────────────────────────────────
const dz = /** @type {HTMLElement} */ (document.getElementById('drop-zone'));

dz.addEventListener('dragover', (e) => {
  e.preventDefault();
  dz.classList.add('dragover');
});
dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('dragover');
  processFile(e.dataTransfer?.files[0] ?? null);
});

// File picker
document.getElementById('file-input')?.addEventListener('change', (e) => {
  const input = /** @type {HTMLInputElement} */ (e.target);
  processFile(input.files?.[0] ?? null);
  input.value = '';
});

// Global drop once map is showing
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (file?.name.toLowerCase().endsWith('.gpx')) processFile(file);
});

// Reset
document.getElementById('reset-btn')?.addEventListener('click', () => {
  clearRecordingCountdown();
  flyover?.destroy();
  location.reload();
});

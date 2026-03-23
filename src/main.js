import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

import { parseGPX } from './gpx.js';
import { buildStatsProfile, calcStats, statsAtProgress } from './stats.js';
import { createMap, renderTrack, setMapStyle } from './map.js';
import { drawElevation, updatePlayhead } from './elevation.js';
import { showHUD, updateHUD, showLoader, hideLoader, hideDropOverlay } from './ui.js';
import { Flyover } from './flyover.js';

// ── Init map immediately (sits behind the drop overlay)
const map = createMap('map');

/** Currently active Flyover instance (null when no track loaded). */
let flyover = null;

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
const styleSelect = /** @type {HTMLSelectElement} */ (document.getElementById('style-select'));
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

styleSelect?.addEventListener('change', () => {
  setMapStyle(map, /** @type {any} */ (styleSelect.value));
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
  if (!activeCoords) return;
  const lons = activeCoords.map((c) => c[0]);
  const lats = activeCoords.map((c) => c[1]);
  // Flyover already finished its own intro-style outro to a top-down end view.
  // fitBounds now only needs to animate the overview framing.
  map.fitBounds(
    [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    {
      padding:  { top: 150, bottom: 290, left: 100, right: 100 },
      pitch:    0,
      bearing:  0,
      duration: 1800,
      maxZoom:  14,
      easing:   (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2, // ease-in-out quad
    },
  );
});

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

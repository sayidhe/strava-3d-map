import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

import { parseGPX } from './gpx.js';
import { calcStats } from './stats.js';
import { createMap, renderTrack, setMapStyle } from './map.js';
import { drawElevation, updatePlayhead } from './elevation.js';
import { showHUD, showLoader, hideLoader, hideDropOverlay } from './ui.js';
import { Flyover } from './flyover.js';

// ── Init map immediately (sits behind the drop overlay)
const map = createMap('map');

/** Currently active Flyover instance (null when no track loaded). */
let flyover = null;

/** Active track coords (needed for re-fitting after flyover ends). */
let activeCoords = null;

// ── Player UI helpers ─────────────────────────────────
const playBtn    = /** @type {HTMLButtonElement} */ (document.getElementById('play-btn'));
const playerEl   = /** @type {HTMLElement}       */ (document.getElementById('player'));
const followBtn  = /** @type {HTMLButtonElement} */ (document.getElementById('follow-btn'));
const styleSelect = /** @type {HTMLSelectElement} */ (document.getElementById('style-select'));
const speedBtns  = /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('.speed-btn'));

function setPlayIcon(isPlaying) {
  playBtn.innerHTML = isPlaying
    ? '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><rect x="5" y="4" width="4" height="16" rx="1"/><rect x="15" y="4" width="4" height="16" rx="1"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><polygon points="6,3 20,12 6,21"/></svg>';
}

setPlayIcon(false);

playBtn?.addEventListener('click', () => {
  if (!flyover) return;
  if (flyover.playing) {
    flyover.pause();
    setPlayIcon(false);
  } else {
    flyover.play();
    setPlayIcon(true);
  }
});

followBtn?.addEventListener('click', () => {
  const on = followBtn.classList.toggle('active');
  if (flyover) flyover.followCam = on;
});

styleSelect?.addEventListener('change', () => {
  setMapStyle(map, /** @type {any} */ (styleSelect.value));
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
  updatePlayhead(/** @type {CustomEvent} */ (e).detail.progress);
});

// Flyover finished → reset icon, fly back to full track overview
window.addEventListener('flyover:ended', () => {
  setPlayIcon(false);
  if (!activeCoords) return;
  const lons = activeCoords.map((c) => c[0]);
  const lats = activeCoords.map((c) => c[1]);
  map.fitBounds(
    [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    { padding: { top: 180, bottom: 220, left: 100, right: 100 }, pitch: 0, bearing: 0, duration: 1800, maxZoom: 14 },
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

      hideDropOverlay();

      const go = () => {
        hideLoader();
        renderTrack(map, coords);
        showHUD(stats, name);
        drawElevation(coords);

        // Tear down any previous flyover and create a fresh one
        flyover?.destroy();
        activeCoords = coords;
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
  flyover?.destroy();
  location.reload();
});

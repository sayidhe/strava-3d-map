// ── Constants ─────────────────────────────────────────
const PITCH = 55;
const UI_BOTTOM_PX = 220; // height of HUD + player + elevation bar
const LOOK_AHEAD_FRAC = 0.6; // 6% look-ahead distance for stable bearing
const TRAIL_MAX_PTS   = 800;

/**
 * Y-offset (px) so the moving dot sits in the centre of the clear viewport
 * (above the bottom UI strip). Negative = target renders above screen centre.
 *   clearCentre = (h - UI_BOTTOM_PX) / 2  from top
 *   screenCentre = h / 2
 *   offset = -(UI_BOTTOM_PX / 2)
 *
 * Add an extra nudge so the trail ahead has more room – empirically ~40px more
 * negative keeps the dot in the lower-third of the clear area.
 */
function camOffsetY() {
  return -Math.round(UI_BOTTOM_PX / 2) + 400; // ≈ +130 px
}
const BASE_DURATION_MS = 75_000;

/**
 * Compute flyover zoom from track length.
 * Targets ~13.5 for short hikes (~10 km), ~12.5 for 50 km, ~11.5 for 150 km.
 */
function flyZoom(totalDistM) {
  const km = totalDistM / 1000;
  const z = 14.0 - Math.log2(Math.max(1, km / 5)) * 0.5;
  return Math.min(13.5, Math.max(11.5, z));
}

// ── Math helpers ──────────────────────────────────────

/** Cumulative planar-distance array (fast, accurate enough for ≤200 km spans). */
function buildCumDists(coords) {
  const d = new Float64Array(coords.length);
  const M = 111_320;
  for (let i = 1; i < coords.length; i++) {
    const dx =
      (coords[i][0] - coords[i - 1][0]) *
      Math.cos((coords[i][1] * Math.PI) / 180) *
      M;
    const dy = (coords[i][1] - coords[i - 1][1]) * M;
    d[i] = d[i - 1] + Math.sqrt(dx * dx + dy * dy);
  }
  return d;
}

/** Binary search for the segment [lo, hi] that straddles distance d. */
function findSeg(dists, d) {
  let lo = 0;
  let hi = dists.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (dists[mid] <= d) lo = mid;
    else hi = mid;
  }
  const span = dists[hi] - dists[lo];
  return { lo, hi, t: span > 0 ? (d - dists[lo]) / span : 0 };
}

function lerp(a, b, t) { return a + t * (b - a); }

/**
 * Returns the interpolated position on the track at distance d.
 * @returns {{ lon: number, lat: number, ele: number, idx: number }}
 */
function posAtDist(coords, dists, d) {
  const clamped = Math.min(Math.max(d, 0), dists[dists.length - 1]);
  const { lo, hi, t } = findSeg(dists, clamped);
  return {
    lon: lerp(coords[lo][0], coords[hi][0], t),
    lat: lerp(coords[lo][1], coords[hi][1], t),
    ele: lerp(coords[lo][2], coords[hi][2], t),
    idx: lo,
  };
}

/** True geodetic forward bearing (lon1,lat1) → (lon2,lat2), degrees. */
function bearingBetween(lon1, lat1, lon2, lat2) {
  const R = Math.PI / 180;
  const dLon = (lon2 - lon1) * R;
  const y = Math.sin(dLon) * Math.cos(lat2 * R);
  const x =
    Math.cos(lat1 * R) * Math.sin(lat2 * R) -
    Math.sin(lat1 * R) * Math.cos(lat2 * R) * Math.cos(dLon);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

/** Build a downsampled trail GeoJSON from coords[0..idx]. */
function trailGeoJSON(coords, idx) {
  let pts = coords.slice(0, idx + 1).map((c) => [c[0], c[1]]);
  if (pts.length < 2) pts = [pts[0] ?? [0, 0], pts[0] ?? [0, 0]];
  if (pts.length > TRAIL_MAX_PTS) {
    const step = Math.ceil(pts.length / TRAIL_MAX_PTS);
    const s = pts.filter((_, i) => i % step === 0);
    s.push(pts[pts.length - 1]);
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: s } };
  }
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: pts } };
}

/** GeoJSON for the moving head dot. */
const headGeoJSON = (lon, lat) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
});

// ── Layer / source names ──────────────────────────────
const SRC_TRAIL = 'fly-trail';
const SRC_HEAD  = 'fly-head';
const L_TRAIL   = 'fly-trail';
const L_HALO    = 'fly-halo';
const L_HEAD    = 'fly-head';

// ── Flyover class ─────────────────────────────────────

export class Flyover {
  /**
   * @param {import('maplibre-gl').Map} map
   * @param {[number, number, number][]} coords
   */
  constructor(map, coords) {
    this.map   = map;
    this.coords = coords;
    this.dists = buildCumDists(coords);
    this.totalDist = this.dists[this.dists.length - 1];
    this.zoom = flyZoom(this.totalDist);

    // Smoothed camera position (initialised to track start)
    this._camLon = coords[0][0];
    this._camLat = coords[0][1];

    // Duration scales with track length, min 60 s, max 180 s
    this.baseDuration = Math.min(
      180_000,
      Math.max(BASE_DURATION_MS, (this.totalDist / 1000) * 1200),
    );
    this.speedMult = 1;

    this.playing  = false;
    this.progress = 0;       // 0 – 1

    this._raf            = null;
    this._startTime      = null;
    this._pausedElapsed  = 0;
    this._frameCount     = 0;
    this._intro          = null;
    this.followCam       = true;

    // Initialise bearing to the first track segment direction
    const fwd = posAtDist(coords, this.dists, this.totalDist * 0.03);
    this._bearing = bearingBetween(coords[0][0], coords[0][1], fwd.lon, fwd.lat);

    this._addLayers();
  }

  get _duration() { return this.baseDuration / this.speedMult; }

  // ── Layers ──────────────────────────────────────────

  _addLayers() {
    const { map, coords } = this;
    this._removeLayers();

    map.addSource(SRC_TRAIL, { type: 'geojson', data: trailGeoJSON(coords, 0) });
    map.addSource(SRC_HEAD,  { type: 'geojson', data: headGeoJSON(coords[0][0], coords[0][1]) });

    // Completed-path trail
    map.addLayer({
      id: L_TRAIL, type: 'line', source: SRC_TRAIL,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#fc4c02', 'line-width': 5, 'line-opacity': 1 },
    });

    // Outer pulsing halo
    map.addLayer({
      id: L_HALO, type: 'circle', source: SRC_HEAD,
      paint: {
        'circle-color': '#fc4c02', 'circle-radius': 16,
        'circle-opacity': 0.25, 'circle-pitch-alignment': 'map',
      },
    });

    // Head dot
    map.addLayer({
      id: L_HEAD, type: 'circle', source: SRC_HEAD,
      paint: {
        'circle-color': '#ffffff', 'circle-radius': 6,
        'circle-stroke-color': '#fc4c02', 'circle-stroke-width': 3,
        'circle-pitch-alignment': 'map',
      },
    });

    // Dim the static track so the animated trail pops
    this._setBaseOpacity(0.25, 0.06);
  }

  _removeLayers() {
    const { map } = this;
    [L_TRAIL, L_HALO, L_HEAD].forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
    [SRC_TRAIL, SRC_HEAD].forEach((id)     => { if (map.getSource(id)) map.removeSource(id); });
  }

  _setBaseOpacity(track, glow) {
    try {
      if (this.map.getLayer('gpx-track')) this.map.setPaintProperty('gpx-track', 'line-opacity', track);
      if (this.map.getLayer('gpx-glow'))  this.map.setPaintProperty('gpx-glow',  'line-opacity', glow);
    } catch (_) { /* layers may not exist yet */ }
  }

  // ── Playback controls ────────────────────────────────

  play() {
    if (this.playing) return;

    const isRestart = this.progress >= 1;
    if (isRestart) {
      this._pausedElapsed = 0;
      this.progress = 0;
      this._camLon = this.coords[0][0];
      this._camLat = this.coords[0][1];
    }

    this.playing = true;

    // Snapshot current map camera so we can blend from it inside the tick loop
    const cam = this.map.getFreeCameraOptions ? this.map.getFreeCameraOptions() : null;
    const curCenter  = this.map.getCenter();
    const curBearing = this.map.getBearing();
    const curPitch   = this.map.getPitch();
    const curZoom    = this.map.getZoom();

    const resuming = !isRestart && this._pausedElapsed > 0;
    this._intro = (resuming || !this.followCam) ? null : {
      fromLon:     curCenter.lng,
      fromLat:     curCenter.lat,
      fromBearing: curBearing,
      fromPitch:   curPitch,
      fromZoom:    curZoom,
      durationMs:  1400,
      startedAt:   performance.now(),
    };

    this._startTime = performance.now() - this._pausedElapsed;
    this._tick();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this._pausedElapsed = performance.now() - this._startTime;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._intro = null;
  }

  /** Change playback speed without losing current position. */
  setSpeed(mult) {
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this._pausedElapsed = this.progress * (this.baseDuration / mult);
    this.speedMult = mult;
    if (wasPlaying) this.play();
  }

  /** Stop and tear down all flyover layers. */
  destroy() {
    this.playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._intro = null;
    this._removeLayers();
    this._setBaseOpacity(0.95, 0.16);
  }

  // ── Animation loop ───────────────────────────────────

  _tick() {
    if (!this.playing) return;

    const now     = performance.now();
    const elapsed = now - this._startTime;
    this.progress = Math.min(elapsed / this._duration, 1);

    const d   = this.progress * this.totalDist;
    const pos = posAtDist(this.coords, this.dists, d);

    // Look-ahead bearing
    const aD    = Math.min(d + this.totalDist * LOOK_AHEAD_FRAC, this.totalDist);
    const ahead = posAtDist(this.coords, this.dists, aD);
    const tBear = bearingBetween(pos.lon, pos.lat, ahead.lon, ahead.lat);

    let diff = tBear - this._bearing;
    if (diff >  180) diff -= 360;
    if (diff < -180) diff += 360;
    this._bearing = (this._bearing + diff * 0.07 + 360) % 360;

    // ── Intro blend: interpolate from snapshot → target camera ──────────
    let centerLon = pos.lon;
    let centerLat = pos.lat;
    let bearing   = this._bearing;
    let pitch     = PITCH;
    let zoom      = this.zoom;
    let offsetY   = camOffsetY();

    if (this._intro) {
      const { fromLon, fromLat, fromBearing, fromPitch, fromZoom, durationMs, startedAt } = this._intro;
      const t0 = Math.min((now - startedAt) / durationMs, 1);
      // ease-out cubic
      const t  = 1 - Math.pow(1 - t0, 3);

      // Shortest-path bearing interpolation
      let bDiff = this._bearing - fromBearing;
      if (bDiff >  180) bDiff -= 360;
      if (bDiff < -180) bDiff += 360;

      centerLon = fromLon + (pos.lon - fromLon) * t;
      centerLat = fromLat + (pos.lat - fromLat) * t;
      bearing   = (fromBearing + bDiff * t + 360) % 360;
      pitch     = fromPitch   + (PITCH      - fromPitch)   * t;
      zoom      = fromZoom    + (this.zoom  - fromZoom)    * t;
      // Interpolate offset 0 → final so dot doesn't jump on intro
      offsetY   = camOffsetY() * t;

      if (t0 >= 1) this._intro = null;  // intro done
    }

    if (this.followCam) {
      this.map.easeTo({ center: [centerLon, centerLat], bearing, pitch, zoom, offset: [0, offsetY], duration: 0 });
    }

    // GeoJSON updates throttled to every 3rd frame
    this._frameCount++;
    if (this._frameCount % 3 === 0) {
      this.map.getSource(SRC_TRAIL)?.setData(trailGeoJSON(this.coords, pos.idx));
      this.map.getSource(SRC_HEAD)?.setData(headGeoJSON(pos.lon, pos.lat));
    }

    window.dispatchEvent(new CustomEvent('flyover:progress', { detail: { progress: this.progress } }));

    if (this.progress < 1) {
      this._raf = requestAnimationFrame(() => this._tick());
    } else {
      this.playing = false;
      this._setBaseOpacity(0.95, 0.16);
      window.dispatchEvent(new CustomEvent('flyover:ended'));
    }
  }
}

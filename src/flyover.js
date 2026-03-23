// ── Camera preset ─────────────────────────────────────
// All follow-cam parameters are defined here.
const CAM_PITCH    = 30;   // camera tilt in degrees (0 = top-down, 85 = horizon)
const CAM_OFFSET_Y = 150;  // px: positive → track dot sits below canvas centre
                            // (keeps the dot in the lower viewport, above the UI strip)
const INTRO_MS     = 1200; // follow-cam transition duration (ms)
const INTRO_MAX_MS = 2100;
const OUTRO_MS        = 1200;
const OUTRO_PREP_MS   = 1200;
const OUTRO_PREP_MAX_MS = 2400;
const OUTRO_BEAR_BACKTRACK_M = 120;
const OUTRO_MATCH_SPEED = 6;
const OUTRO_BEAR_LOCK_START = 0.55;
const OUTRO_FINAL_BEAR_FREEZE_MS = 800;
const OUTRO_FINAL_POS_FREEZE_MS = 600;

// ── Playback / rendering constants ────────────────────
const BASE_DURATION_MS = 75_000;
const LOOK_AHEAD_FRAC  = 0.6;
const TRAIL_MAX_PTS    = 800;

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

function smoothstep(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

function shortestAngleDelta(from, to) {
  let diff = to - from;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return diff;
}

function introDurationMs(fromBearing, toBearing) {
  const turnDeg = Math.abs(shortestAngleDelta(fromBearing, toBearing));
  return Math.min(INTRO_MAX_MS, INTRO_MS + turnDeg * 5);
}

function lowSpeedFactor(speedMult) {
  return Math.min(Math.max((4 - Math.max(1, speedMult)) / 3, 0), 1);
}

function outroPrepDurationMs(speedMult) {
  return lerp(OUTRO_PREP_MS, OUTRO_PREP_MAX_MS, lowSpeedFactor(speedMult));
}

function outroBearLockStart(speedMult) {
  return lerp(OUTRO_BEAR_LOCK_START, 0.28, lowSpeedFactor(speedMult));
}

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
    this._endPos = posAtDist(coords, this.dists, this.totalDist);
    const endBackDist = Math.max(0, this.totalDist - Math.min(OUTRO_BEAR_BACKTRACK_M, this.totalDist * 0.08));
    const endBackPos = posAtDist(coords, this.dists, endBackDist);
    this._endBearing = bearingBetween(endBackPos.lon, endBackPos.lat, this._endPos.lon, this._endPos.lat);

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
    this._outro          = null;
    this._returnView     = null;
    this._outroBearingLock = null;
    this._outroFrozenBearing = null;
    this.followCam       = true;

    // Initialise bearing to the same look-ahead target used by steady-state
    // follow-cam. This avoids a visible twist when intro hands off to _tick().
    const fwd = posAtDist(coords, this.dists, Math.min(this.totalDist * LOOK_AHEAD_FRAC, this.totalDist));
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
    this._outro = null;

    const isRestart = this.progress >= 1;
    if (isRestart) {
      this._pausedElapsed = 0;
      this.progress = 0;
      this._camLon = this.coords[0][0];
      this._camLat = this.coords[0][1];
      this._returnView = null;
    }
    this._outroBearingLock = null;
    this._outroFrozenBearing = null;

    this.playing = true;
    this.map.stop();

    const resuming = !isRestart && this._pausedElapsed > 0;
    if (this.followCam && !resuming) {
      // Capture the geographic point currently shown at the *offset position*
      // [w/2, h/2+CAM_OFFSET_Y] so we can keep offset constant (= CAM_OFFSET_Y)
      // for the whole intro. That means only center/bearing/pitch/zoom animate —
      // the track dot moves smoothly with no offset jump.
      const mapEl  = this.map.getContainer();
      const fromPt = this.map.unproject([
        mapEl.clientWidth  / 2,
        mapEl.clientHeight / 2 + CAM_OFFSET_Y,
      ]);
      this._intro = {
        fromLon:     fromPt.lng,
        fromLat:     fromPt.lat,
        fromBearing: this.map.getBearing(),
        fromPitch:   this.map.getPitch(),
        fromZoom:    this.map.getZoom(),
        durationMs:  introDurationMs(this.map.getBearing(), this._bearing),
        startedAt:   performance.now(),
      };
      this._returnView = {
        toLon:       this._intro.fromLon,
        toLat:       this._intro.fromLat,
        toBearing:   this._intro.fromBearing,
        toPitch:     this._intro.fromPitch,
        toZoom:      this._intro.fromZoom,
        durationMs:  this._intro.durationMs,
      };
    } else {
      this._intro = null;
      if (!resuming) this._returnView = null;
    }

    this._startTime = performance.now() - this._pausedElapsed;
    // If there's an intro transition, freeze the playback clock until it
    // finishes — the track shouldn't race ahead while the camera is still
    // flying in from a distant view.
    if (this._intro) this._startTime = null;
    this._tick();
  }

  /**
   * Snap camera back to the follow-cam position with a smooth transition.
   * Both paths use the exact same easeTo({duration:0}) + ramp pattern as
   * _tick(), so the final camera state is guaranteed bit-identical.
   */
  snapToFollow() {
    this.map.stop();
    // Sample the geographic point at the offset screen position so that
    // offset stays constant (= CAM_OFFSET_Y) for the whole transition.
    // Only center/bearing/pitch/zoom animate — same approach as play() intro.
    const mapEl  = this.map.getContainer();
    const fromPt = this.map.unproject([
      mapEl.clientWidth  / 2,
      mapEl.clientHeight / 2 + CAM_OFFSET_Y,
    ]);
    const fromLon     = fromPt.lng;
    const fromLat     = fromPt.lat;
    const fromBearing = this.map.getBearing();
    const fromPitch   = this.map.getPitch();
    const fromZoom    = this.map.getZoom();

    if (this.playing) {
      // _tick is running — inject an intro and let _tick animate it.
      this._intro = {
        fromLon, fromLat, fromBearing, fromPitch, fromZoom,
        durationMs: introDurationMs(fromBearing, this._bearing),
        startedAt:  performance.now(),
      };
      return;
    }

    // Not playing: run the same per-frame easeTo({duration:0}) loop that
    // _tick uses, so the final camera state is bit-identical to steady state.
    const startedAt = performance.now();
    const durationMs = introDurationMs(fromBearing, this._bearing);
    const animate = () => {
      const t0 = Math.min((performance.now() - startedAt) / durationMs, 1);
      const t  = smoothstep(t0);

      let bDiff = this._bearing - fromBearing;
      if (bDiff >  180) bDiff -= 360;
      if (bDiff < -180) bDiff += 360;

      this.map.easeTo({
        center:   [fromLon + (this._camLon - fromLon) * t,
                   fromLat + (this._camLat - fromLat) * t],
        bearing:  (fromBearing + bDiff * t + 360) % 360,
        pitch:    fromPitch + (CAM_PITCH - fromPitch) * t,
        zoom:     fromZoom  + (this.zoom  - fromZoom)  * t,
        offset:   [0, CAM_OFFSET_Y], // constant throughout
        duration: 0,
      });

      if (t0 < 1) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    // _startTime is null when paused during the opening intro
    this._pausedElapsed = this._startTime !== null
      ? performance.now() - this._startTime
      : 0;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._intro = null;
    this._outro = null;
    this._returnView = null;
    this._outroBearingLock = null;
    this._outroFrozenBearing = null;
    this._startTime = null;
  }

  /** Change playback speed without losing current position. */
  setSpeed(mult) {
    // Re-anchor elapsed time so current progress is preserved at new speed
    this._pausedElapsed = this.progress * (this.baseDuration / mult);
    this.speedMult = mult;
    if (this.playing) {
      // Reset the clock so _tick's elapsed calculation uses new duration
      this._startTime = performance.now() - this._pausedElapsed;
    }
  }

  /** Stop and tear down all flyover layers. */
  destroy() {
    this.playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._intro = null;
    this._outro = null;
    this._returnView = null;
    this._outroBearingLock = null;
    this._outroFrozenBearing = null;
    this._removeLayers();
    this._setBaseOpacity(0.95, 0.16);
  }

  // ── Animation loop ───────────────────────────────────

  _tick() {
    if (!this.playing) {
      if (this._outro) {
        const now = performance.now();
        const t0 = Math.min((now - this._outro.startedAt) / this._outro.durationMs, 1);
        const t = smoothstep(t0);
        const { fromLon, fromLat, fromBearing, fromPitch, fromZoom, toLon, toLat, toBearing, toPitch, toZoom } = this._outro;
        const bDiff = shortestAngleDelta(fromBearing, toBearing);
        this.map.easeTo({
          center:   [fromLon + (toLon - fromLon) * t,
                     fromLat + (toLat - fromLat) * t],
          bearing:  (fromBearing + bDiff * t + 360) % 360,
          pitch:    fromPitch + (toPitch - fromPitch) * t,
          zoom:     fromZoom + (toZoom - fromZoom) * t,
          offset:   [0, CAM_OFFSET_Y],
          duration: 0,
        });
        if (t0 < 1) {
          this._raf = requestAnimationFrame(() => this._tick());
          return;
        }
        this._outro = null;
        this.map.stop();
        window.dispatchEvent(new CustomEvent('flyover:ended', {
          detail: { restoredView: this._returnView !== null },
        }));
      }
      return;
    }

    const now     = performance.now();

    // While the opening intro is playing, hold progress at 0 so the track
    // doesn't advance until the camera has finished flying in.
    if (this._startTime === null) {
      // Check if intro finished this frame
      if (this._intro) {
        const t0 = (now - this._intro.startedAt) / this._intro.durationMs;
        if (t0 < 1) {
          // Still in intro — just render the camera blend and schedule next tick
          const t = smoothstep(t0);
          const { fromLon, fromLat, fromBearing, fromPitch, fromZoom } = this._intro;
          const bDiff = shortestAngleDelta(fromBearing, this._bearing);
          this.map.easeTo({
            center:  [fromLon + (this._camLon - fromLon) * t,
                      fromLat + (this._camLat - fromLat) * t],
            bearing: (fromBearing + bDiff * t + 360) % 360,
            pitch:   fromPitch + (CAM_PITCH - fromPitch) * t,
            zoom:    fromZoom  + (this.zoom  - fromZoom)  * t,
            offset:  [0, CAM_OFFSET_Y],
            duration: 0,
          });
          this._raf = requestAnimationFrame(() => this._tick());
          return;
        }
      }
      // Intro done — start the playback clock from now
      this._intro = null;
      this._startTime = now - this._pausedElapsed;
    }

    const elapsed = now - this._startTime;
    this.progress = Math.min(elapsed / this._duration, 1);

    const d   = this.progress * this.totalDist;
    const pos = posAtDist(this.coords, this.dists, d);
    const speedSmooth = Math.max(1, this.speedMult);
    const prepDuration = outroPrepDurationMs(speedSmooth);
    const bearLockStart = outroBearLockStart(speedSmooth);
    const remainingMs = Math.max(this._duration - elapsed, 0);
    const outroPrepStart = Math.max(0, this._duration - prepDuration);
    const outroPrepT0 = this._duration > 0 && elapsed > outroPrepStart
      ? Math.min((elapsed - outroPrepStart) / Math.max(prepDuration, 1), 1)
      : 0;
    const outroPrepT = smoothstep(outroPrepT0);
    const outroBearLockT0 = outroPrepT0 > bearLockStart
      ? (outroPrepT0 - bearLockStart) / (1 - bearLockStart)
      : 0;
    const outroBearLockT = smoothstep(Math.min(Math.max(outroBearLockT0, 0), 1));

    // Speed-adaptive smoothing: at higher multipliers each frame covers more
    // distance, so we reduce the per-frame factor proportionally to maintain
    // consistent temporal smoothness and suppress GPS-noise jitter.
    const outroSmooth = Math.max(speedSmooth, OUTRO_MATCH_SPEED);
    const currentPosFac  = 0.2  / speedSmooth;
    const currentBearFac = 0.07 / speedSmooth;
    const stablePosFac   = 0.2  / outroSmooth;
    const stableBearFac  = 0.07 / outroSmooth;
    const lowSpeedT = lowSpeedFactor(speedSmooth);
    const posFac  = lerp(currentPosFac, stablePosFac, smoothstep(Math.min(outroPrepT + lowSpeedT * 0.18, 1)));   // position low-pass
    const bearFac = lerp(currentBearFac, stableBearFac, smoothstep(Math.min(outroPrepT + lowSpeedT * 0.24, 1))); // bearing low-pass

    // Smooth camera position to absorb GPS noise (critical at 4×+)
    const posTargetBlend = smoothstep(Math.min(outroPrepT * (1.15 + lowSpeedT * 0.45), 1));
    const bearTargetBlend = smoothstep(Math.min(outroPrepT * (1.35 + lowSpeedT * 0.7), 1));
    const useFrozenPos = remainingMs <= OUTRO_FINAL_POS_FREEZE_MS;
    const targetLon = useFrozenPos ? this._endPos.lon : lerp(pos.lon, this._endPos.lon, posTargetBlend);
    const targetLat = useFrozenPos ? this._endPos.lat : lerp(pos.lat, this._endPos.lat, posTargetBlend);
    this._camLon += (targetLon - this._camLon) * posFac;
    this._camLat += (targetLat - this._camLat) * posFac;

    // Look-ahead bearing
    const aD    = Math.min(d + this.totalDist * LOOK_AHEAD_FRAC, this.totalDist);
    const ahead = posAtDist(this.coords, this.dists, aD);
    const tBear = bearingBetween(pos.lon, pos.lat, ahead.lon, ahead.lat);

    const liveTargetBearing = (this._endBearing + shortestAngleDelta(this._endBearing, tBear) * (1 - bearTargetBlend) + 360) % 360;
    if (remainingMs > OUTRO_FINAL_BEAR_FREEZE_MS) {
      this._outroFrozenBearing = null;
    } else if (this._outroFrozenBearing === null) {
      this._outroFrozenBearing = liveTargetBearing;
    }
    const frozenAwareBearing = this._outroFrozenBearing ?? liveTargetBearing;
    if (outroBearLockT0 <= 0) {
      this._outroBearingLock = null;
    } else if (this._outroBearingLock === null) {
      this._outroBearingLock = frozenAwareBearing;
    }
    const targetBearing = this._outroBearingLock === null
      ? frozenAwareBearing
      : (this._outroBearingLock + shortestAngleDelta(this._outroBearingLock, this._endBearing) * outroBearLockT + 360) % 360;
    let diff = shortestAngleDelta(this._bearing, targetBearing);
    this._bearing = (this._bearing + diff * bearFac + 360) % 360;

    // ── Intro blend: interpolate from snapshot → follow-cam target ───────
    let centerLon = this._camLon;
    let centerLat = this._camLat;
    let bearing   = this._bearing;
    let pitch     = CAM_PITCH;
    let zoom      = this.zoom;
    let offsetY   = CAM_OFFSET_Y;

    if (this._intro) {
      const { fromLon, fromLat, fromBearing, fromPitch, fromZoom, durationMs, startedAt } = this._intro;
      const t0 = Math.min((now - startedAt) / durationMs, 1);
      const t  = smoothstep(t0); // smoothstep: zero velocity at both ends

      const bDiff = shortestAngleDelta(fromBearing, this._bearing);

      centerLon = fromLon  + (this._camLon  - fromLon)  * t;
      centerLat = fromLat  + (this._camLat  - fromLat)  * t;
      bearing   = (fromBearing + bDiff * t + 360) % 360;
      pitch     = fromPitch + (CAM_PITCH  - fromPitch)  * t;
      zoom      = fromZoom  + (this.zoom   - fromZoom)   * t;
      // offset stays constant — fromLon/fromLat was sampled at the offset
      // screen position so the track dot moves smoothly with no jump.

      if (t0 >= 1) this._intro = null;
    }

    if (this.followCam) {
      // In steady state (no intro) this call uses _camTarget() values exactly,
      // which is also what snapToFollow() targets — guaranteed identical result.
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
      this.map.getSource(SRC_TRAIL)?.setData(trailGeoJSON(this.coords, this.coords.length - 1));
      this.map.getSource(SRC_HEAD)?.setData(headGeoJSON(this._endPos.lon, this._endPos.lat));
      const fromCenter = this.followCam
        ? { lng: centerLon, lat: centerLat }
        : this.map.getCenter();
      const fromBearing = this.followCam ? bearing : this.map.getBearing();
      const fromPitch = this.followCam ? pitch : this.map.getPitch();
      const fromZoom = this.followCam ? zoom : this.map.getZoom();
      const returnView = this.followCam ? this._returnView : null;
      this.map.stop();
      this._outro = {
        fromLon:     fromCenter.lng,
        fromLat:     fromCenter.lat,
        fromBearing,
        fromPitch,
        fromZoom,
        toLon:       returnView ? returnView.toLon : this._endPos.lon,
        toLat:       returnView ? returnView.toLat : this._endPos.lat,
        toBearing:   returnView ? returnView.toBearing : 0,
        toPitch:     returnView ? returnView.toPitch : 0,
        toZoom:      returnView ? returnView.toZoom : this.zoom,
        durationMs:  returnView ? returnView.durationMs : OUTRO_MS,
        startedAt:   performance.now(),
      };
      this._raf = requestAnimationFrame(() => this._tick());
    }
  }
}

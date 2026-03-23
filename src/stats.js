/** Haversine distance in metres between two [lon, lat] points. */
function haversine(a, b) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
}

function profileValueAt(values, idx, t) {
  if (idx <= 0) return values[0] ?? 0;
  const start = values[idx] ?? values[values.length - 1] ?? 0;
  const end = values[Math.min(idx + 1, values.length - 1)] ?? start;
  return start + (end - start) * t;
}

/**
 * Build cumulative distance / ascent / descent arrays for playback HUD updates.
 * @param {[number, number, number][]} coords
 */
export function buildStatsProfile(coords) {
  const dist = new Float64Array(coords.length);
  const gain = new Float64Array(coords.length);
  const loss = new Float64Array(coords.length);
  let hi = -Infinity;
  let lo = Infinity;

  for (let i = 1; i < coords.length; i++) {
    dist[i] = dist[i - 1] + haversine(coords[i - 1], coords[i]);
    const dEle = coords[i][2] - coords[i - 1][2];
    gain[i] = gain[i - 1] + (dEle > 0 ? dEle : 0);
    loss[i] = loss[i - 1] + (dEle < 0 ? Math.abs(dEle) : 0);
  }

  for (const coord of coords) {
    if (coord[2] > hi) hi = coord[2];
    if (coord[2] < lo) lo = coord[2];
  }

  return {
    dist,
    gain,
    loss,
    hi: Math.round(hi),
    lo: Math.round(lo),
  };
}

/**
 * Sample cumulative stats at playback progress.
 * progress = 0 or 1 returns the full totals so the HUD shows the final values
 * while the route is at rest before playback starts and after it ends.
 * @param {{ dist: Float64Array, gain: Float64Array, loss: Float64Array, hi: number, lo: number }} profile
 * @param {number} progress
 */
export function statsAtProgress(profile, progress) {
  const maxIdx = profile.dist.length - 1;
  if (maxIdx <= 0) {
    return {
      dist: '0.0',
      gain: 0,
      loss: 0,
      hi: profile.hi,
      lo: profile.lo,
    };
  }

  if (progress <= 0 || progress >= 1) {
    return {
      dist: (profile.dist[maxIdx] / 1000).toFixed(1),
      gain: Math.round(profile.gain[maxIdx]),
      loss: Math.round(profile.loss[maxIdx]),
      hi: profile.hi,
      lo: profile.lo,
    };
  }

  const scaled = progress * maxIdx;
  const idx = Math.floor(scaled);
  const t = scaled - idx;

  return {
    dist: (profileValueAt(profile.dist, idx, t) / 1000).toFixed(1),
    gain: Math.round(profileValueAt(profile.gain, idx, t)),
    loss: Math.round(profileValueAt(profile.loss, idx, t)),
    hi: profile.hi,
    lo: profile.lo,
  };
}

/**
 * Compute hiking statistics for an array of [lon, lat, ele] coords.
 * @param {[number, number, number][]} coords
 */
export function calcStats(coords) {
  const profile = buildStatsProfile(coords);
  const last = profile.dist.length - 1;

  return {
    dist: (profile.dist[last] / 1000).toFixed(1),
    gain: Math.round(profile.gain[last]),
    loss: Math.round(profile.loss[last]),
    hi: profile.hi,
    lo: profile.lo,
  };
}

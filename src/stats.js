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

/**
 * Compute hiking statistics for an array of [lon, lat, ele] coords.
 * @param {[number, number, number][]} coords
 */
export function calcStats(coords) {
  let dist = 0;
  let gain = 0;
  let loss = 0;
  let hi = -Infinity;
  let lo = Infinity;

  for (let i = 1; i < coords.length; i++) {
    dist += haversine(coords[i - 1], coords[i]);
    const dEle = coords[i][2] - coords[i - 1][2];
    if (dEle > 0) gain += dEle;
    else loss += Math.abs(dEle);
  }

  for (const c of coords) {
    if (c[2] > hi) hi = c[2];
    if (c[2] < lo) lo = c[2];
  }

  return {
    dist: (dist / 1000).toFixed(1),
    gain: Math.round(gain),
    loss: Math.round(loss),
    hi: Math.round(hi),
    lo: Math.round(lo),
  };
}

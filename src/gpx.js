/**
 * Parse a GPX XML string and return the track name + coordinate array.
 * Each coordinate is [lon, lat, ele].
 */
export function parseGPX(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');

  // Support both namespaced and non-namespaced GPX files
  let pts = [...doc.querySelectorAll('trkpt')];
  if (!pts.length) {
    pts = [...doc.getElementsByTagName('trkpt')];
  }

  const name =
    doc.querySelector('name')?.textContent?.trim() ||
    doc.querySelector('trk > name')?.textContent?.trim() ||
    'GPX Track';

  const coords = pts
    .map((p) => {
      const lat = parseFloat(p.getAttribute('lat'));
      const lon = parseFloat(p.getAttribute('lon'));
      const ele = parseFloat(p.querySelector('ele')?.textContent ?? '0') || 0;
      return /** @type {[number, number, number]} */ ([lon, lat, ele]);
    })
    .filter((c) => !isNaN(c[0]) && !isNaN(c[1]));

  if (coords.length < 2) {
    throw new Error('GPX 文件中没有找到轨迹点（trkpt）');
  }

  return { name, coords };
}

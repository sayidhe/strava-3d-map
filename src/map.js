import maplibregl from 'maplibre-gl';

const MAPTILER_API_KEY      = import.meta.env.VITE_MAPTILER_API_KEY;
const MAPTILER_OUTDOOR_URL      = `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_API_KEY}`;
const MAPTILER_SATELLITE_TILES  = `https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=${MAPTILER_API_KEY}`;

let _currentStyle = 'outdoor'; // 'outdoor' | 'satellite'

/** Compute a camera bearing that points roughly along the track. */
export function trackBearing(coords) {
  if (coords.length < 2) return 0;
  const mid = Math.floor(coords.length / 2);
  const dx = coords[mid][0] - coords[0][0];
  const dy = coords[mid][1] - coords[0][1];
  return -(Math.atan2(dy, dx) * (180 / Math.PI) - 90);
}

/**
 * Recursively replace language-specific name references in a MapLibre expression.
 * Converts `["get", "name:xx"]` → `["coalesce", ["get", "name:zh"], ["get", "name"]]`
 * and plain strings like `"{name:en}"` → `"{name:zh}"`.
 */
function _swapLang(expr) {
  if (Array.isArray(expr)) {
    if (expr[0] === 'get' && typeof expr[1] === 'string' && /^name:[a-z_-]+$/i.test(expr[1])) {
      return ['coalesce', ['get', 'name:zh'], ['get', 'name']];
    }
    return expr.map(_swapLang);
  }
  if (typeof expr === 'string') {
    return expr.replace(/\{name:[^}]+\}/g, '{name:zh}');
  }
  return expr;
}

/** Apply Chinese labels to all symbol layers of a loaded vector style. */
function _applyChineseLabels(map) {
  const style = map.getStyle();
  if (!style) return;
  style.layers.forEach((layer) => {
    if (layer.type !== 'symbol') return;
    const textField = map.getLayoutProperty(layer.id, 'text-field');
    if (!textField) return;
    const updated = _swapLang(textField);
    map.setLayoutProperty(layer.id, 'text-field', updated);
  });
}

/**
 * Toggle between outdoor and satellite map styles.
 * Satellite tiles are overlaid on the outdoor vector style — no setStyle() call,
 * so GPX and flyover layers are never wiped.
 * @param {maplibregl.Map} map
 * @returns {'outdoor'|'satellite'}
 */
export function toggleMapStyle(map) {
  _currentStyle = _currentStyle === 'outdoor' ? 'satellite' : 'outdoor';
  map.setPaintProperty('satellite-layer', 'raster-opacity', _currentStyle === 'satellite' ? 1 : 0);
  return _currentStyle;
}

/**
 * Custom MapLibre control: a vertical pitch slider.
 * Positioned below the NavigationControl (top-left).
 * Moving the thumb up increases pitch (camera tilts toward horizon).
 */
class PitchControl {
  onAdd(map) {
    this._map = map;

    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl pitch-ctrl';
    this._container.title = '相机仰角';

    this._input = document.createElement('input');
    this._input.type  = 'range';
    this._input.min   = '0';
    this._input.max   = '85';
    this._input.step  = '1';
    this._input.value = String(Math.round(map.getPitch()));
    this._container.appendChild(this._input);

    this._input.addEventListener('input', () => {
      map.easeTo({ pitch: +this._input.value, duration: 0 });
    });

    // Keep slider in sync when pitch is changed by other means (flyover, nav-ctrl, etc.)
    this._onPitch = () => {
      this._input.value = String(Math.round(map.getPitch()));
    };
    map.on('pitch', this._onPitch);

    return this._container;
  }

  onRemove() {
    this._map.off('pitch', this._onPitch);
    this._container.parentNode?.removeChild(this._container);
    this._map = null;
  }
}

/**
 * Initialise MapLibre and return the map instance.
 * @param {string} containerId
 * @returns {maplibregl.Map}
 */
export function createMap(containerId) {
  const map = new maplibregl.Map({
    container: containerId,
    style: MAPTILER_OUTDOOR_URL,
    center: [104, 35],
    zoom: 4,
    pitch: 40,
    bearing: -20,
    antialias: true,
    // Large cache so tiles loaded during a flyover stay resident for replays.
    maxTileCacheSize: 1000,
  });

  map.once('style.load', () => {
    _applyChineseLabels(map);

    // --- Terrain DEM source ---
    map.addSource('terrain-dem', {
      type: 'raster-dem',
      url: 'https://api.maptiler.com/tiles/terrain-rgb/tiles.json?key=' + MAPTILER_API_KEY,
      tileSize: 256,
      maxzoom: 13,
      attribution: '\u00a9 MapTiler',
    });
    map.setTerrain({ source: 'terrain-dem', exaggeration: 1.0 });

    // --- Hillshade DEM source ---
    map.addSource('hillshade-dem', {
      type: 'raster-dem',
      url: 'https://api.maptiler.com/tiles/terrain-rgb/tiles.json?key=' + MAPTILER_API_KEY,
      tileSize: 256,
      maxzoom: 13,
      attribution: '\u00a9 MapTiler',
    });


    // 添加 satellite source 和 layer（只添加一次）
    if (!map.getSource('maptiler-satellite')) {
      map.addSource('maptiler-satellite', {
        type: 'raster',
        tiles: [MAPTILER_SATELLITE_TILES],
        tileSize: 256,
        maxzoom: 20,
        attribution: '\u00a9 MapTiler \u00a9 Maxar',
      });
    }
    if (!map.getLayer('satellite-layer')) {
      map.addLayer({ id: 'satellite-layer', type: 'raster', source: 'maptiler-satellite',
        // fade-duration:0 — tiles appear instantly, eliminating mid-animation flicker.
        paint: { 'raster-opacity': 0, 'raster-fade-duration': 0 } });
    }

    // 添加 hillshade 图层（不指定 before，默认加到最上层）
    if (!map.getLayer('custom-hillshade')) {
      map.addLayer({
        id: 'custom-hillshade',
        type: 'hillshade',
        source: 'hillshade-dem',
        layout: {},
        paint: {},
      });
    }
  });
  map.addControl(
    new maplibregl.NavigationControl({ visualizePitch: true }),
    'top-left',
  );
  map.addControl(new PitchControl(), 'top-left');

  return map;
}

const SOURCE_LINE = 'gpx-line';
const SOURCE_PTS = 'gpx-points';
const LAYERS = ['gpx-glow', 'gpx-track', 'gpx-start', 'gpx-end'];

// Track gradient for dark background (white highlight mid-point)
const GRADIENT_DARK = [
  'interpolate', ['linear'], ['line-progress'],
  0,    '#fc4c02',
  0.25, '#f5a623',
  0.5,  '#ffffff',
  0.75, '#f5a623',
  1,    '#fc4c02',
];

/** Remove any previously rendered GPX layers/sources. */
function clearOldTrack(map) {
  LAYERS.forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
  [SOURCE_LINE, SOURCE_PTS].forEach((id) => { if (map.getSource(id)) map.removeSource(id); });
}

/**
 * Render a GPX track on the map with Strava-style styling.
 * @param {maplibregl.Map} map
 * @param {[number, number, number][]} coords
 */
export function renderTrack(map, coords, { fit = true } = {}) {
  clearOldTrack(map);

  map.addSource(SOURCE_LINE, {
    type: 'geojson',
    lineMetrics: true,          // required for line-gradient
    data: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords.map((c) => [c[0], c[1]]) },
    },
  });

  map.addSource(SOURCE_PTS, {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { role: 'start' },
          geometry: { type: 'Point', coordinates: coords[0].slice(0, 2) } },
        { type: 'Feature', properties: { role: 'end' },
          geometry: { type: 'Point', coordinates: coords[coords.length - 1].slice(0, 2) } },
      ],
    },
  });

  // Outer glow
  map.addLayer({
    id: 'gpx-glow',
    type: 'line',
    source: SOURCE_LINE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#fc4c02',
      'line-width': 20,
      'line-opacity': 0.16,
      'line-blur': 10,
    },
  });

  // Main gradient track
  map.addLayer({
    id: 'gpx-track',
    type: 'line',
    source: SOURCE_LINE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-width': 4,
      'line-gradient': GRADIENT_DARK,
      'line-opacity': 0.95,
    },
  });

  // Start marker (green)
  map.addLayer({
    id: 'gpx-start',
    type: 'circle',
    source: SOURCE_PTS,
    filter: ['==', ['get', 'role'], 'start'],
    paint: {
      'circle-color': '#2ecc71',
      'circle-radius': 5,
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 1.5,
    },
  });

  // End marker (orange)
  map.addLayer({
    id: 'gpx-end',
    type: 'circle',
    source: SOURCE_PTS,
    filter: ['==', ['get', 'role'], 'end'],
    paint: {
      'circle-color': '#fc4c02',
      'circle-radius': 5,
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 1.5,
    },
  });

  // Fit the full bounding box. pitch:0 + generous padding = whole route always visible.
  if (!fit) return;
  const lons = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  const bounds = [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
  map.fitBounds(bounds, {
    padding: { top: 150, bottom: 290, left: 100, right: 100 },
    pitch: 0,
    bearing: 0,
    duration: 1800,
    maxZoom: 14,
  });
}

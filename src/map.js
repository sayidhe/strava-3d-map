import maplibregl from 'maplibre-gl';

/** Compute a camera bearing that points roughly along the track. */
export function trackBearing(coords) {
  if (coords.length < 2) return 0;
  const mid = Math.floor(coords.length / 2);
  const dx = coords[mid][0] - coords[0][0];
  const dy = coords[mid][1] - coords[0][1];
  return -(Math.atan2(dy, dx) * (180 / Math.PI) - 90);
}

/**
 * Outdoor topo style: OpenTopoMap (contour lines, hillshade baked in, trail markings)
 * + a single DEM source used only for 3-D terrain extrusion.
 * No separate hillshade layer — OpenTopoMap already contains it, adding another
 * hillshade pass causes ghost/double-image artifacts and white edges on water bodies.
 *
 * @param {'dark'|'light'} theme
 */
function buildStyle(theme = 'dark') {
  const isDark = theme === 'dark';
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      // Outdoor topo raster — hillshade already baked in
      topo: {
        type: 'raster',
        tiles: ['https://tile.opentopomap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 17,
        attribution:
          '© <a href="https://opentopomap.org">OpenTopoMap</a> · © OpenStreetMap contributors',
      },
      // DEM used exclusively for 3-D terrain extrusion
      'dem-terrain': {
        type: 'raster-dem',
        tiles: [
          'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        maxzoom: 15,
        encoding: 'terrarium',
        attribution: '© Mapzen · USGS · SRTM',
      },
    },
    terrain: {
      source: 'dem-terrain',
      exaggeration: 1.1,
    },
    layers: [
      // Topo base
      {
        id: 'topo-layer',
        type: 'raster',
        source: 'topo',
        paint: isDark ? {
          'raster-opacity': 0.72,
          'raster-brightness-min': 0.0,
          'raster-brightness-max': 0.55,
          'raster-saturation': -0.35,
          'raster-contrast': 0.1,
        } : {
          'raster-opacity': 1.0,
          'raster-brightness-min': 0.05,
          'raster-brightness-max': 1.0,
          'raster-saturation': -0.1,
          'raster-contrast': 0.05,
        },
      },
      // Dark overlay (dark theme only)
      ...( isDark ? [{
        id: 'dark-overlay',
        type: 'background',
        paint: {
          'background-color': '#0d0d0d',
          'background-opacity': 0.38,
        },
      }] : []),
    ],
  };
}

let _currentTheme = 'dark';

// Paint configs keyed by style id
const STYLE_CONFIGS = {
  dark: {
    rasterOpacity: 0.72, brightnessMin: 0.0, brightnessMax: 0.55,
    saturation: -0.35, contrast: 0.1, darkOverlay: true,
  },
  light: {
    rasterOpacity: 1.0, brightnessMin: 0.05, brightnessMax: 1.0,
    saturation: -0.1, contrast: 0.05, darkOverlay: false,
  },
  satellite: null, // satellite uses a different source — handled separately
};

/**
 * Switch to a named map style: 'dark' | 'light' | 'satellite'.
 * Uses setPaintProperty to avoid full setStyle rebuilds.
 * @param {maplibregl.Map} map
 * @param {'dark'|'light'|'satellite'} styleId
 * @returns {'dark'|'light'|'satellite'}
 */
export function setMapStyle(map, styleId) {
  const prev = _currentTheme;
  _currentTheme = styleId;

  const enterSat  = styleId === 'satellite';
  const leaveSat  = prev === 'satellite';

  if (enterSat) {
    // Hide topo, show satellite
    if (map.getLayer('topo-layer'))      map.setLayoutProperty('topo-layer', 'visibility', 'none');
    if (map.getLayer('dark-overlay'))    map.removeLayer('dark-overlay');
    if (!map.getSource('satellite')) {
      map.addSource('satellite', {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256, maxzoom: 19,
        attribution: '© Esri · Maxar · Earthstar Geographics',
      });
    }
    if (!map.getLayer('satellite-layer')) {
      map.addLayer({ id: 'satellite-layer', type: 'raster', source: 'satellite',
        paint: { 'raster-opacity': 1 } }, 'topo-layer');
    } else {
      map.setLayoutProperty('satellite-layer', 'visibility', 'visible');
    }
  } else {
    // Show topo, hide satellite
    if (map.getLayer('satellite-layer')) map.setLayoutProperty('satellite-layer', 'visibility', 'none');
    if (map.getLayer('topo-layer'))      map.setLayoutProperty('topo-layer', 'visibility', 'visible');

    const cfg = STYLE_CONFIGS[styleId];
    map.setPaintProperty('topo-layer', 'raster-opacity',        cfg.rasterOpacity);
    map.setPaintProperty('topo-layer', 'raster-brightness-min', cfg.brightnessMin);
    map.setPaintProperty('topo-layer', 'raster-brightness-max', cfg.brightnessMax);
    map.setPaintProperty('topo-layer', 'raster-saturation',     cfg.saturation);
    map.setPaintProperty('topo-layer', 'raster-contrast',       cfg.contrast);

    if (cfg.darkOverlay) {
      if (!map.getLayer('dark-overlay')) {
        map.addLayer({ id: 'dark-overlay', type: 'background',
          paint: { 'background-color': '#0d0d0d', 'background-opacity': 0.38 } }, 'topo-layer');
      }
    } else {
      if (map.getLayer('dark-overlay')) map.removeLayer('dark-overlay');
    }
  }

  // Track gradient: use high-contrast colours for satellite & light
  const useLightGradient = styleId === 'light' || styleId === 'satellite';
  if (map.getLayer('gpx-track')) {
    map.setPaintProperty('gpx-track', 'line-gradient', useLightGradient ? GRADIENT_LIGHT : GRADIENT_DARK);
  }

  return _currentTheme;
}

/** @deprecated use setMapStyle */
export function toggleMapTheme(map) {
  const next = _currentTheme === 'dark' ? 'light' : 'dark';
  return setMapStyle(map, next);
}

/**
 * Initialise MapLibre and return the map instance.
 * @param {string} containerId
 * @returns {maplibregl.Map}
 */
export function createMap(containerId) {
  const map = new maplibregl.Map({
    container: containerId,
    style: buildStyle(),
    center: [104, 35],
    zoom: 4,
    pitch: 40,
    bearing: -20,
    antialias: true,
  });

  map.addControl(
    new maplibregl.NavigationControl({ visualizePitch: true }),
    'top-left',
  );

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

// Track gradient for light background (no white — deep orange → red)
const GRADIENT_LIGHT = [
  'interpolate', ['linear'], ['line-progress'],
  0,    '#c0392b',
  0.25, '#e74c3c',
  0.5,  '#fc4c02',
  0.75, '#e74c3c',
  1,    '#c0392b',
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
export function renderTrack(map, coords) {
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
      'line-gradient': _currentTheme === 'light' ? GRADIENT_LIGHT : GRADIENT_DARK,
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
      'circle-radius': 8,
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 2,
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
      'circle-radius': 8,
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 2,
    },
  });

  // Fit the full bounding box. pitch:0 + generous padding = whole route always visible.
  const lons = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  const bounds = [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
  map.fitBounds(bounds, {
    padding: { top: 180, bottom: 220, left: 100, right: 100 },
    pitch: 0,
    bearing: 0,
    duration: 1800,
    maxZoom: 14,
  });
}

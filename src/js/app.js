// OSM Layercake Extract — Main application
// MapLibre GL map with India boundary corrected OSM tiles + download panel

import {
  GeoParquetExtractor,
  MetadataProvider,
  ExtentData,
  initDuckDB,
  formatSize,
  getStorageEstimate,
} from 'geoparquet-extractor';

import { registerCorrectionProtocol } from '@india-boundary-corrector/maplibre-protocol';

const DUCKDB_DIST = 'https://cdn.jsdelivr.net/npm/duckdb-wasm-opfs-tempdir@1.33.0/dist';
const METADATA_URL = 'https://data.openstreetmap.us/layercake/metadata.json';

// Derive gpkg worker URL from the library's import map entry.
const _libUrl = import.meta.resolve('geoparquet-extractor');
const _libVersion = _libUrl.match(/@([\d.]+)/)?.[1];
const GPKG_WORKER_URL = _libVersion
  ? `https://cdn.jsdelivr.net/npm/geoparquet-extractor@${_libVersion}/dist/gpkg_worker.js`
  : new URL('gpkg_worker.js', _libUrl).href;

const DATASETS = {
  buildings: {
    name: 'Buildings',
    url: 'https://data.openstreetmap.us/layercake/buildings.parquet',
    description: 'Building outlines with height, levels, materials, addresses, roof details, accessibility.',
    size: '611M features, ~74 GiB',
  },
  highways: {
    name: 'Highways',
    url: 'https://data.openstreetmap.us/layercake/highways.parquet',
    description: 'Road network with surface type, lanes, speed limits, access restrictions, bridge/tunnel info.',
    size: '260M features, ~52 GiB',
  },
  boundaries: {
    name: 'Boundaries',
    url: 'https://data.openstreetmap.us/layercake/boundaries.parquet',
    description: 'Administrative boundaries with multilingual names and official/alternate name variants.',
    size: '~1.8 GiB',
  },
  parks: {
    name: 'Parks',
    url: 'https://data.openstreetmap.us/layercake/parks.parquet',
    description: 'Parks, protected areas and leisure areas with boundaries, access and protection details.',
    size: '~0.6 GiB',
  },
  settlements: {
    name: 'Settlements',
    url: 'https://data.openstreetmap.us/layercake/settlements.parquet',
    description: 'Settlement points (cities, towns, villages, hamlets) with multilingual names and population data.',
    size: '~0.2 GiB',
  },
};

// Memory config: 50% of device RAM, clamped to [512MB, maxMB], step 128MB
const MEMORY_STEP = 128;
const MEMORY_MIN_MB = 512;

function getDeviceMaxMemoryMB() {
  const deviceMemGB = navigator.deviceMemory || 4;
  return Math.max(MEMORY_MIN_MB, Math.floor(deviceMemGB * 1024 * 0.75 / MEMORY_STEP) * MEMORY_STEP);
}

function getDefaultMemoryLimitMB() {
  const deviceMemGB = navigator.deviceMemory || 4;
  const halfMB = Math.floor(deviceMemGB * 1024 * 0.5 / MEMORY_STEP) * MEMORY_STEP;
  return Math.max(MEMORY_MIN_MB, Math.min(halfMB, getDeviceMaxMemoryMB()));
}

function formatMemory(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

const FORMAT_LABELS = {
  geojson: 'GeoJSON',
  geojsonseq: 'GeoJSONSeq',
  geoparquet: 'GeoParquet v1.1',
  geoparquet2: 'GeoParquet v2.0',
  geopackage: 'GeoPackage',
  csv: 'CSV',
  shapefile: 'Shapefile',
  kml: 'KML',
  dxf: 'DXF',
};

// --- DOM references ---

const datasetSelect = document.getElementById('dataset-select');
const datasetInfo = document.getElementById('dataset-info');
const bboxDisplay = document.getElementById('bbox-display');
const formatSelect = document.getElementById('format-select');
const memorySlider = document.getElementById('memory-slider');
const memoryValue = document.getElementById('memory-value');
const downloadBtn = document.getElementById('download-btn');
const cancelBtn = document.getElementById('cancel-btn');
const progressContainer = document.getElementById('progress-container');
const downloadInfo = document.getElementById('download-info');
const progressBar = document.getElementById('progress-bar');
const statusText = document.getElementById('status-text');
const panelToggle = document.getElementById('panel-toggle');
const panel = document.getElementById('panel');
const extentsCheckbox = document.getElementById('show-extents');
const extentsStatus = document.getElementById('extents-status');
const flattenStructsCheckbox = document.getElementById('flatten-structs');

// --- URL state (layer stored in hash alongside MapLibre's map= param) ---

function getHashParams() {
  return new URLSearchParams(window.location.hash.substring(1));
}

function setHashParam(key, value) {
  const params = getHashParams();
  params.set(key, value);
  const newHash = '#' + params.toString().replaceAll('%2F', '/');
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${newHash}`);
}

const initialLayer = getHashParams().get('layer');
if (initialLayer && DATASETS[initialLayer]) {
  datasetSelect.value = initialLayer;
}

function updateLayerParam() {
  setHashParam('layer', datasetSelect.value);
}
updateLayerParam();

// --- Map initialization ---

registerCorrectionProtocol(maplibregl);

const map = new maplibregl.Map({
  container: 'map',
  hash: 'map',
  style: {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      'osm-carto': {
        type: 'raster',
        tiles: [
          'ibc://https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'ibc://https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'ibc://https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    },
    layers: [
      { id: 'osm-carto', type: 'raster', source: 'osm-carto' },
    ],
  },
  center: [79, 22],
  zoom: 4,
  attributionControl: false,
});

map.addControl(new maplibregl.AttributionControl(), 'bottom-left');
map.addControl(new maplibregl.NavigationControl({ showCompass: false }));

// --- Extractor (lazy-initialized on first download) ---

let extractor = null;
let duckdbPromise = null;

// Clean up orphaned OPFS files from previous sessions
GeoParquetExtractor.cleanupOrphanedFiles();

// --- Data timestamp ---

fetch(METADATA_URL)
  .then(r => r.json())
  .then(meta => {
    if (meta.timestamp) {
      const date = new Date(meta.timestamp).toLocaleDateString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
      });
      document.getElementById('data-timestamp').textContent = `Data as of: ${date}`;
    }
  })
  .catch(() => {});

// --- Memory slider setup ---

memorySlider.min = String(MEMORY_MIN_MB);
memorySlider.max = String(getDeviceMaxMemoryMB());
memorySlider.step = String(MEMORY_STEP);
memorySlider.value = String(getDefaultMemoryLimitMB());

function updateMemoryDisplay() {
  memoryValue.textContent = formatMemory(parseInt(memorySlider.value));
}
updateMemoryDisplay();
memorySlider.addEventListener('input', updateMemoryDisplay);

// --- Dataset info ---

function updateDatasetInfo() {
  const ds = DATASETS[datasetSelect.value];
  datasetInfo.innerHTML = `<span class="ds-size">${ds.size}</span><br>${ds.description}`;
}
updateDatasetInfo();
datasetSelect.addEventListener('change', () => {
  updateDatasetInfo();
  updateLayerParam();
});

// --- Bbox display ---

function updateBbox() {
  const b = map.getBounds();
  const w = b.getWest().toFixed(5);
  const s = b.getSouth().toFixed(5);
  const e = b.getEast().toFixed(5);
  const n = b.getNorth().toFixed(5);
  bboxDisplay.innerHTML = `<span class="bbox-w">${w}</span>, <span class="bbox-s">${s}</span> → <span class="bbox-e">${e}</span>, <span class="bbox-n">${n}</span>`;
}
updateBbox();
map.on('moveend', updateBbox);

// --- Panel toggle ---

const isMobile = () => window.matchMedia('(max-width: 600px)').matches;

function updateToggleIcon() {
  const collapsed = panel.classList.contains('collapsed');
  panelToggle.textContent = isMobile()
    ? (collapsed ? '▲' : '▼')
    : (collapsed ? '◀' : '▶');
}

panelToggle.addEventListener('click', () => {
  panel.classList.toggle('collapsed');
  updateToggleIcon();
  setTimeout(() => map.resize(), 300);
});

// Keep toggle icon correct when switching between mobile/desktop
window.matchMedia('(max-width: 600px)').addEventListener('change', updateToggleIcon);
updateToggleIcon();

// --- Download ---

function setDownloading(active) {
  downloadBtn.disabled = active;
  cancelBtn.style.display = active ? 'inline-block' : 'none';
  progressContainer.style.display = active ? 'block' : 'none';
  datasetSelect.disabled = active;
  formatSelect.disabled = active;
  memorySlider.disabled = active;
  flattenStructsCheckbox.disabled = active;
}

downloadBtn.addEventListener('click', async () => {
  const dsKey = datasetSelect.value;
  const ds = DATASETS[dsKey];
  const format = formatSelect.value;

  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  console.log('Download bbox:', bbox);

  const memMB = parseInt(memorySlider.value);

  setDownloading(true);
  progressBar.style.width = '0%';

  const flattenStructs = flattenStructsCheckbox.checked;
  const bboxStr = `${bbox[0].toFixed(4)}, ${bbox[1].toFixed(4)} → ${bbox[2].toFixed(4)}, ${bbox[3].toFixed(4)}`;
  downloadInfo.innerHTML =
    `<b>${ds.name}</b><br>` +
    `<span class="info-detail">Format: ${FORMAT_LABELS[format] || format}</span><br>` +
    `<span class="info-detail">Bbox: ${bboxStr}</span><br>` +
    `<span class="info-detail">Memory: ${formatMemory(memMB)}</span><br>` +
    `<span class="info-detail">Flatten structs: ${flattenStructs ? 'Yes' : 'No'}</span>`;

  const onProgress = (pct) => { progressBar.style.width = `${pct}%`; };
  const onStatus = (msg) => {
    statusText.textContent = msg;
    statusText.classList.remove('error');
  };

  try {
    // Lazy-init DuckDB and extractor on first download
    if (!extractor) {
      onStatus('Initializing DuckDB WASM...');
      if (!duckdbPromise) duckdbPromise = initDuckDB(DUCKDB_DIST);
      const duckdb = await duckdbPromise;
      extractor = new GeoParquetExtractor({
        duckdb,
        metadataProvider: new MetadataProvider(),
        gpkgWorkerUrl: GPKG_WORKER_URL,
      });
    }

    const formatHandler = await extractor.prepare({
      sourceUrl: ds.url,
      bbox,
      format,
      memoryLimitMB: memMB,
      flattenStructs,
      onProgress,
      onStatus,
    });

    // Check storage availability
    const browserUsage = formatHandler.getExpectedBrowserStorageUsage();
    const { usage, quota } = await getStorageEstimate();
    const available = quota - usage;

    onStatus(
      `Browser storage — expected: ${formatSize(browserUsage)}, available: ${formatSize(available)}`
    );

    if (browserUsage > available) {
      const totalDisk = formatHandler.getTotalExpectedDiskUsage();
      const msg = `Expected browser storage usage (${formatSize(browserUsage)}) exceeds available browser storage (${formatSize(available)}).\nTotal disk usage: ${formatSize(totalDisk)}.\nContinue anyway?`;
      if (!confirm(msg)) {
        setDownloading(false);
        statusText.textContent = 'Cancelled';
        setTimeout(() => { statusText.textContent = ''; downloadInfo.innerHTML = ''; }, 2000);
        return;
      }
    }

    const formatWarning = formatHandler.getFormatWarning?.();
    if (formatWarning) {
      if (formatWarning.isBlocking) {
        alert(formatWarning.message);
        setDownloading(false);
        statusText.textContent = 'Cancelled';
        setTimeout(() => { statusText.textContent = ''; downloadInfo.innerHTML = ''; }, 2000);
        return;
      }
      if (!confirm(formatWarning.message + '\n\nContinue anyway?')) {
        setDownloading(false);
        statusText.textContent = 'Cancelled';
        setTimeout(() => { statusText.textContent = ''; downloadInfo.innerHTML = ''; }, 2000);
        return;
      }
    }

    const baseName = GeoParquetExtractor.getDownloadBaseName(`layercake_${ds.name}`, bbox);
    await extractor.download(formatHandler, { baseName, onProgress, onStatus });

    statusText.textContent = 'Complete!';
    setTimeout(() => {
      setDownloading(false);
      statusText.textContent = '';
      downloadInfo.innerHTML = '';
      progressBar.style.width = '0%';
    }, 2500);

  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error('Download failed:', error);
      statusText.textContent = `Error: ${error.message}`;
      statusText.classList.add('error');
    } else {
      statusText.textContent = 'Cancelled';
    }
    setTimeout(() => {
      setDownloading(false);
      statusText.textContent = '';
      statusText.classList.remove('error');
      downloadInfo.innerHTML = '';
      progressBar.style.width = '0%';
    }, 3000);
  }
});

cancelBtn.addEventListener('click', () => {
  extractor?.cancel();
  statusText.textContent = 'Cancelling after current operation…';
});

// --- Extent visualization ---

const EXTENT_CONFIGS = {
  data: {
    sourceId: 'data-extents',
    labelSourceId: 'data-extents-labels-src',
    fillLayer: 'data-extents-fill',
    lineLayer: 'data-extents-line',
    labelLayer: 'data-extents-labels',
    fillColor: 'rgba(255, 152, 0, 0.12)',
    fillHoverColor: 'rgba(255, 152, 0, 0.35)',
    lineColor: 'rgba(255, 152, 0, 0.8)',
    lineHoverColor: 'rgba(255, 200, 0, 1)',
    textColor: '#FF9800',
  },
  rg: {
    sourceId: 'rg-extents',
    labelSourceId: 'rg-extents-labels-src',
    fillLayer: 'rg-extents-fill',
    lineLayer: 'rg-extents-line',
    labelLayer: 'rg-extents-labels',
    fillColor: 'rgba(0, 188, 212, 0.10)',
    fillHoverColor: 'rgba(0, 188, 212, 0.30)',
    lineColor: 'rgba(0, 188, 212, 0.7)',
    lineHoverColor: 'rgba(0, 230, 255, 1)',
    textColor: '#00BCD4',
  },
};

let extentData = null;
let extentDuckdb = null;
let extentDuckdbPromise = null;
let extentLoading = false;
const extentHoverHandlers = [];
const extentHoveredFeatures = new Map();

function extentsToGeoJSON(extents) {
  const emptyFC = { type: 'FeatureCollection', features: [] };
  if (!extents) return { polygons: emptyFC, labelPoints: emptyFC };
  const polyFeatures = [];
  const labelFeatures = [];
  for (const [name, bbox] of Object.entries(extents)) {
    const [minx, miny, maxx, maxy] = bbox;
    const label = name.replace('rg_', '');
    polyFeatures.push({
      type: 'Feature',
      properties: { name, label },
      geometry: {
        type: 'Polygon',
        coordinates: [[[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy], [minx, miny]]],
      },
    });
    labelFeatures.push({
      type: 'Feature',
      properties: { label },
      geometry: { type: 'Point', coordinates: [minx, maxy] },
    });
  }
  return {
    polygons: { type: 'FeatureCollection', features: polyFeatures },
    labelPoints: { type: 'FeatureCollection', features: labelFeatures },
  };
}

function flattenRgExtents(rgExtents) {
  if (!rgExtents) return null;
  const flat = {};
  for (const rgGroups of Object.values(rgExtents)) {
    for (const [rgKey, bbox] of Object.entries(rgGroups)) {
      flat[rgKey] = bbox;
    }
  }
  return Object.keys(flat).length ? flat : null;
}

function addExtentLayer(cfg, extents) {
  const { polygons, labelPoints } = extentsToGeoJSON(extents);
  map.addSource(cfg.sourceId, { type: 'geojson', data: polygons, generateId: true });
  map.addLayer({
    id: cfg.fillLayer, type: 'fill', source: cfg.sourceId,
    paint: {
      'fill-color': ['case', ['boolean', ['feature-state', 'hover'], false],
        cfg.fillHoverColor, cfg.fillColor],
    },
  });
  map.addLayer({
    id: cfg.lineLayer, type: 'line', source: cfg.sourceId,
    paint: {
      'line-color': ['case', ['boolean', ['feature-state', 'hover'], false],
        cfg.lineHoverColor, cfg.lineColor],
      'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2.5, 1.5],
    },
  });
  if (labelPoints.features.length > 1) {
    map.addSource(cfg.labelSourceId, { type: 'geojson', data: labelPoints });
    map.addLayer({
      id: cfg.labelLayer, type: 'symbol', source: cfg.labelSourceId,
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 11,
        'text-anchor': 'top-left',
        'text-offset': [0.3, 0.3],
        'text-allow-overlap': true,
        'text-font': ['Open Sans Semibold'],
      },
      paint: {
        'text-color': cfg.textColor,
        'text-halo-color': 'rgba(0, 0, 0, 0.7)',
        'text-halo-width': 1,
      },
    });
  }
  addExtentHoverHandlers(cfg);
}

function removeExtentLayer(cfg) {
  for (const layer of [cfg.labelLayer, cfg.lineLayer, cfg.fillLayer]) {
    if (map.getLayer(layer)) map.removeLayer(layer);
  }
  for (const src of [cfg.labelSourceId, cfg.sourceId]) {
    if (map.getSource(src)) map.removeSource(src);
  }
}

function addExtentHoverHandlers(cfg) {
  const onMove = (e) => {
    const features = map.queryRenderedFeatures(e.point, { layers: [cfg.fillLayer] });
    const prevIds = extentHoveredFeatures.get(cfg.sourceId) || new Set();
    const nextIds = new Set(features.map(f => f.id));
    for (const id of prevIds) {
      if (!nextIds.has(id)) map.setFeatureState({ source: cfg.sourceId, id }, { hover: false });
    }
    for (const id of nextIds) {
      if (!prevIds.has(id)) map.setFeatureState({ source: cfg.sourceId, id }, { hover: true });
    }
    extentHoveredFeatures.set(cfg.sourceId, nextIds);
  };
  const onLeave = () => {
    const prevIds = extentHoveredFeatures.get(cfg.sourceId);
    if (prevIds) {
      for (const id of prevIds) map.setFeatureState({ source: cfg.sourceId, id }, { hover: false });
      extentHoveredFeatures.delete(cfg.sourceId);
    }
  };
  map.on('mousemove', cfg.fillLayer, onMove);
  map.on('mouseleave', cfg.fillLayer, onLeave);
  extentHoverHandlers.push({ layer: cfg.fillLayer, onMove, onLeave });
}

function removeAllExtents() {
  for (const { layer, onMove, onLeave } of extentHoverHandlers) {
    map.off('mousemove', layer, onMove);
    map.off('mouseleave', layer, onLeave);
  }
  extentHoverHandlers.length = 0;
  extentHoveredFeatures.clear();
  for (const cfg of Object.values(EXTENT_CONFIGS)) {
    removeExtentLayer(cfg);
  }
}

function cancelExtentFetch() {
  if (extentDuckdb) {
    extentDuckdb.terminate();
    extentDuckdb = null;
  }
  extentData = null;
  extentDuckdbPromise = null;
  extentLoading = false;
  extentsCheckbox.disabled = false;
  extentsStatus.textContent = '';
}

async function showExtents() {
  removeAllExtents();
  extentsCheckbox.disabled = true;
  extentsStatus.textContent = 'Loading…';
  extentLoading = true;

  try {
    if (!map.isStyleLoaded()) {
      await new Promise(resolve => map.once('load', resolve));
    }

    if (!extentDuckdbPromise) extentDuckdbPromise = initDuckDB(DUCKDB_DIST);
    const duckdb = await extentDuckdbPromise;
    extentDuckdb = duckdb;
    extentData = new ExtentData({
      metadataProvider: new MetadataProvider(),
      duckdb,
    });

    const ds = DATASETS[datasetSelect.value];
    const { dataExtents, rgExtents } = await extentData.fetchExtents({
      sourceUrl: ds.url,
      partitioned: false,
      bboxColumn: 'bbox',
      onStatus: (msg) => { extentsStatus.textContent = msg; },
    });

    const flatRg = flattenRgExtents(rgExtents);
    if (flatRg) addExtentLayer(EXTENT_CONFIGS.rg, flatRg);
    if (dataExtents) addExtentLayer(EXTENT_CONFIGS.data, dataExtents);
    extentsStatus.textContent = '';

  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error('Failed to show extents:', error);
    extentsStatus.textContent = 'Error loading extents';
  } finally {
    extentLoading = false;
    extentsCheckbox.disabled = false;
  }
}

extentsCheckbox.addEventListener('change', async () => {
  if (extentsCheckbox.checked) {
    await showExtents();
  } else {
    removeAllExtents();
    extentsStatus.textContent = '';
  }
});

datasetSelect.addEventListener('change', () => {
  if (extentLoading) cancelExtentFetch();
  removeAllExtents();
  extentsCheckbox.checked = false;
  extentsStatus.textContent = '';
});

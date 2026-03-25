// OSM Layercake Extract — Main application
// Leaflet map with India boundary corrected OSM tiles + download panel

import {
  GeoParquetExtractor,
  MetadataProvider,
  initDuckDB,
  formatSize,
  getStorageEstimate,
} from 'geoparquet-extractor';

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

// --- Map initialization ---

IndiaBoundaryCorrector.extendLeaflet(L);

const map = L.map('map', {
  center: [22, 79],
  zoom: 5,
  zoomControl: true,
  attributionControl: false,
});

L.control.attribution({ position: 'bottomleft' }).addTo(map);

L.tileLayer.indiaBoundaryCorrected('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

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
datasetSelect.addEventListener('change', updateDatasetInfo);

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

panelToggle.addEventListener('click', () => {
  panel.classList.toggle('collapsed');
  panelToggle.textContent = panel.classList.contains('collapsed') ? '◀' : '▶';
  setTimeout(() => map.invalidateSize(), 300);
});

// --- Download ---

function setDownloading(active) {
  downloadBtn.disabled = active;
  cancelBtn.style.display = active ? 'inline-block' : 'none';
  progressContainer.style.display = active ? 'block' : 'none';
  datasetSelect.disabled = active;
  formatSelect.disabled = active;
  memorySlider.disabled = active;
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

  const bboxStr = `${bbox[0].toFixed(4)}, ${bbox[1].toFixed(4)} → ${bbox[2].toFixed(4)}, ${bbox[3].toFixed(4)}`;
  downloadInfo.innerHTML =
    `<b>${ds.name}</b><br>` +
    `<span class="info-detail">Format: ${FORMAT_LABELS[format] || format}</span><br>` +
    `<span class="info-detail">Bbox: ${bboxStr}</span><br>` +
    `<span class="info-detail">Memory: ${formatMemory(memMB)}</span>`;

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

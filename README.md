# OSM Layercake Extract

**🌐 [Live Site](https://ramseraph.github.io/osm-layercake-extract/)**

A proof-of-concept that demonstrates extracting large geospatial datasets from remote GeoParquet files entirely in the browser, using OPFS (Origin Private File System) for temporary storage and spill-over.

## How It Works

The app queries remote [OSMUS Layercake](https://openstreetmap.us/our-work/layercake/) GeoParquet files hosted at [data.openstreetmap.us](https://data.openstreetmap.us) using HTTP range requests — only the data matching your bounding box is transferred. All processing happens client-side with no backend involved.

### Available Datasets

| Dataset      | URL |
|--------------|-----|
| Buildings    | `https://data.openstreetmap.us/layercake/buildings.parquet`   |
| Highways     | `https://data.openstreetmap.us/layercake/highways.parquet`    |
| Boundaries   | `https://data.openstreetmap.us/layercake/boundaries.parquet`  |
| Parks        | `https://data.openstreetmap.us/layercake/parks.parquet`       |
| Settlements  | `https://data.openstreetmap.us/layercake/settlements.parquet` |

### Output Formats

- **GeoJSON** (`.geojson`)
- **GeoJSONSeq** (`.geojsonl`) — newline-delimited
- **GeoParquet v1.1** (`.parquet`)
- **GeoParquet v2.0** (`.parquet`)
- **GeoPackage** (`.gpkg`) — with R-tree spatial index
- **CSV** (`.csv`) — with WKT geometry
- **Shapefile** (`.shp`)
- **KML** (`.kml`)
- **DXF** (`.dxf`)

## Key Dependencies

### DuckDB-WASM with OPFS Temp Directory Support

This project uses a custom build of DuckDB-WASM that supports spilling temporary data to OPFS, enabling processing of datasets larger than available memory.

- **Upstream fork**: [dt/duckdb-wasm `opfs-tempdir` branch](https://github.com/dt/duckdb-wasm/tree/opfs-tempdir)
- **Hosted build**: [ramSeraph/duckdb-wasm](https://github.com/ramSeraph/duckdb-wasm) — served from GitHub Pages at `ramseraph.github.io/duckdb-wasm/v1.33.0-opfs-tempdir`

DuckDB's `spatial` extension is loaded at runtime for geometry operations (`ST_AsWKB`, `ST_AsGeoJSON`, `ST_Hilbert`, etc.).

### sqwab — wa-sqlite with R-tree Support

GeoPackage output requires SQLite with R-tree support, which standard wa-sqlite doesn't include. This project uses [ramSeraph/sqwab](https://github.com/ramSeraph/sqwab), a build of wa-sqlite with R-tree enabled, using `OPFSAdaptiveVFS` for file I/O.

GeoPackage generation runs in a dedicated Web Worker that reads an intermediate parquet file (written by DuckDB to OPFS) using [hyparquet](https://github.com/hyparam/hyparquet), then writes the `.gpkg` file with full spatial indexing.

### Other Libraries

- [Apache Arrow](https://arrow.apache.org/) — for columnar data handling
- [Leaflet](https://leafletjs.com/) — map UI and bounding box selection
- [hyparquet](https://github.com/hyparam/hyparquet) — pure-JS parquet reader (used in the GeoPackage worker)

## Architecture

```
Browser
  ├─ Leaflet map (bbox selection)
  ├─ DuckDB-WASM
  │   ├─ HTTP range requests → remote GeoParquet
  │   ├─ Spatial filtering by bounding box
  │   ├─ OPFS temp directory for spill-over
  │   └─ COPY TO OPFS (intermediate or final output)
  └─ GeoPackage Worker (for .gpkg only)
      ├─ hyparquet (reads intermediate parquet from OPFS)
      └─ wa-sqlite/sqwab (writes .gpkg with R-tree index to OPFS)
```

## Data License

The data is sourced from [OpenStreetMap](https://www.openstreetmap.org/) via [OSMUS Layercake](https://openstreetmap.us/our-work/layercake/) and is licensed under the [Open Data Commons Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/). © OpenStreetMap contributors.

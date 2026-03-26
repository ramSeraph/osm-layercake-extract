# OSM Layercake Extract

**🌐 [Live Site](https://ramseraph.github.io/osm-layercake-extract/)**

A browser-based tool for extracting OpenStreetMap data by bounding box from [OSMUS Layercake](https://openstreetmap.us/our-work/layercake/) datasets hosted at [data.openstreetmap.us](https://data.openstreetmap.us).

Built with [geoparquet-extractor](https://github.com/ramSeraph/geoparquet_extractor) — all processing happens client-side using DuckDB-WASM with no backend involved.

## Available Datasets

| Dataset      | URL | Schema |
|--------------|-----|--------|
| Buildings    | `https://data.openstreetmap.us/layercake/buildings.parquet`   | [buildings.py](https://github.com/osmus/layercake/blob/main/src/buildings.py) |
| Highways     | `https://data.openstreetmap.us/layercake/highways.parquet`    | [highways.py](https://github.com/osmus/layercake/blob/main/src/highways.py) |
| Boundaries   | `https://data.openstreetmap.us/layercake/boundaries.parquet`  | [boundaries.py](https://github.com/osmus/layercake/blob/main/src/boundaries.py) |
| Parks        | `https://data.openstreetmap.us/layercake/parks.parquet`       | [parks.py](https://github.com/osmus/layercake/blob/main/src/parks.py) |
| Settlements  | `https://data.openstreetmap.us/layercake/settlements.parquet` | [settlements.py](https://github.com/osmus/layercake/blob/main/src/settlements.py) |

## Output Formats

- **GeoJSON** (`.geojson`)
- **GeoJSONSeq** (`.geojsonl`) — newline-delimited
- **GeoParquet v1.1** (`.parquet`)
- **GeoParquet v2.0** (`.parquet`)
- **GeoPackage** (`.gpkg`) — with R-tree spatial index
- **CSV** (`.csv`) — with WKT geometry
- **Shapefile** (`.shp`)
- **KML** (`.kml`)
- **DXF** (`.dxf`)

## Data License

The data is sourced from [OpenStreetMap](https://www.openstreetmap.org/) via [OSMUS Layercake](https://openstreetmap.us/our-work/layercake/) and is licensed under the [Open Data Commons Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/). © OpenStreetMap contributors.

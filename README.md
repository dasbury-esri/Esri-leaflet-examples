# Esri Leaflet Examples

Static Leaflet mapping samples with a bias toward embed-friendly, practical integrations.

## Repository layout

- `samples/` contains self-contained example apps.
- `scripts/` contains offline helper scripts used to prepare local development artifacts.

The first sample is built for ArcGIS StoryMaps embedding and demonstrates how to work with a live GeoServer WMS layer when direct browser-side WFS access is not viable because of missing CORS support.

## Samples

### Ramsar StoryMap SLD

Path: `samples/ramsar-storymap-sld/`

This sample uses:

- Leaflet for the map runtime
- Esri Leaflet for the ArcGIS-friendly basemap path
- Ramsar GeoServer WMS for live wetland rendering
- an offline-generated local search index for country and wetland lookup

The sample is intentionally static. Live map rendering comes from WMS. Search and best-effort identify use locally hosted helper data derived offline from WFS.

## Local development

Serve the repository from a simple static web server.

Examples:

- `npx serve -l 8123 .`
- `python3 -m http.server`

Then open `samples/ramsar-storymap-sld/` in a browser.

Recommended sample URL for local work:

- `http://127.0.0.1:8123/samples/ramsar-storymap-sld/`

## Sample notes

- The Ramsar server supports WMS styling via `sld` and `sld_body`.
- For local development there is no public hosted SLD URL yet, so the sample is structured to prefer `sld` when configured and otherwise fall back to `sld_body`.
- A precise live browser-side GetFeatureInfo workflow is constrained by missing CORS support on the Ramsar service. The first sample therefore uses a local spatial lookup index for search and best-effort click details while keeping the live overlay authoritative.

## Basemap configuration

The sample includes an Esri Leaflet basemap path and a non-Esri fallback for local testing.

To use an Esri vector basemap without committing credentials:

1. copy `samples/ramsar-storymap-sld/config.local.example.js` to `samples/ramsar-storymap-sld/config.local.js`
2. add your API key in `config.local.js`

`config.local.js` is gitignored and loaded as a local-only runtime override.

## Branch and path conventions

To support multiple sample families with cleaner URLs, use dedicated publish branches and path prefixes.

- Branch for the current Ramsar sample: `esri-leaflet/ramsar-wetlands-explorer`
- D3 sample path convention: `/d3/<sample-name>/`

For GitHub Pages, prefer publishing from the dedicated sample branch rather than from `main` root content when the sample needs its own deployment stream.

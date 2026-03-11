# Plan: Ramsar Wetlands Explorer Publish Layout

## Goal

Publish the Ramsar sample from a dedicated branch and establish stable path conventions for future sample families.

## Branching convention

- Primary branch for this sample deployment: `esri-leaflet/ramsar-wetlands-explorer`
- Keep `main` as the integration/default development branch.
- Use the sample branch as the GitHub Pages publish branch for this sample stream.

## Path convention

- Current sample remains at: `samples/ramsar-storymap-sld/`
- D3 sample family should use: `/d3/<sample-name>/`

## Deployment note

For GitHub Pages, avoid relying on `main` root-only publishing for this sample. Prefer publishing from `esri-leaflet/ramsar-wetlands-explorer` so sample-specific updates can be promoted independently.

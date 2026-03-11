const fs = require("node:fs/promises");
const path = require("node:path");

const WFS_BASE_URL = "https://rsis.ramsar.org/geoserver/ows";
const WFS_TYPENAME = "ramsar_sdi:features_centroid_published";
const PAGE_SIZE = 100;
const OUTPUT_FILE = path.join(process.cwd(), "samples", "ramsar-storymap-sld", "data", "search-index.json");

function visitCoordinates(coordinates, visitor) {
  if (!Array.isArray(coordinates)) {
    return;
  }

  if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
    visitor(coordinates[0], coordinates[1]);
    return;
  }

  for (const child of coordinates) {
    visitCoordinates(child, visitor);
  }
}

function computeBounds(geometry) {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

  visitCoordinates(geometry.coordinates, function (lng, lat) {
    west = Math.min(west, lng);
    south = Math.min(south, lat);
    east = Math.max(east, lng);
    north = Math.max(north, lat);
  });

  return [west, south, east, north];
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function derivePointBbox(lng, lat, areaOff) {
  // Estimate an extent from site area so search zoom has a meaningful footprint.
  const areaSqKm = Math.max((Number(areaOff) || 0) * 0.01, 1);
  const radiusKm = Math.sqrt(areaSqKm / Math.PI);
  const radiusDegLat = clamp(radiusKm / 111.32, 0.05, 2.5);
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.2);
  const radiusDegLng = clamp(radiusDegLat / cosLat, 0.05, 2.5);

  return [lng - radiusDegLng, lat - radiusDegLat, lng + radiusDegLng, lat + radiusDegLat];
}

function toSlug(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function createRequestUrl(startIndex, count) {
  const url = new URL(WFS_BASE_URL);
  url.searchParams.set("service", "WFS");
  url.searchParams.set("version", "2.0.0");
  url.searchParams.set("request", "GetFeature");
  url.searchParams.set("typeName", WFS_TYPENAME);
  url.searchParams.set("outputFormat", "application/json");
  url.searchParams.set("count", String(count));
  url.searchParams.set("startIndex", String(startIndex));
  url.searchParams.set("sortBy", "ramsarid");
  return url;
}

async function fetchJsonRange(startIndex, count) {
  const url = createRequestUrl(startIndex, count);
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`WFS request failed with status ${response.status} at startIndex ${startIndex}`);
  }

  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch (error) {
    if (count === 1) {
      console.warn(`Skipping malformed feature response at startIndex ${startIndex}`);
      return { totalFeatures: null, features: [] };
    }

    const leftCount = Math.floor(count / 2);
    const rightCount = count - leftCount;
    console.warn(`Splitting malformed response range startIndex=${startIndex} count=${count}`);

    const left = await fetchJsonRange(startIndex, leftCount);
    const right = await fetchJsonRange(startIndex + leftCount, rightCount);

    return {
      totalFeatures: left.totalFeatures ?? right.totalFeatures ?? null,
      features: [...left.features, ...right.features],
    };
  }
}

function normalizeFeature(feature) {
  const properties = feature.properties;
  const centroidGeometry = feature.geometry?.type === "Point" ? feature.geometry : null;
  const fallbackBbox = feature.geometry ? computeBounds(feature.geometry) : null;
  const centroid = centroidGeometry
    ? [Number(centroidGeometry.coordinates[0]), Number(centroidGeometry.coordinates[1])]
    : fallbackBbox
      ? [Number((fallbackBbox[0] + fallbackBbox[2]) / 2), Number((fallbackBbox[1] + fallbackBbox[3]) / 2)]
      : [0, 0];
  const bbox = derivePointBbox(centroid[0], centroid[1], properties.area_off);

  return {
    slug: toSlug(`${properties.officialname}-${properties.ramsarid ?? properties.v_idris ?? "site"}`),
    officialName: properties.officialname,
    countryName: properties.country_en,
    iso3: properties.iso3,
    ramsarId: properties.ramsarid,
    vIdris: properties.v_idris,
    areaOff: properties.area_off,
    bbox: bbox.map(function (value) {
      return Number(value.toFixed(6));
    }),
    centroid: centroid.map(function (value) {
      return Number(value.toFixed(6));
    }),
  };
}

async function main() {
  const firstPage = await fetchJsonRange(0, PAGE_SIZE);
  const totalMatched = firstPage.totalFeatures ?? firstPage.numberMatched ?? firstPage.features.length;
  const features = firstPage.features.map(normalizeFeature);

  for (let startIndex = PAGE_SIZE; startIndex < totalMatched; startIndex += PAGE_SIZE) {
    console.log(`Downloading Ramsar wetlands page starting at ${startIndex}`);
    const geojson = await fetchJsonRange(startIndex, PAGE_SIZE);
    features.push(...geojson.features.map(normalizeFeature));
  }

  const dedupedByRamsarId = new Map();
  for (const feature of features) {
    const key = feature.ramsarId ?? feature.vIdris ?? feature.slug;
    if (!dedupedByRamsarId.has(key)) {
      dedupedByRamsarId.set(key, feature);
      continue;
    }

    const existing = dedupedByRamsarId.get(key);
    // Keep the richer record if duplicates are present.
    if ((feature.areaOff ?? 0) > (existing.areaOff ?? 0)) {
      dedupedByRamsarId.set(key, feature);
    }
  }

  const dedupedFeatures = Array.from(dedupedByRamsarId.values());

  const output = {
    generatedAt: new Date().toISOString(),
    source: `${WFS_BASE_URL}?service=WFS&version=2.0.0&request=GetFeature&typeName=${WFS_TYPENAME}&outputFormat=application/json&sortBy=ramsarid`,
    featureCount: dedupedFeatures.length,
    rawFeatureCount: features.length,
    features: dedupedFeatures,
  };

  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Wrote ${dedupedFeatures.length} deduped features (${features.length} raw) to ${OUTPUT_FILE}`);
}

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
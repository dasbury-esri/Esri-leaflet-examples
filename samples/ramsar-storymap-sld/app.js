(function () {
  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function mergeConfig(base, override) {
    const output = { ...base };

    for (const [key, value] of Object.entries(override || {})) {
      if (isPlainObject(value) && isPlainObject(base[key])) {
        output[key] = mergeConfig(base[key], value);
      } else {
        output[key] = value;
      }
    }

    return output;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatNumber(value) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return "Unknown";
    }

    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
  }

  function formatDesignationDate(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return "Unknown";
    }

    const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!isoMatch) {
      return raw;
    }

    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    const year = Number(isoMatch[1]);

    if (!month || !day || !year) {
      return raw;
    }

    return `${month}/${day}/${year}`;
  }

  function toTzTimestamp() {
    return new Date().toLocaleString(undefined, { timeZoneName: "short" });
  }

  function cleanCsvKey(key) {
    return String(key || "")
      .replace(/^\uFEFF/, "")
      .trim();
  }

  function normalizeCsvRow(row) {
    const cleaned = {};
    for (const [key, value] of Object.entries(row || {})) {
      cleaned[cleanCsvKey(key)] = typeof value === "string" ? value.trim() : value;
    }
    return cleaned;
  }

  const baseConfig = window.RAMSAR_SAMPLE_CONFIG || {};
  const localOverride = window.RAMSAR_SAMPLE_LOCAL_OVERRIDE || {};
  const config = mergeConfig(baseConfig, localOverride);

  const elements = {
    dockPanel: document.getElementById("dock-panel"),
    dockPanelContent: document.getElementById("dock-panel-content"),
    dockPanelClose: document.getElementById("dock-panel-close"),
    searchInput: document.getElementById("search-input"),
    searchResults: document.getElementById("search-results"),
    resetView: document.getElementById("reset-view"),
    statusText: document.getElementById("status-text"),
    countsStatus: document.getElementById("counts-status"),
  };

  const state = {
    map: null,
    features: [],
    popupDataByRamsarId: new Map(),
    centroidLayer: null,
    markerBySlug: new Map(),
    selectedMarker: null,
    selected: null,
    spatialDataAccessedAt: "Loading...",
    countSource: "",
  };

  function isLocalTestingHost() {
    return ["localhost", "127.0.0.1"].includes(window.location.hostname);
  }

  const showDiagnostics = isLocalTestingHost();

  function formatCoordinateForUrl(value) {
    const numeric = Number(value);
    if (Number.isNaN(numeric)) {
      return "0";
    }

    return String(Number(numeric.toFixed(5)));
  }

  function hasExplicitViewStateInUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.has("lat") && params.has("lng") && params.has("z");
  }

  function handleMoveEnd() {
    updateUrlState(state.selected);
  }

  function setStatus(message, isWarn) {
    if (!showDiagnostics) {
      elements.statusText.hidden = true;
      return;
    }

    elements.statusText.hidden = false;
    elements.statusText.textContent = message;
    elements.statusText.classList.toggle("status-text--warn", Boolean(isWarn));
  }

  function resolveHostedSldUrl(layerConfig) {
    if (layerConfig.sldUrl) {
      return layerConfig.sldUrl;
    }

    const path = layerConfig.hostedSldPath;
    if (!path) {
      return "";
    }

    const isLocalHost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
    if (isLocalHost) {
      return "";
    }

    return new URL(path, window.location.href).toString();
  }

  const resolvedPolygonSldUrl = resolveHostedSldUrl(config.layer);
  const stylePreference = resolvedPolygonSldUrl ? "sld" : config.layer.sldBody ? "sld_body" : "default";

  function createBasemapLayer() {
    const imageryServiceUrl = config.esriBasemap.serviceUrl;
    const referenceServiceUrl = config.esriBasemap.referenceServiceUrl;
    const referenceOpacity = Number(config.esriBasemap.referenceOpacity ?? 0.66);
    const wgs84Enabled = Boolean(config.map.useWgs84);

    // Prefer tile image requests for GCS imagery to avoid CORS/XHR export endpoint failures.
    if (imageryServiceUrl) {
      const tileUrl = `${imageryServiceUrl.replace(/\/$/, "")}/tile/{z}/{y}/{x}`;
      const layers = [
        window.L.tileLayer(tileUrl, {
          attribution: config.esriBasemap.fallbackAttribution,
          opacity: 1,
          maxZoom: 18,
        }),
      ];

      // The VectorTileLayer pipeline is MapLibre-based and can render incorrectly in non-WebMercator CRSs.
      if (!wgs84Enabled && referenceServiceUrl && window.L.esri.Vector && window.L.esri.Vector.vectorTileLayer) {
        layers.push(
          window.L.esri.Vector.vectorTileLayer(referenceServiceUrl, {
            opacity: referenceOpacity,
          })
        );
      }

      return layers.length === 1 ? layers[0] : window.L.layerGroup(layers);
    }

    if (config.map.useWgs84) {
      return null;
    }

    if (config.esriBasemap.apiKey && window.L.esri && window.L.esri.Vector) {
      const imageryLayer = window.L.esri.Vector.vectorBasemapLayer(config.esriBasemap.vectorStyle, {
        token: config.esriBasemap.apiKey,
      });

      const hybridReferenceStyle = config.esriBasemap.hybridReferenceStyle;
      if (!hybridReferenceStyle) {
        return imageryLayer;
      }

      const labelsLayer = window.L.esri.Vector.vectorBasemapLayer(hybridReferenceStyle, {
        token: config.esriBasemap.apiKey,
      });

      return window.L.layerGroup([imageryLayer, labelsLayer]);
    }

    const imageryLayer = window.L.tileLayer(config.esriBasemap.fallbackTileUrl, {
      attribution: config.esriBasemap.fallbackAttribution,
      maxZoom: 19,
    });

    if (!config.esriBasemap.fallbackLabelsTileUrl) {
      return imageryLayer;
    }

    const labelsLayer = window.L.tileLayer(config.esriBasemap.fallbackLabelsTileUrl, {
      attribution: config.esriBasemap.fallbackAttribution,
      pane: "overlayPane",
      maxZoom: 19,
    });

    return window.L.layerGroup([imageryLayer, labelsLayer]);
  }

  function createPolygonWmsLayer() {
    const wmsOptions = {
      layers: config.layer.name,
      format: "image/png",
      transparent: true,
      version: config.layer.wmsVersion,
      styles: "",
      attribution: "Ramsar Sites Information Service",
      uppercase: false,
    };

    const wgs84Enabled = Boolean(config.map.useWgs84);
    const wmsSrs = wgs84Enabled ? "EPSG:4326" : config.layer.srs;
    wmsOptions.srs = wmsSrs;
    wmsOptions.crs = wgs84Enabled ? window.L.CRS.EPSG4326 : config.layer.srs;

    if (resolvedPolygonSldUrl) {
      wmsOptions.sld = resolvedPolygonSldUrl;
    } else if (config.layer.sldBody) {
      wmsOptions.sld_body = config.layer.sldBody;
    }

    return window.L.tileLayer.wms(config.layer.serviceUrl, wmsOptions);
  }

  async function loadLayerCount(layerName) {
    const url = new URL(config.layer.serviceUrl);
    url.searchParams.set("service", "WFS");
    url.searchParams.set("version", "2.0.0");
    url.searchParams.set("request", "GetFeature");
    url.searchParams.set("typeName", layerName);
    url.searchParams.set("resultType", "hits");

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Count request failed for ${layerName} with status ${response.status}`);
    }

    const text = await response.text();
    const match = text.match(/numberMatched="([^"]+)"/);
    if (!match) {
      throw new Error(`numberMatched missing for ${layerName}`);
    }

    return Number(match[1]);
  }

  async function refreshCountStatus() {
    state.spatialDataAccessedAt = toTzTimestamp();

    if (!showDiagnostics) {
      elements.countsStatus.hidden = true;
      return;
    }

    elements.countsStatus.hidden = false;

    const localCount = state.features.length;
    const canAttemptRemote = !["127.0.0.1", "localhost"].includes(window.location.hostname);

    if (!canAttemptRemote) {
      state.countSource = "local-index";
      elements.countsStatus.textContent = `Spatial data counts: local index ${formatNumber(localCount)} (remote WFS counts blocked by CORS). Last refreshed: ${state.spatialDataAccessedAt}`;
      return;
    }

    try {
      const [polygonCount, centroidCount] = await Promise.all([
        loadLayerCount(config.layer.name),
        loadLayerCount(config.centroidLayer.name),
      ]);

      state.countSource = "remote-wfs";
      elements.countsStatus.textContent = `Spatial data counts: polygons ${formatNumber(polygonCount)}, centroids ${formatNumber(
        centroidCount
      )}. Last refreshed: ${state.spatialDataAccessedAt}`;
    } catch (error) {
      state.countSource = "local-index";
      elements.countsStatus.textContent = `Spatial data counts: local index ${formatNumber(localCount)} (remote WFS unavailable). Last refreshed: ${state.spatialDataAccessedAt}`;
    }
  }

  async function loadSearchIndex() {
    const response = await fetch(config.search.indexUrl);
    if (!response.ok) {
      throw new Error(`Search index request failed with status ${response.status}`);
    }

    const data = await response.json();
    return data.features.map(function (feature) {
      return {
        ...feature,
        officialNameLower: feature.officialName.toLowerCase(),
        countryNameLower: feature.countryName.toLowerCase(),
        iso3Lower: feature.iso3.toLowerCase(),
      };
    });
  }

  function loadPopupCsv() {
    return new Promise(function (resolve, reject) {
      if (!window.Papa) {
        reject(new Error("PapaParse is unavailable"));
        return;
      }

      window.Papa.parse(config.popupData.csvUrl, {
        download: true,
        header: true,
        skipEmptyLines: true,
        complete: function (result) {
          if (result.errors && result.errors.length) {
            reject(new Error(result.errors[0].message));
            return;
          }

          const table = new Map();
          for (const rawRow of result.data || []) {
            const row = normalizeCsvRow(rawRow);
            const ramsarIdRaw = row["Ramsar Site No."];
            if (!ramsarIdRaw) {
              continue;
            }
            const key = String(Number(ramsarIdRaw) || ramsarIdRaw).trim();
            table.set(key, row);
          }

          resolve(table);
        },
        error: function (error) {
          reject(error);
        },
      });
    });
  }

  function buildPopupHtml(feature) {
    const infoUrl = feature.ramsarId
      ? `https://rsis.ramsar.org/ris/${encodeURIComponent(feature.ramsarId)}`
      : "https://rsis.ramsar.org/ris-search";

    const hasTabularRecord = state.popupDataByRamsarId.has(String(feature.ramsarId));
    const popupRow = state.popupDataByRamsarId.get(String(feature.ramsarId)) || {};
    const siteName = String(feature.officialName || "").trim() || "Unknown site";
    const adminRegion = String(popupRow["large administrative region"] || "Unknown region").trim();
    const country = String(popupRow.Country || feature.countryName || "Unknown country").trim();
    const countryLabel = country.length > 8 && feature.iso3 ? feature.iso3.toUpperCase() : country;
    const designationDate = formatDesignationDate(popupRow["Designation date"] || "Unknown");
    const ecosystemServices = popupRow["Ecosystem services"] || "Not provided";
    const threats = popupRow.Threats || "Not provided";
    const annotatedSummary = popupRow["Annotated summary"] || "Not provided";
    const missingRowNote = hasTabularRecord
      ? ""
      : `<p class="popup-row"><strong>Note:</strong> No tabular record found for Ramsar Site No. ${escapeHtml(
          feature.ramsarId ?? "Unknown"
        )}</p>`;

    return `
      <div>
        <p class="popup-title-line"><span class="popup-title">${escapeHtml(siteName)}</span><span class="popup-title-meta">, ${escapeHtml(
      adminRegion
    )}, ${escapeHtml(countryLabel)}</span></p>
        <p class="popup-row popup-row--tight"><strong>Date of designation:</strong> ${escapeHtml(designationDate)}</p>
        ${missingRowNote}
        <p class="popup-row popup-row--tight"><strong>Size:</strong> ${escapeHtml(formatNumber(feature.areaOff))} hectares</p>
        <p class="popup-row"><strong>Social use:</strong> ${escapeHtml(ecosystemServices)}</p>
        <p class="popup-row"><strong>Threats:</strong> ${escapeHtml(threats)}</p>
        <p class="popup-row"><a href="${infoUrl}" target="_blank" rel="noreferrer">Open Ramsar site record</a></p>
        <p class="popup-row"><strong>Description:</strong></p>
        <div class="popup-description">${annotatedSummary}</div>
        <p class="popup-spatial-accessed">Spatial data accessed: ${escapeHtml(state.spatialDataAccessedAt)}</p>
      </div>
    `;
  }

  function renderDockPanel(feature) {
    if (!feature) {
      elements.dockPanel.classList.add("dock-panel--hidden");
      elements.dockPanelContent.innerHTML = "";
      return;
    }

    elements.dockPanelContent.innerHTML = buildPopupHtml(feature);
    elements.dockPanel.classList.remove("dock-panel--hidden");
  }

  function setMarkerSelectedState(marker, feature, isSelected) {
    if (!marker) {
      return;
    }

    marker.setStyle({
      radius: centroidMarkerRadius(feature.areaOff) + (isSelected ? 3 : 0),
      color: isSelected ? "#39d353" : "#d1ff73",
      weight: isSelected ? 2.25 : 0.75,
      fillColor: isSelected ? "#c7ff5b" : "#98e600",
      fillOpacity: isSelected ? 0.2 : 0.54,
    });

    const element = marker.getElement();
    if (element) {
      element.classList.toggle("is-selected-feature", isSelected);
    }
  }

  function highlightSelectedFeature(feature, previousFeature) {
    if (state.selectedMarker && previousFeature) {
      setMarkerSelectedState(state.selectedMarker, previousFeature, false);
    }

    state.selectedMarker = feature ? state.markerBySlug.get(feature.slug) || null : null;

    if (state.selectedMarker && feature) {
      setMarkerSelectedState(state.selectedMarker, feature, true);
      if (state.selectedMarker.bringToFront) {
        state.selectedMarker.bringToFront();
      }
    }
  }

  function getDockedViewportTargetPoint() {
    const mapSize = state.map.getSize();
    const railWidth = elements.dockPanel.classList.contains("dock-panel--hidden")
      ? 0
      : elements.dockPanel.getBoundingClientRect().width;

    return window.L.point((mapSize.x + railWidth) / 2, mapSize.y / 2);
  }

  function panSelectedFeatureIntoDockedView(feature, animate) {
    if (!feature || elements.dockPanel.classList.contains("dock-panel--hidden")) {
      return;
    }

    const currentPoint = state.map.latLngToContainerPoint([feature.centroid[1], feature.centroid[0]]);
    const targetPoint = getDockedViewportTargetPoint();
    const offsetX = currentPoint.x - targetPoint.x;
    const offsetY = currentPoint.y - targetPoint.y;

    if (Math.abs(offsetX) < 1 && Math.abs(offsetY) < 1) {
      return;
    }

    state.map.panBy([offsetX, offsetY], {
      animate: Boolean(animate),
      duration: animate ? 0.35 : 0,
    });
  }

  function clearSelection(resetView) {
    const previousFeature = state.selected;
    highlightSelectedFeature(null, previousFeature);
    state.selected = null;
    renderDockPanel(null);

    if (resetView) {
      state.map.setView(config.map.center, config.map.zoom, { animate: true });
    }

    updateUrlState(null);
  }

  function centroidMarkerRadius(areaOff) {
    if (typeof areaOff !== "number" || Number.isNaN(areaOff)) {
      return 9;
    }
    if (areaOff < 50000) {
      return 5.25;
    }
    if (areaOff < 250000) {
      return 9;
    }
    if (areaOff < 1000000) {
      return 13.5;
    }
    if (areaOff < 3000000) {
      return 19.75;
    }
    return 26.25;
  }

  function createCentroidMarkersLayer(features) {
    const seen = new Set();
    const group = window.L.layerGroup();

    for (const feature of features) {
      const key = `${feature.ramsarId ?? "na"}:${feature.centroid[0]}:${feature.centroid[1]}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const marker = window.L.circleMarker([feature.centroid[1], feature.centroid[0]], {
        radius: centroidMarkerRadius(feature.areaOff),
        color: "#d1ff73",
        weight: 0.75,
        fillColor: "#98e600",
        fillOpacity: 0.54,
      });

      marker.on("click", function () {
        selectFeature(feature);
      });
      state.markerBySlug.set(feature.slug, marker);
      group.addLayer(marker);
    }

    return group;
  }

  function updateUrlState(feature) {
    const params = new URLSearchParams(window.location.search);
    const center = state.map.getCenter();
    params.set("lat", formatCoordinateForUrl(center.lat));
    params.set("lng", formatCoordinateForUrl(center.lng));
    params.set("z", String(state.map.getZoom()));

    if (feature) {
      params.set("site", feature.slug);
    } else {
      params.delete("site");
    }

    const pathname = window.location.pathname.endsWith("/") ? window.location.pathname : `${window.location.pathname}/`;
    window.history.replaceState({}, "", `${pathname}?${params.toString()}`);
  }

  function writeExplicitViewState(lat, lng, zoom, feature) {
    const params = new URLSearchParams(window.location.search);
    params.set("lat", formatCoordinateForUrl(lat));
    params.set("lng", formatCoordinateForUrl(lng));
    params.set("z", String(zoom));

    if (feature) {
      params.set("site", feature.slug);
    } else {
      params.delete("site");
    }

    const pathname = window.location.pathname.endsWith("/") ? window.location.pathname : `${window.location.pathname}/`;
    window.history.replaceState({}, "", `${pathname}?${params.toString()}`);
  }

  function selectFeature(feature, options) {
    const animate = options && options.animate === false ? false : true;
    const previousFeature = state.selected;
    const panelWidth = elements.dockPanel.getBoundingClientRect().width;
    const bounds = window.L.latLngBounds(
      [feature.bbox[1], feature.bbox[0]],
      [feature.bbox[3], feature.bbox[2]]
    );

    renderDockPanel(feature);
    highlightSelectedFeature(feature, previousFeature);
    state.selected = feature;
    state.map.fitBounds(bounds.pad(0.18), {
      animate,
      duration: 0.4,
      paddingTopLeft: [panelWidth + 24, 24],
      paddingBottomRight: [24, 24],
    });
    state.map.once("moveend", function () {
      panSelectedFeatureIntoDockedView(feature, animate);
    });
    updateUrlState(feature);
  }

  function renderResults(matches) {
    elements.searchResults.innerHTML = "";
    if (!matches.length) {
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const feature of matches) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "result-card";
      button.innerHTML = `
        <span class="result-title">${escapeHtml(feature.officialName)}</span>
        <span class="result-meta">${escapeHtml(feature.countryName)} · Ramsar ID ${escapeHtml(feature.ramsarId)}</span>
      `;
      button.addEventListener("click", function () {
        elements.searchInput.value = feature.officialName;
        elements.searchResults.innerHTML = "";
        selectFeature(feature);
      });
      fragment.appendChild(button);
    }

    elements.searchResults.appendChild(fragment);
  }

  function runSearch(query) {
    const value = query.trim().toLowerCase();
    if (!value) {
      elements.searchResults.innerHTML = "";
      return;
    }

    const matches = state.features
      .filter(function (feature) {
        return (
          feature.officialNameLower.includes(value) ||
          feature.countryNameLower.includes(value) ||
          feature.iso3Lower.includes(value)
        );
      })
      .slice(0, config.search.maxResults);

    renderResults(matches);
  }

  function restoreStateFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const lat = Number(params.get("lat"));
    const lng = Number(params.get("lng"));
    const zoom = Number(params.get("z"));
    const site = params.get("site");
    const hasViewState = !Number.isNaN(lat) && !Number.isNaN(lng) && !Number.isNaN(zoom);
    let restoredSite = false;

    if (hasViewState) {
      state.map.setView([lat, lng], zoom, { animate: false });
    }

    if (site) {
      const feature = state.features.find(function (entry) {
        return entry.slug === site;
      });
      if (feature) {
        selectFeature(feature, { animate: false });
        restoredSite = true;
      }
    }

    return hasViewState || restoredSite;
  }

  async function init() {
    try {
      const mapOptions = {
        zoomControl: false,
        minZoom: config.map.minZoom,
        maxZoom: config.map.maxZoom,
      };

      if (config.map.useWgs84) {
        mapOptions.crs = window.L.CRS.EPSG4326;
      }

      state.map = window.L.map("map", mapOptions).setView(config.map.center, config.map.zoom);
      if (!hasExplicitViewStateInUrl()) {
        writeExplicitViewState(config.map.center[0], config.map.center[1], config.map.zoom, null);
      }
      window.L.control.zoom({ position: "topright" }).addTo(state.map);

      const basemap = createBasemapLayer();
      if (basemap) {
        basemap.addTo(state.map);
      }

      createPolygonWmsLayer().addTo(state.map);

      const [features, popupTable] = await Promise.all([loadSearchIndex(), loadPopupCsv()]);
      state.features = features;
      state.popupDataByRamsarId = popupTable;
      state.centroidLayer = createCentroidMarkersLayer(state.features);
      state.centroidLayer.addTo(state.map);

      await refreshCountStatus();

      elements.searchInput.addEventListener("input", function (event) {
        runSearch(event.target.value);
      });

      elements.resetView.addEventListener("click", function () {
        elements.searchInput.value = "";
        elements.searchResults.innerHTML = "";
        clearSelection(true);
      });

      elements.dockPanelClose.addEventListener("click", function () {
        clearSelection(true);
      });

      const restoredView = restoreStateFromUrl();
      if (!restoredView) {
        state.map.invalidateSize(false);
        state.map.setView(config.map.center, config.map.zoom, { animate: false, reset: true });
        writeExplicitViewState(config.map.center[0], config.map.center[1], config.map.zoom, null);
      }

      state.map.on("moveend", handleMoveEnd);

      if (config.map.useWgs84) {
        setStatus(
          `Map ready in WGS84 (EPSG:4326). WMS request: version ${config.layer.wmsVersion}, SRS/CRS EPSG:4326. Basemap labels are disabled in WGS84 to avoid VectorTile WebMercator rendering issues. Polygon style mode: ${stylePreference}.`,
          false
        );
      } else {
        setStatus(
          `Map ready. WMS request: version ${config.layer.wmsVersion}, SRS/CRS ${config.layer.srs}. Polygon style mode: ${stylePreference}.`,
          false
        );
      }
    } catch (error) {
      console.error(error);
      setStatus(`Map initialization failed: ${error.message}`, true);
    }
  }

  init();
})();

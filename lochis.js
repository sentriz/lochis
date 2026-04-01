// @ts-check

/** @import { ViewStateChangeEvent } from "@vis.gl/react-maplibre" */
/** @import { MapLibreEvent, Map as MapLibreMap } from "maplibre-gl" */

import React, { useState, useRef, useEffect } from "react";
import ReactDOM from "react-dom/client";
import htm from "htm";
import { Map, Source, Layer } from "@vis.gl/react-maplibre";

const html = htm.bind(React.createElement);

/** @typedef {{ type: "FeatureCollection", features: object[] }} FeatureCollection */
/** @typedef {{ id: number, name: string, colour: string }} Tag */

/** @type {FeatureCollection} */
const EMPTY_FC = { type: "FeatureCollection", features: [] };

function App() {
  const [geojson, setGeojson] = useState(EMPTY_FC);
  const [tags, setTags] = useState(/** @type {Tag[]} */ ([]));
  const [blend, setBlend] = useState(0); // 0 = frequent, 1 = explore
  const [historyVisible, setHistoryVisible] = useState(true);
  const [hiddenTags, setHiddenTags] = useState(/** @type {Set<number>} */ (new Set()));
  /** @type {React.RefObject<AbortController | null>} */
  const controllerRef = useRef(null);

  useEffect(() => {
    fetch("/tags")
      .then((r) => r.json())
      .then((/** @type {Tag[]} */ tags) => setTags(tags));
  }, []);

  const loadData = (/** @type {MapLibreMap} */ map) => {
    if (controllerRef.current) controllerRef.current.abort();
    controllerRef.current = new AbortController();

    const bounds = map.getBounds();
    const zoom = map.getZoom();
    const params = new URLSearchParams({
      west: String(bounds.getWest()),
      south: String(bounds.getSouth()),
      east: String(bounds.getEast()),
      north: String(bounds.getNorth()),
      zoom: String(zoom),
    });

    fetch(`/history?${params}`, {
      signal: controllerRef.current.signal,
    })
      .then((r) => r.text())
      .then((text) => {
        const trimmed = text.trim();
        const features = trimmed
          ? JSON.parse("[" + trimmed.replaceAll("\n", ",") + "]")
          : [];
        setGeojson({ type: "FeatureCollection", features });
      })
      .catch((e) => {
        if (e.name !== "AbortError") throw e;
      });
  };

  const onMoveEnd = (/** @type {ViewStateChangeEvent} */ e) =>
    loadData(e.target);

  const onLoad = (/** @type {MapLibreEvent} */ e) => loadData(e.target);

  const toggleTag = (/** @type {number} */ id) =>
    setHiddenTags((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return html`
    <${Map}
      initialViewState=${{ zoom: 2, latitude: 51.5, longitude: 0 }}
      hash=${true}
      onMoveEnd=${onMoveEnd}
      onLoad=${onLoad}
      class="size-full"
      mapStyle="https://api.maptiler.com/maps/basic/style.json?key=get_your_own_OpIi9ZULNHzrESv6T2vL"
    >
      <${Source} id="history" type="geojson" data=${geojson}>
        <${Layer}
          id="frequent"
          type="heatmap"
          filter=${["!", ["has", "tag_id"]]}
          layout=${{ visibility: historyVisible ? "visible" : "none" }}
          paint=${frequentPaint(blend)}
        />
        <${Layer}
          id="explore"
          type="circle"
          filter=${["!", ["has", "tag_id"]]}
          layout=${{ visibility: historyVisible ? "visible" : "none" }}
          paint=${explorePaint(blend)}
        />
        ${tags.map((t) => html`
            <${Layer}
              key=${`tag-${t.id}`}
              id=${`tag-${t.id}`}
              type="circle"
              filter=${["==", ["get", "tag_id"], t.id]}
              layout=${{ visibility: hiddenTags.has(t.id) ? "none" : "visible" }}
              paint=${taggedPaint(t.colour)}
            />
          `)}
      <//>
    <//>
    <${LayerControls}
      blend=${blend}
      setBlend=${setBlend}
      historyVisible=${historyVisible}
      setHistoryVisible=${setHistoryVisible}
      tags=${tags}
      hiddenTags=${hiddenTags}
      toggleTag=${toggleTag}
    />
  `;
}

/**
 * @param {{ blend: number, setBlend: (v: number) => void, historyVisible: boolean, setHistoryVisible: (v: boolean) => void, tags: Tag[], hiddenTags: Set<number>, toggleTag: (id: number) => void }} props
 */
function LayerControls({
  blend,
  setBlend,
  historyVisible,
  setHistoryVisible,
  tags,
  hiddenTags,
  toggleTag,
}) {
  return html`
    <div
      class="absolute top-4 right-4 z-10 bg-white/90 rounded-lg shadow px-3 py-2 text-xs font-sans select-none min-w-40"
    >
      <div class="flex items-center gap-2 py-1">
        <input
          type="checkbox"
          checked=${historyVisible}
          onChange=${() => setHistoryVisible(!historyVisible)}
        />
        <span class="text-xs">Frequent</span>
        <input
          class="flex-1"
          type="range"
          min="0"
          max="1"
          step="0.05"
          value=${blend}
          disabled=${!historyVisible}
          onInput=${(/** @type {Event & { target: HTMLInputElement }} */ e) =>
            setBlend(parseFloat(e.target.value))}
        />
        <span class="text-xs">Explore</span>
      </div>
      ${tags.length > 0 && html`<hr class="my-1 border-gray-300" />`}
      ${tags.map(
        (t) => html`
          <div key=${t.id} class="flex items-center gap-2 py-1">
            <input
              type="checkbox"
              checked=${!hiddenTags.has(t.id)}
              onChange=${() => toggleTag(t.id)}
            />
            ${t.colour &&
            html`<span
              class="shrink-0 size-2.5 rounded-full"
              style=${{ backgroundColor: t.colour }}
            />`}
            <span class="text-xs">${t.name}</span>
          </div>
        `,
      )}
    </div>
  `;
}

ReactDOM.createRoot(document.body).render(html`<${App} />`);

const BASE_OPACITY = [0.9, 0.7, 0.5];

const HEATMAP_COLOR = [
  "interpolate",
  ["linear"],
  ["heatmap-density"],
  0,
  "rgba(0, 0, 255, 0)",
  0.1,
  "rgba(0, 100, 255, 0.3)",
  0.3,
  "rgba(0, 128, 255, 0.5)",
  0.5,
  "rgba(0, 255, 128, 0.6)",
  0.7,
  "rgba(255, 255, 0, 0.8)",
  1,
  "rgba(255, 0, 0, 1)",
];

const frequentPaint = (/** @type {number} */ blend) => ({
  "heatmap-opacity": [
    "interpolate",
    ["linear"],
    ["zoom"],
    0,
    BASE_OPACITY[0] * (1 - blend),
    14,
    BASE_OPACITY[1] * (1 - blend),
    18,
    BASE_OPACITY[2] * (1 - blend),
  ],
  "heatmap-weight": [
    "interpolate",
    ["exponential", 0.5],
    ["get", "weight"],
    1,
    0,
    10,
    0.03,
    50,
    0.15,
    200,
    0.4,
    1000,
    0.75,
    10000,
    1,
  ],
  "heatmap-intensity": [
    "interpolate",
    ["linear"],
    ["zoom"],
    0,
    2,
    5,
    2.5,
    8,
    2.5,
    12,
    3,
    15,
    3,
    18,
    5,
  ],
  "heatmap-color": HEATMAP_COLOR,
  "heatmap-radius": [
    "interpolate",
    ["linear"],
    ["zoom"],
    0,
    12,
    5,
    28,
    10,
    30,
    14,
    25,
    16,
    15,
    18,
    10,
  ],
});

const explorePaint = (/** @type {number} */ blend) => ({
  "circle-opacity": blend,
  "circle-color": [
    "interpolate",
    ["exponential", 0.5],
    ["get", "weight"],
    1,
    "rgba(0,80,255,0.1)",
    10,
    "rgba(255,30,0,0.8)",
    50,
    "rgba(255,160,0,0.7)",
    200,
    "rgba(0,180,255,0.4)",
    1000,
    "rgba(0,80,255,0.25)",
    10000,
    "rgba(0,40,255,0.1)",
  ],
  "circle-radius": [
    "interpolate",
    ["linear"],
    ["zoom"],
    0,
    [
      "interpolate",
      ["exponential", 0.5],
      ["get", "weight"],
      1,
      1,
      10,
      4,
      50,
      3,
      200,
      2,
      1000,
      1.5,
      10000,
      1,
    ],
    10,
    [
      "interpolate",
      ["exponential", 0.5],
      ["get", "weight"],
      1,
      2,
      10,
      8,
      50,
      6,
      200,
      4,
      1000,
      3,
      10000,
      2,
    ],
    16,
    [
      "interpolate",
      ["exponential", 0.5],
      ["get", "weight"],
      1,
      3,
      10,
      12,
      50,
      9,
      200,
      6,
      1000,
      4,
      10000,
      3,
    ],
  ],
  "circle-blur": 0.4,
});

const taggedPaint = (/** @type {string} */ colour) => ({
  "circle-color": colour,
  "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 3, 10, 6, 16, 9],
  "circle-opacity": 0.9,
  "circle-blur": 0.1,
  "circle-stroke-color": "white",
  "circle-stroke-width": 1.5,
  "circle-stroke-opacity": 0.9,
});

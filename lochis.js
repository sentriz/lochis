// @ts-check

/** @import { ViewStateChangeEvent } from "@vis.gl/react-maplibre" */
/** @import { MapLibreEvent, Map as MapLibreMap } from "maplibre-gl" */

import React, { useState, useCallback, useRef, useEffect } from "react";
import ReactDOM from "react-dom/client";
import htm from "htm";
import { Map, Source, Layer } from "react-map-gl/maplibre";

const html = htm.bind(React.createElement);

/** @typedef {{ type: "FeatureCollection", features: object[] }} FeatureCollection */
/** @typedef {{ id: number, name: string, colour: string }} Tag */

/** @type {FeatureCollection} */
const EMPTY_FC = { type: "FeatureCollection", features: [] };

function parseHash() {
  const parts = window.location.hash.slice(1).split("/");
  if (parts.length === 3) {
    return {
      zoom: parseFloat(parts[0]),
      latitude: parseFloat(parts[1]),
      longitude: parseFloat(parts[2]),
    };
  }
  return { zoom: 2, latitude: 51.5, longitude: 0 };
}

function App() {
  const [explore, setExplore] = useState(0);
  const [geojson, setGeojson] = useState(EMPTY_FC);
  /** @type {[Tag[], React.Dispatch<React.SetStateAction<Tag[]>>]} */
  const [tags, setTags] = useState([]);
  /** @type {React.RefObject<AbortController | null>} */
  const controllerRef = useRef(null);

  useEffect(() => {
    fetch("/tags")
      .then((r) => r.json())
      .then(setTags);
  }, []);

  const loadData = useCallback((/** @type {MapLibreMap} */ map) => {
    if (controllerRef.current) controllerRef.current.abort();
    controllerRef.current = new AbortController();

    const bounds = map.getBounds();
    const zoom = map.getZoom();
    const bbox = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`;

    fetch(`/history?bbox=${bbox}&zoom=${zoom}`, {
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
  }, []);

  const onMoveEnd = useCallback(
    (/** @type {ViewStateChangeEvent} */ e) => {
      const map = e.target;
      const z = map.getZoom().toFixed(2);
      const c = map.getCenter();
      window.history.replaceState(
        null,
        "",
        `#${z}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`,
      );
      loadData(map);
    },
    [loadData],
  );

  const onLoad = useCallback(
    (/** @type {MapLibreEvent} */ e) => {
      loadData(e.target);
    },
    [loadData],
  );

  const tagColour = tags.length
    ? ["match", ["get", "tag_id"], ...tags.flatMap((t) => [t.id, t.colour]), "transparent"]
    : "transparent";

  const heatmapOpacity = [
    "interpolate",
    ["linear"],
    ["zoom"],
    0,
    BASE_OPACITY[0] * (1 - explore),
    14,
    BASE_OPACITY[1] * (1 - explore),
    18,
    BASE_OPACITY[2] * (1 - explore),
  ];

  return html`
    <${Map}
      initialViewState=${parseHash()}
      onMoveEnd=${onMoveEnd}
      onLoad=${onLoad}
      class="size-full"
      mapStyle="https://api.maptiler.com/maps/basic/style.json?key=get_your_own_OpIi9ZULNHzrESv6T2vL"
    >
      <${Source} id="history" type="geojson" data=${geojson}>
        <${Layer}
          id="frequent"
          type="heatmap"
          paint=${{ ...FREQUENT_PAINT, "heatmap-opacity": heatmapOpacity }}
        />
        <${Layer}
          id="tagged"
          type="circle"
          filter=${[">", ["get", "tag_id"], 0]}
          paint=${{
            "circle-color": tagColour,
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 5, 10, 9, 16, 14],
            "circle-opacity": 0.9,
            "circle-stroke-color": tagColour,
            "circle-stroke-width": 1,
            "circle-stroke-opacity": 0.5,
          }}
        />
        <${Layer}
          id="explore"
          type="circle"
          paint=${{ ...EXPLORE_PAINT, "circle-opacity": explore }}
        />
      <//>
    <//>
    <div
      class="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 bg-white/80 px-3.5 py-1.5 rounded-full text-xs font-sans flex items-center gap-2 shadow select-none"
    >
      <span>Frequent</span>
      <input
        class="w-30"
        type="range"
        min="0"
        max="1"
        step="0.01"
        value=${explore}
        onInput=${(/** @type {Event & { target: HTMLInputElement }} */ e) =>
      setExplore(parseFloat(e.target.value))}
      />
      <span>Explore</span>
    </div>
  `;
}

ReactDOM.createRoot(document.body).render(html`<${App} />`);

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

const FREQUENT_PAINT = {
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
};

const EXPLORE_PAINT = {
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
};

const BASE_OPACITY = [0.9, 0.7, 0.5];

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

/** @typedef {{ visible: boolean, opacity: number, label: string, colour: string | null }} LayerState */

function App() {
  const [geojson, setGeojson] = useState(EMPTY_FC);
  const [tags, setTags] = useState(/** @type {Tag[]} */ ([]));
  const [layers, setLayers] = useState(
    /** @type {Record<string, LayerState>} */ ({
      frequent: {
        visible: true,
        opacity: 0.9,
        label: "Frequent",
        colour: null,
      },
      explore: { visible: false, opacity: 0.7, label: "Explore", colour: null },
    }),
  );
  /** @type {React.RefObject<AbortController | null>} */
  const controllerRef = useRef(null);

  useEffect(() => {
    fetch("/tags")
      .then((r) => r.json())
      .then((/** @type {Tag[]} */ tags) => setTags(tags));
  }, []);

  useEffect(() => {
    setLayers((prev) => {
      const next = { ...prev };
      for (const t of tags) {
        next[`tag-${t.id}`] = {
          visible: true,
          opacity: 0.9,
          label: t.name,
          colour: t.colour,
        };
      }
      return next;
    });
  }, [tags]);

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

  const updateLayer = (
    /** @type {string} */ id,
    /** @type {Partial<LayerState>} */ patch,
  ) => setLayers((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

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
          paint=${{
            ...FREQUENT_PAINT,
            "heatmap-opacity": layers.frequent.visible
              ? [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  0,
                  BASE_OPACITY[0] * layers.frequent.opacity,
                  14,
                  BASE_OPACITY[1] * layers.frequent.opacity,
                  18,
                  BASE_OPACITY[2] * layers.frequent.opacity,
                ]
              : 0,
          }}
        />
        <${Layer}
          id="explore"
          type="circle"
          filter=${["!", ["has", "tag_id"]]}
          paint=${{
            ...EXPLORE_PAINT,
            "circle-opacity": layers.explore.visible
              ? layers.explore.opacity
              : 0,
          }}
        />
        ${tags.map((t) => {
          const l = layers[`tag-${t.id}`];
          if (!l) return null;
          return html`
            <${Layer}
              key=${`tag-${t.id}`}
              id=${`tag-${t.id}`}
              type="circle"
              filter=${["==", ["get", "tag_id"], t.id]}
              paint=${{
                "circle-color": t.colour,
                "circle-radius": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  0,
                  5,
                  10,
                  9,
                  16,
                  14,
                ],
                "circle-opacity": l.visible ? l.opacity : 0,
                "circle-stroke-color": t.colour,
                "circle-stroke-width": 1,
                "circle-stroke-opacity": l.visible ? l.opacity * 0.5 : 0,
              }}
            />
          `;
        })}
      <//>
    <//>
    <${LayerControls} layers=${layers} updateLayer=${updateLayer} />
  `;
}

/**
 * @param {{ layers: Record<string, LayerState>, updateLayer: (id: string, patch: Partial<LayerState>) => void }} props
 */
function LayerControls({ layers, updateLayer }) {
  return html`
    <div
      class="absolute bottom-4 left-4 z-10 bg-white/90 rounded-lg shadow px-3 py-2 text-xs font-sans select-none min-w-40"
    >
      ${Object.entries(layers).map(
        ([id, l]) => html`
          <div key=${id} class="flex items-center gap-2 py-1">
            <input
              type="checkbox"
              checked=${l.visible}
              onChange=${() => updateLayer(id, { visible: !l.visible })}
            />
            ${l.colour &&
            html`<span
              class="inline-block size-2.5 rounded-full"
              style=${{ backgroundColor: l.colour }}
            />`}
            <span class="flex-1">${l.label}</span>
            <input
              class="w-16"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value=${l.opacity}
              onInput=${(
                /** @type {Event & { target: HTMLInputElement }} */ e,
              ) => updateLayer(id, { opacity: parseFloat(e.target.value) })}
            />
          </div>
        `,
      )}
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

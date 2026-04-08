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
/** @typedef {{ id: number, time: string, speed: number, altitude: number, latitude: number, longitude: number }} History */
/** @typedef {{ name: string, latitude: number, longitude: number, country: string, population: number }} City */
/** @typedef {{ history: History, city?: City}} Now */

/** @type {FeatureCollection} */
const EMPTY_FC = { type: "FeatureCollection", features: [] };

/** @param {number} ms */
const formatDuration = (ms) => {
  const mins = ms / (60 * 1000);
  if (mins < 60) return `${Math.round(mins)}m`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  const months = days / 30;
  if (months < 12) return `${Math.round(months)}mo`;
  return `${Math.round(days / 365)}y`;
};

/** @typedef {{ maptiler_api_key: string, tags: Tag[], min_time?: string, max_time?: string }} Config */
/** @typedef {{ start?: Date, end?: Date }} TimeRange */

function App() {
  const [config, setConfig] = useState(
    /** @type {Config | undefined} */ (undefined),
  );
  useEffect(() => {
    (async () => {
      /** @type {Config} */
      const config = await (await fetch("/config")).json();
      setConfig(config);
    })();
  }, []);

  const [now, setNow] = useState(/** @type {Now | undefined} */ (undefined));
  useEffect(() => {
    (async () => {
      const resp = await fetch("/now");
      if (!resp.ok) return;
      /** @type {Now} */
      const now = await resp.json();
      setNow(now);
    })();
  }, []);

  /** @type {React.RefObject<AbortController | null>} */
  const controllerRef = useRef(null);

  const [timeRange, setTimeRange] = useState(/** @type {TimeRange} */ ({}));
  const { start, end } = timeRange;
  const setStart = (/** @type {Date | undefined} */ v) =>
    setTimeRange((prev) => ({ ...prev, start: v }));
  const setEnd = (/** @type {Date | undefined} */ v) =>
    setTimeRange((prev) => ({ ...prev, end: v }));
  const [geojson, setGeojson] = useState(EMPTY_FC);
  /** @type {React.RefObject<MapLibreMap | null>} */
  const mapRef = useRef(null);
  const loadData = async (/** @type {MapLibreMap} */ map) => {
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
    if (start) params.set("start", start.toISOString());
    if (end) params.set("end", end.toISOString());

    try {
      const resp = await fetch(`/geojson/history?${params}`, {
        signal: controllerRef.current.signal,
      });
      const text = await resp.text();
      const trimmed = text.trim();
      const features = trimmed
        ? JSON.parse("[" + trimmed.replaceAll("\n", ",") + "]")
        : [];
      setGeojson({ type: "FeatureCollection", features });
    } catch (/** @type {any} */ e) {
      if (e.name !== "AbortError") throw e;
    }
  };

  const onMoveEnd = (/** @type {ViewStateChangeEvent} */ e) =>
    loadData(e.target);
  const onLoad = (/** @type {MapLibreEvent} */ e) => loadData(e.target);

  useEffect(() => {
    if (mapRef.current) loadData(mapRef.current);
  }, [timeRange]);

  const [hiddenTags, setHiddenTags] = useState(
    /** @type {Set<number>} */ (new Set()),
  );
  const toggleTag = (/** @type {number} */ id) =>
    setHiddenTags((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const nowIsRecent = now
    ? Date.now() - new Date(now.history.time).getTime() < 20 * 60 * 1000
    : false;

  const tags = config?.tags ?? [];
  const [blend, setBlend] = useState(0.25); // 0 = frequent, 1 = explore
  const [historyVisible, setHistoryVisible] = useState(true);

  return html`
    <${Map}
      ref=${mapRef}
      initialViewState=${{ zoom: 2, latitude: 51.5, longitude: 0 }}
      hash=${true}
      onMoveEnd=${onMoveEnd}
      onLoad=${onLoad}
      class="size-full"
      mapStyle=${config
        ? `https://api.maptiler.com/maps/basic/style.json?key=${config.maptiler_api_key}`
        : undefined}
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
        ${tags.map(
          (t) => html`
            <${Layer}
              key=${`tag-${t.id}`}
              id=${`tag-${t.id}`}
              type="circle"
              filter=${["==", ["get", "tag_id"], t.id]}
              layout=${{
                visibility: hiddenTags.has(t.id) ? "none" : "visible",
              }}
              paint=${taggedPaint(t.colour)}
            />
          `,
        )}
      <//>
      ${now &&
      html`
        <${Source}
          id="now"
          type="geojson"
          data=${{
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: {
                  type: "Point",
                  coordinates: [now.history.longitude, now.history.latitude],
                },
              },
            ],
          }}
        >
          <${Layer}
            id="now"
            type="circle"
            layout=${{ visibility: nowIsRecent ? "visible" : "none" }}
            paint=${{
              "circle-radius": 8,
              "circle-color": "#3b82f6",
              "circle-opacity": 0.9,
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 2,
              "circle-stroke-opacity": 1,
            }}
          />
        <//>
      `}
    <//>
    ${now &&
    html`<${LastSeen}
      time=${now.history.time}
      speed=${now.history.speed}
      altitude=${now.history.altitude}
      city=${now.city}
      recent=${nowIsRecent}
    />`}
    <div class="absolute bottom-4 left-4 z-10 flex flex-col gap-2">
      <${TimeControls}
        start=${start}
        setStart=${setStart}
        end=${end}
        setEnd=${setEnd}
        setTimeRange=${setTimeRange}
        minTime=${config?.min_time}
        maxTime=${config?.max_time}
      />
      <${LayerControls}
        blend=${blend}
        setBlend=${setBlend}
        historyVisible=${historyVisible}
        setHistoryVisible=${setHistoryVisible}
        tags=${tags}
        hiddenTags=${hiddenTags}
        toggleTag=${toggleTag}
      />
    </div>
  `;
}

/** @param {{ time: string, speed: number, altitude: number, city?: City, recent: boolean }} props */
function LastSeen({ time, speed, altitude, city, recent }) {
  const [ago, setAgo] = useState("");
  useEffect(() => {
    const update = () => {
      const diff = Date.now() - new Date(time).getTime();
      setAgo(diff < 60_000 ? "just now" : `${formatDuration(diff)} ago`);
    };
    update();
    const id = setInterval(update, 30_000);
    return () => clearInterval(id);
  }, [time]);

  const parts = [ago];
  if (city) parts.push(`${city.name}, ${city.country}`);
  if (speed > 0) parts.push(`${Math.round(speed * 3.6)} km/h`);
  if (altitude > 0) parts.push(`${Math.round(altitude)} m`);

  return html`
    <div
      class="absolute top-4 left-1/2 -translate-x-1/2 z-10 bg-white/90 rounded-lg shadow px-3 py-1.5 text-xs font-sans select-none whitespace-nowrap flex items-center gap-1.5"
    >
      ${recent &&
      html`
        <span class="relative flex size-2.5">
          <span
            class="animate-ping absolute inline-flex size-full rounded-full bg-red-400 opacity-75"
          />
          <span class="relative inline-flex size-2.5 rounded-full bg-red-500" />
        </span>
      `}
      <span>${parts.join(" · ")}</span>
    </div>
  `;
}

/** @param {{ start: Date | undefined, setStart: (v: Date | undefined) => void, end: Date | undefined, setEnd: (v: Date | undefined) => void, setTimeRange: (v: TimeRange) => void, minTime?: string, maxTime?: string }} props */
function TimeControls({
  start,
  setStart,
  end,
  setEnd,
  setTimeRange,
  minTime,
  maxTime,
}) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
  /** @type {(d?: Date | string) => string} */
  const fmtDate = (d) => {
    if (!d) return "";
    const dt = new Date(d);
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  };
  /** @type {(d?: Date | string) => string} */
  const fmtTime = (d) => {
    if (!d) return "";
    const dt = new Date(d);
    return `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  };
  /** @type {(date: string, time: string) => Date | undefined} */
  const toDate = (date, time) =>
    date ? new Date(`${date}T${time || "00:00"}`) : undefined;

  /** @type {(...vals: (Date | string | undefined)[]) => string} */
  const minOf = (...vals) => vals.map(fmtDate).filter(Boolean).sort()[0] || "";
  /** @type {(...vals: (Date | string | undefined)[]) => string} */
  const maxOf = (...vals) =>
    vals.map(fmtDate).filter(Boolean).sort().pop() || "";

  const startMax = minOf(end, maxTime);
  const endMin = maxOf(start, minTime);

  const hasWindow = start && end && end.getTime() > start.getTime();
  const windowMs = hasWindow ? end.getTime() - start.getTime() : 0;
  const canShiftBack =
    hasWindow &&
    (!minTime || new Date(minTime).getTime() <= start.getTime() - windowMs);
  const canShiftForward =
    hasWindow &&
    (!maxTime || end.getTime() + windowMs <= new Date(maxTime).getTime());
  const shift = (/** @type {number} */ dir) => {
    setTimeRange({
      start: new Date(/** @type {Date} */ (start).getTime() + windowMs * dir),
      end: new Date(/** @type {Date} */ (end).getTime() + windowMs * dir),
    });
  };

  return html`
    <div
      class="bg-white/90 rounded-lg shadow px-3 py-2 text-xs font-sans select-none"
    >
      <div class="flex items-center justify-between gap-1">
        <input
          type="date"
          class="bg-transparent text-xs"
          value=${fmtDate(start)}
          min=${fmtDate(minTime)}
          max=${startMax}
          onChange=${(/** @type {Event & { target: HTMLInputElement }} */ e) =>
            setStart(
              e.target.value
                ? toDate(e.target.value, fmtTime(start))
                : undefined,
            )}
        />
        <input
          type="time"
          class="bg-transparent text-xs"
          value=${fmtTime(start)}
          disabled=${!start}
          onChange=${(/** @type {Event & { target: HTMLInputElement }} */ e) =>
            setStart(toDate(fmtDate(start), e.target.value))}
        />
        <span class="text-xs">–</span>
        <input
          type="date"
          class="bg-transparent text-xs"
          value=${fmtDate(end)}
          min=${endMin}
          max=${fmtDate(maxTime)}
          onChange=${(/** @type {Event & { target: HTMLInputElement }} */ e) =>
            setEnd(
              e.target.value ? toDate(e.target.value, fmtTime(end)) : undefined,
            )}
        />
        <input
          type="time"
          class="bg-transparent text-xs"
          value=${fmtTime(end)}
          disabled=${!end}
          onChange=${(/** @type {Event & { target: HTMLInputElement }} */ e) =>
            setEnd(toDate(fmtDate(end), e.target.value))}
        />
      </div>
      <div class="flex items-center gap-1 pt-1">
        <button
          class="flex-1 px-1.5 py-0.5 rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-30"
          disabled=${!canShiftBack}
          onClick=${() => shift(-1)}
        >
          ${"<"} ${hasWindow ? formatDuration(windowMs) : ""}
        </button>
        <button
          class="flex-1 px-1.5 py-0.5 rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-30"
          disabled=${!canShiftForward}
          onClick=${() => shift(1)}
        >
          ${hasWindow ? formatDuration(windowMs) : ""} ${">"}
        </button>
      </div>
    </div>
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
      class="bg-white/90 rounded-lg shadow px-3 py-2 text-xs font-sans select-none min-w-40"
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

// prettier-ignore
const frequentPaint = (/** @type {number} */ blend) => ({
  "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 0, BASE_OPACITY[0] * (1 - blend), 14, BASE_OPACITY[1] * (1 - blend), 18, BASE_OPACITY[2] * (1 - blend)],
  "heatmap-weight": ["interpolate", ["exponential", 0.5], ["get", "weight"], 1, 0, 10, 0.03, 50, 0.15, 200, 0.4, 1000, 0.75, 10000, 1],
  "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 2, 5, 2.5, 8, 2.5, 12, 3, 15, 3, 18, 5],
  "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 12, 5, 28, 10, 30, 14, 25, 16, 15, 18, 10],
  "heatmap-color": [
    "interpolate", ["linear"], ["heatmap-density"],
    0, "rgba(29, 78, 216, 0)",        // blue-700
    0.1, "rgba(37, 99, 235, 0.3)",    // blue-600
    0.3, "rgba(59, 130, 246, 0.5)",   // blue-500
    0.5, "rgba(52, 211, 153, 0.6)",   // emerald-400
    0.7, "rgba(250, 204, 21, 0.8)",   // yellow-400
    1, "#ef4444",                      // red-500
  ],
});

// prettier-ignore
const explorePaint = (/** @type {number} */ blend) => ({
  "circle-opacity": blend,
  "circle-color": ["interpolate", ["exponential", 0.5], ["get", "weight"], 1, "rgba(37, 99, 235, 0.3)", 10, "rgba(220, 38, 38, 0.8)", 50, "rgba(245, 158, 11, 0.7)", 200, "rgba(56, 189, 248, 0.4)", 1000, "rgba(37, 99, 235, 0.25)", 10000, "rgba(29, 78, 216, 0.1)"],
  "circle-radius": [
    "interpolate", ["linear"], ["zoom"],
    0, ["interpolate", ["exponential", 0.5], ["get", "weight"], 1, 2, 10, 4, 50, 3, 200, 2, 1000, 1.5, 10000, 1],
    10, ["interpolate", ["exponential", 0.5], ["get", "weight"], 1, 3.5, 10, 8, 50, 6, 200, 4, 1000, 3, 10000, 2],
    16, ["interpolate", ["exponential", 0.5], ["get", "weight"], 1, 5, 10, 12, 50, 9, 200, 6, 1000, 4, 10000, 3],
  ],
  "circle-blur": 0.4,
});

// prettier-ignore
const taggedPaint = (/** @type {string} */ colour) => ({
  "circle-color": colour,
  "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 3, 10, 6, 16, 9],
  "circle-opacity": 0.9,
  "circle-blur": 0.1,
  "circle-stroke-color": "#ffffff",
  "circle-stroke-width": 1.5,
  "circle-stroke-opacity": 0.9,
});

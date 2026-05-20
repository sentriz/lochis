// @ts-check

/** @import { ViewStateChangeEvent } from "@vis.gl/react-maplibre" */
/** @import { MapLibreEvent, Map as MapLibreMap } from "maplibre-gl" */

import React, {
  useState,
  useRef,
  useEffect,
  useSyncExternalStore,
} from "react";
import ReactDOM from "react-dom/client";
import htm from "htm";
import { Map, Source, Layer } from "@vis.gl/react-maplibre";

const html = htm.bind(React.createElement);

/** @typedef {{ type: "FeatureCollection", features: object[] }} FeatureCollection */
/** @typedef {{ id: number, name: string, colour: string }} Tag */
/** @typedef {{ id: number, time: string, speed: number, altitude: number, latitude: number, longitude: number }} History */
/** @typedef {{ name: string, latitude: number, longitude: number, country: string, population: number }} City */
/** @typedef {{ history: History, city?: City}} Now */
/** @typedef {{ start: string, count: number }} Bucket */

/** @type {FeatureCollection} */
const EMPTY_FC = { type: "FeatureCollection", features: [] };

/** @typedef {{ maptiler_api_key: string, tags: Tag[], min_time?: string, max_time?: string }} Config */

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

  const lat = useHash("lt", Number, 51.5);
  const lng = useHash("lg", Number, 0);
  const zoom = useHash("z", Number, 2);
  const bearing = useHash("b", Number, 0);
  const pitch = useHash("p", Number, 0);
  const start = useHash("s", String);
  const end = useHash("e", String);
  const gran = useHash("g", String, BUCKETS[0].label);
  const [geojson, setGeojson] = useState(EMPTY_FC);
  const [histogram, setHistogram] = useState(/** @type {Bucket[]} */ ([]));
  /** @type {React.RefObject<MapLibreMap | null>} */
  const mapRef = useRef(null);

  const loadGeojson = async (
    /** @type {URLSearchParams} */ params,
    /** @type {AbortSignal} */ signal,
  ) => {
    try {
      const resp = await fetch(`/geojson/history?${params}`, { signal });
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

  const loadHistogram = async (
    /** @type {URLSearchParams} */ params,
    /** @type {AbortSignal} */ signal,
  ) => {
    try {
      const resp = await fetch(`/histogram/history?${params}`, { signal });
      setHistogram(await resp.json());
    } catch (/** @type {any} */ e) {
      if (e.name !== "AbortError") throw e;
    }
  };

  const loadData = (/** @type {MapLibreMap} */ map) => {
    if (controllerRef.current) controllerRef.current.abort();
    controllerRef.current = new AbortController();
    const { signal } = controllerRef.current;

    const bounds = map.getBounds();
    const params = new URLSearchParams({
      west: String(bounds.getWest()),
      south: String(bounds.getSouth()),
      east: String(bounds.getEast()),
      north: String(bounds.getNorth()),
    });

    const geoParams = new URLSearchParams(params);
    geoParams.set("zoom", String(map.getZoom()));
    if (start) geoParams.set("start", start);
    if (end) geoParams.set("end", end);

    const bucket = BUCKETS.find((b) => b.label === gran) ?? BUCKETS[0];
    const histParams = new URLSearchParams(params);
    histParams.set("fmt", bucket.fmt);

    loadGeojson(geoParams, signal);
    loadHistogram(histParams, signal);
  };

  useEffect(() => {
    if (mapRef.current) loadData(mapRef.current);
  }, [start, end, gran]);

  const onMoveEnd = (/** @type {ViewStateChangeEvent} */ e) => {
    const m = e.target;
    const c = m.getCenter();
    setHash({
      lt: c.lat.toFixed(5),
      lg: c.lng.toFixed(5),
      z: m.getZoom().toFixed(2),
      b: Math.abs(m.getBearing()) > 0.1 ? m.getBearing().toFixed(1) : undefined,
      p: Math.abs(m.getPitch()) > 0.1 ? m.getPitch().toFixed(1) : undefined,
    });
    loadData(m);
  };
  const onLoad = (/** @type {MapLibreEvent} */ e) => loadData(e.target);

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
  const [nowVisible, setNowVisible] = useState(true);

  return html`
    <${Map}
      ref=${mapRef}
      initialViewState=${{
        latitude: lat,
        longitude: lng,
        zoom,
        bearing,
        pitch,
      }}
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
            layout=${{
              visibility: nowIsRecent && nowVisible ? "visible" : "none",
            }}
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
    <div
      class="absolute bottom-4 left-4 right-4 z-10 flex flex-col gap-2 max-w-sm"
    >
      <${Histogram}
        data=${histogram}
        selectedStart=${start}
        selectedEnd=${end}
        gran=${gran}
        setGran=${(/** @type {string} */ g) =>
          setHash({
            g: g === BUCKETS[0].label ? undefined : g,
            s: undefined,
            e: undefined,
          })}
        onToggle=${(
          /** @type {string} */ s,
          /** @type {string | undefined} */ e,
          /** @type {boolean} */ extend,
        ) => {
          if (extend && start) {
            const newS = s < start ? s : start;
            const newE =
              end === undefined || e === undefined
                ? undefined
                : e > end
                  ? e
                  : end;
            setHash({ s: newS, e: newE });
            return;
          }
          const sel = start === s;
          setHash({
            s: sel ? undefined : s,
            e: sel ? undefined : e,
          });
        }}
      />
      <${LayerControls}
        blend=${blend}
        setBlend=${setBlend}
        historyVisible=${historyVisible}
        setHistoryVisible=${setHistoryVisible}
        tags=${tags}
        hiddenTags=${hiddenTags}
        toggleTag=${toggleTag}
        nowIsRecent=${nowIsRecent}
        nowVisible=${nowVisible}
        setNowVisible=${setNowVisible}
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

/** @param {{ data: Bucket[], selectedStart: string | undefined, selectedEnd: string | undefined, gran: string, setGran: (g: string) => void, onToggle: (start: string, end: string | undefined, extend: boolean) => void }} props */
function Histogram({
  data,
  selectedStart,
  selectedEnd,
  gran,
  setGran,
  onToggle,
}) {
  const max = data.length ? Math.max(...data.map((d) => d.count)) : 0;
  return html`
    <div
      class="bg-white/90 rounded-lg shadow px-3 py-2 text-xs font-sans select-none"
    >
      <div class="flex justify-end gap-1 mb-1">
        ${BUCKETS.map(
          (b) => html`
            <button
              key=${b.label}
              class=${`px-1.5 rounded ${gran === b.label ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700 hover:bg-gray-300"}`}
              onClick=${() => setGran(b.label)}
            >
              ${b.label}
            </button>
          `,
        )}
      </div>
      <div class="flex gap-0.5 h-20 overflow-x-auto overflow-y-hidden">
        ${data.flatMap((d, i) => {
          const selected =
            selectedStart !== undefined &&
            d.start >= selectedStart &&
            (selectedEnd === undefined || d.start < selectedEnd);
          const dimmed = selectedStart !== undefined && !selected;
          const barColour = selected
            ? "bg-blue-600"
            : dimmed
              ? "bg-blue-500/20"
              : "bg-blue-500/60";
          const labelColour = selected
            ? "text-gray-900"
            : dimmed
              ? "text-gray-400"
              : "text-gray-500";
          const bar = html`
            <div
              key=${d.start}
              class="flex-1 flex flex-col cursor-pointer min-w-10 hover:opacity-80"
              onClick=${(/** @type {MouseEvent} */ ev) =>
                onToggle(d.start, data[i + 1]?.start, ev.shiftKey)}
              title=${`${d.start}: ${d.count.toLocaleString()}`}
            >
              <div class="flex-1 flex items-end">
                <div
                  class=${`w-full rounded-t-sm ${barColour}`}
                  style=${{
                    height: `${(d.count / max) * 100}%`,
                    minHeight: d.count > 0 ? "5px" : 0,
                  }}
                />
              </div>
              <div
                class=${`text-[10px] text-center leading-none mt-1 ${labelColour}`}
              >
                ${d.start}
              </div>
            </div>
          `;
          const after = data[i + 1];
          if (after && nextStart(d.start) !== after.start) {
            return [
              bar,
              html`<div key=${`gap-${d.start}`} class="w-2 shrink-0" />`,
            ];
          }
          return [bar];
        })}
      </div>
    </div>
  `;
}

/**
 * @param {{ blend: number, setBlend: (v: number) => void, historyVisible: boolean, setHistoryVisible: (v: boolean) => void, tags: Tag[], hiddenTags: Set<number>, toggleTag: (id: number) => void, nowIsRecent: boolean, nowVisible: boolean, setNowVisible: (v: boolean) => void }} props
 */
function LayerControls({
  blend,
  setBlend,
  historyVisible,
  setHistoryVisible,
  tags,
  hiddenTags,
  toggleTag,
  nowIsRecent,
  nowVisible,
  setNowVisible,
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
      ${nowIsRecent &&
      html`
        <div class="flex items-center gap-2 py-1">
          <input
            type="checkbox"
            checked=${nowVisible}
            onChange=${() => setNowVisible(!nowVisible)}
          />
          <span class="shrink-0 size-2.5 rounded-full bg-blue-500" />
          <span class="text-xs">Now</span>
        </div>
      `}
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

/**
 * @template T
 * @param {string} key
 * @param {(v: string) => T} parse
 * @param {T} [initial]
 * @returns {T | undefined}
 */
function useHash(key, parse, initial) {
  const raw = useSyncExternalStore(
    (cb) => {
      addEventListener("hashchange", cb);
      return () => removeEventListener("hashchange", cb);
    },
    () => parseHash()[key],
  );
  return raw !== undefined ? parse(raw) : initial;
}

/** @param {Record<string, any>} params - falsy values remove the key */
function setHash(params) {
  const h = { ...parseHash(), ...params };
  for (const k of Object.keys(h)) if (!h[k]) delete h[k];
  const s = Object.entries(h)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  history.replaceState(null, "", s ? "#" + s : location.pathname);
  dispatchEvent(new HashChangeEvent("hashchange"));
}

const parseHash = () =>
  Object.fromEntries(
    location.hash
      .replace(/^#/, "")
      .split(",")
      .filter(Boolean)
      .map((s) => s.split("=")),
  );

/** @type {{ label: string, fmt: string }[]} */
const BUCKETS = [
  { label: "Y", fmt: "%Y" },
  { label: "M", fmt: "%Y-%m" },
  { label: "D", fmt: "%Y-%m-%d" },
];

/** @param {string} s */
function nextStart(s) {
  const parts = s.split("-").map(Number);
  parts[parts.length - 1]++;
  // Date does the rollover (e.g. month 13 -> jan next year).
  const d = new Date(parts[0], (parts[1] ?? 1) - 1, parts[2] ?? 1);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ]
    .slice(0, parts.length)
    .join("-");
}

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

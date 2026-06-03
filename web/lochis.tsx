import { useState, useEffect, useSyncExternalStore } from "react";
import type { CSSProperties, ReactNode, MouseEvent } from "react";
import ReactDOM from "react-dom/client";
import { createPortal } from "react-dom";
import { Map, Source, Layer, Marker } from "@vis.gl/react-maplibre";
import type {
  MapLibreEvent,
  Map as MapLibreMap,
  LngLatBounds,
  HeatmapLayerSpecification,
  CircleLayerSpecification,
} from "maplibre-gl";
import type { Feature } from "geojson";

type FeatureCollection = { type: "FeatureCollection"; features: Feature[] };
type TagResp = { id: number; name: string; colour: string };
type HistoryResp = {
  id: number;
  time: string;
  speed: number;
  altitude: number;
  latitude: number;
  longitude: number;
};
type CityResp = {
  name: string;
  latitude: number;
  longitude: number;
  country: string;
  population: number;
};
type NowResp = { history: HistoryResp; city?: CityResp };
type BucketResp = { start: string; count: number };
type StatsResp = { distance_km: number; points: number };
type Config = {
  maptiler_api_key: string;
  tags: TagResp[];
  min_time?: string;
  max_time?: string;
};

const EMPTY_FC: FeatureCollection = { type: "FeatureCollection", features: [] };

function App() {
  const lat = useHash("lt", Number, 51.5);
  const lng = useHash("lg", Number, 0);
  const zoom = useHash("z", Number, 2);
  const bearing = useHash("b", Number, 0);
  const pitch = useHash("p", Number, 0);
  const start = useHash("s", String);
  const end = useHash("e", String);
  const gran = useHash("g", String, BUCKETS[0].label);

  const config = useFetch<Config>("/config", parseJSON);
  const now = useFetch<NowResp>("/now", parseJSON);

  const { geoJSON, histogram, stats, captureViewport } = useMapData({
    start,
    end,
    gran,
  });

  const syncMap = (e: MapLibreEvent) => {
    const m = e.target;
    const c = m.getCenter();
    setHash({
      lt: c.lat.toFixed(5),
      lg: c.lng.toFixed(5),
      z: m.getZoom().toFixed(2),
      b: Math.abs(m.getBearing()) > 0.1 ? m.getBearing().toFixed(1) : undefined,
      p: Math.abs(m.getPitch()) > 0.1 ? m.getPitch().toFixed(1) : undefined,
    });
    captureViewport(m);
  };

  const [historySlot, setHistorySlot] = useState<HTMLDivElement | null>(null);
  const [tagsSlot, setTagsSlot] = useState<HTMLDivElement | null>(null);
  const [nowSlot, setNowSlot] = useState<HTMLDivElement | null>(null);

  return (
    <>
      <Map
        initialViewState={{
          latitude: lat,
          longitude: lng,
          zoom,
          bearing,
          pitch,
        }}
        onIdle={syncMap}
        style={{ width: "100%", height: "100%" }}
        mapStyle={
          config
            ? `https://api.maptiler.com/maps/basic/style.json?key=${config.maptiler_api_key}`
            : undefined
        }
      >
        <Source id="history" type="geojson" data={geoJSON}>
          <History slot={historySlot} />
          <Tags tags={config?.tags ?? []} slot={tagsSlot} />
        </Source>
        <Now now={now} slot={nowSlot} />
      </Map>
      <Panel className="absolute top-4 right-4 z-10 px-3 py-2 flex divide-x divide-gray-200">
        <Stat
          label="Distance"
          value={
            stats === undefined
              ? "…"
              : `${Math.round(stats.distance_km).toLocaleString()} km`
          }
        />
        <Stat
          label="Points"
          value={stats === undefined ? "…" : stats.points.toLocaleString()}
        />
      </Panel>
      <div className="absolute bottom-4 left-4 right-4 z-10 flex flex-col gap-2 max-w-sm">
        <Histogram data={histogram} start={start} end={end} gran={gran} />
        <Panel className="px-3 py-2 min-w-40">
          <div ref={setHistorySlot} />
          <div ref={setNowSlot} />
          <div ref={setTagsSlot} />
        </Panel>
      </div>
    </>
  );
}

function History({ slot }: { slot: HTMLElement | null }) {
  const [visible, setVisible] = useState(true);
  const [blend, setBlend] = useState(0.25); // 0 = frequent, 1 = explore

  const dim = `text-xs ${visible ? "text-gray-500" : "text-gray-300"}`;

  return (
    <>
      <Layer
        id="frequent"
        source="history"
        type="heatmap"
        filter={["!", ["has", "tag_id"]]}
        layout={visibility(visible)}
        paint={frequentPaint(blend)}
      />
      <Layer
        id="explore"
        source="history"
        type="circle"
        filter={["!", ["has", "tag_id"]]}
        layout={visibility(visible)}
        paint={explorePaint(blend)}
      />
      {slot &&
        createPortal(
          <>
            <ToggleRow
              checked={visible}
              onChange={() => setVisible(!visible)}
              swatch={
                <Swatch
                  style={{
                    background:
                      "conic-gradient(#2563eb, #34d399, #facc15, #ef4444, #2563eb)",
                  }}
                />
              }
              label="History"
            />
            <div className="flex items-center gap-2 pb-1 pl-1">
              <span className={dim}>Frequent</span>
              <input
                className="flex-1"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={blend}
                disabled={!visible}
                onInput={(e) => setBlend(parseFloat(e.currentTarget.value))}
              />
              <span className={dim}>Explore</span>
            </div>
          </>,
          slot,
        )}
    </>
  );
}

function Tags({ tags, slot }: { tags: TagResp[]; slot: HTMLElement | null }) {
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const toggle = (id: number) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      {tags.map((t) => (
        <Layer
          key={`tag-${t.id}`}
          id={`tag-${t.id}`}
          source="history"
          type="circle"
          filter={["==", ["get", "tag_id"], t.id]}
          layout={visibility(!hidden.has(t.id))}
          paint={taggedPaint(t.colour)}
        />
      ))}
      {slot &&
        tags.length > 0 &&
        createPortal(
          <>
            {tags.map((t) => (
              <ToggleRow
                key={t.id}
                checked={!hidden.has(t.id)}
                onChange={() => toggle(t.id)}
                swatch={
                  t.colour ? (
                    <Swatch style={{ backgroundColor: t.colour }} />
                  ) : undefined
                }
                label={`Tag ${t.name}`}
              />
            ))}
          </>,
          slot,
        )}
    </>
  );
}

function Now({
  now,
  slot,
}: {
  now: NowResp | undefined;
  slot: HTMLElement | null;
}) {
  const [visible, setVisible] = useState(true);
  if (!now) return null;

  const recent =
    Date.now() - new Date(now.history.time).getTime() < 20 * 60 * 1000;

  return (
    <>
      {visible && (
        <Marker
          longitude={now.history.longitude}
          latitude={now.history.latitude}
        >
          <div className="inline-flex rounded-full ring-2 ring-white shadow-md">
            {recent ? (
              <PulseDot className="size-3" />
            ) : (
              <span className="block size-3 rounded-full bg-blue-500/50" />
            )}
          </div>
        </Marker>
      )}
      {createPortal(
        <LastSeen
          time={now.history.time}
          speed={now.history.speed}
          altitude={now.history.altitude}
          city={now.city}
          recent={recent}
        />,
        document.body,
      )}
      {slot &&
        createPortal(
          <ToggleRow
            checked={visible}
            onChange={() => setVisible(!visible)}
            swatch={<Swatch className="bg-blue-500" />}
            label="Now"
          />,
          slot,
        )}
    </>
  );
}

function LastSeen({
  time,
  speed,
  altitude,
  city,
  recent,
}: {
  time: string;
  speed: number;
  altitude: number;
  city?: CityResp;
  recent: boolean;
}) {
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

  return (
    <Panel className="absolute top-4 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 whitespace-nowrap flex items-center gap-1.5">
      {recent && <PulseDot />}
      <span>{parts.join(" · ")}</span>
    </Panel>
  );
}

function Histogram({
  data,
  start,
  end,
  gran,
}: {
  data: BucketResp[];
  start: string | undefined;
  end: string | undefined;
  gran: string;
}) {
  const max = data.length ? Math.max(...data.map((d) => d.count)) : 0;

  const isSelected = (bucket: string) =>
    start !== undefined &&
    bucket >= start &&
    (end === undefined || bucket < end);

  const selectedBars = data.filter((d) => isSelected(d.start));
  const rangeLabel =
    selectedBars.length > 1
      ? `${selectedBars[0].start} – ${selectedBars[selectedBars.length - 1].start}`
      : selectedBars.length === 1
        ? selectedBars[0].start
        : start;

  const changeGran = (g: string) =>
    setHash({
      g: g === BUCKETS[0].label ? undefined : g,
      s: undefined,
      e: undefined,
    });

  const clear = () => setHash({ s: undefined, e: undefined });

  const toggleRange = (s: string, e: string | undefined, extend: boolean) => {
    if (extend && start) {
      const newS = s < start ? s : start;
      const newE =
        end === undefined || e === undefined ? undefined : e > end ? e : end;
      setHash({ s: newS, e: newE });
      return;
    }
    const sel = start === s;
    setHash({ s: sel ? undefined : s, e: sel ? undefined : e });
  };

  return (
    <Panel className="px-3 py-2">
      <div className="flex justify-between items-center gap-1 mb-1">
        <div>
          {start !== undefined && (
            <button
              className="flex items-center gap-1 px-1.5 rounded bg-blue-600 text-white hover:bg-blue-700"
              onClick={clear}
            >
              <span>{rangeLabel}</span>
              <span className="text-white/70">✕</span>
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-gray-400 mr-0.5">Group by</span>
          {BUCKETS.map((b) => (
            <button
              key={b.label}
              className={`px-1.5 rounded ${gran === b.label ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700 hover:bg-gray-300"}`}
              onClick={() => changeGran(b.label)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-0.5 h-20 overflow-x-auto overflow-y-hidden">
        {data.flatMap((d, i) => {
          const after = data[i + 1];
          const selected = isSelected(d.start);
          const dimmed = start !== undefined && !selected;
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
          const bar = (
            <div
              key={d.start}
              className="flex-1 flex flex-col cursor-pointer min-w-10 hover:opacity-80"
              onClick={(ev: MouseEvent) =>
                toggleRange(d.start, after?.start, ev.shiftKey)
              }
              title={`${d.start}: ${d.count.toLocaleString()}`}
            >
              <div className="flex-1 flex items-end">
                <div
                  className={`w-full rounded-t-sm ${barColour}`}
                  style={{
                    height: `${(d.count / max) * 100}%`,
                    minHeight: d.count > 0 ? "5px" : 0,
                  }}
                />
              </div>
              <div
                className={`text-xs text-center leading-none mt-1 ${labelColour}`}
              >
                {d.start}
              </div>
            </div>
          );
          if (after && nextStart(d.start) !== after.start) {
            return [
              bar,
              <div key={`gap-${d.start}`} className="w-2 shrink-0" />,
            ];
          }
          return [bar];
        })}
      </div>
    </Panel>
  );
}

function Panel({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`bg-white/90 rounded-lg shadow text-xs font-sans select-none ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 first:pl-0 last:pr-0">
      <div className="text-gray-400">{label}</div>
      <div className="tabular-nums text-gray-800">{value}</div>
    </div>
  );
}

function Swatch({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={`shrink-0 size-2.5 rounded-full ${className ?? ""}`}
      style={style}
    />
  );
}

function PulseDot({ className }: { className?: string }) {
  return (
    <span className={`relative flex ${className ?? "size-2.5"}`}>
      <span className="animate-ping absolute inline-flex size-full rounded-full bg-blue-400 opacity-75" />
      <span className="relative inline-flex size-full rounded-full bg-blue-500" />
    </span>
  );
}

function ToggleRow({
  checked,
  onChange,
  swatch,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  swatch?: ReactNode;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 py-1">
      <input type="checkbox" checked={checked} onChange={onChange} />
      {swatch}
      <span className="text-xs">{label}</span>
    </div>
  );
}

ReactDOM.createRoot(document.body).render(<App />);

const visibility = (visible: boolean) => ({
  visibility: (visible ? "visible" : "none") as "visible" | "none",
});

const BASE_OPACITY = [0.9, 0.7, 0.5];

// prettier-ignore
const frequentPaint = (blend: number): HeatmapLayerSpecification["paint"] => ({
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
const explorePaint = (blend: number): CircleLayerSpecification["paint"] => ({
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
const taggedPaint = (colour: string): CircleLayerSpecification["paint"] => ({
  "circle-color": colour,
  "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 3, 10, 6, 16, 9],
  "circle-opacity": 0.9,
  "circle-blur": 0.1,
  "circle-stroke-color": "#ffffff",
  "circle-stroke-width": 1.5,
  "circle-stroke-opacity": 0.9,
});

function useFetch<T>(
  url: string | null,
  parse: (resp: Response) => Promise<T>,
): T | undefined {
  const [data, setData] = useState<T | undefined>(undefined);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    fetchAborting(url, controller.signal, async (resp) => {
      if (resp.ok) setData(await parse(resp));
    });
    return () => controller.abort();
  }, [url]);
  return data;
}

function useMapData({
  start,
  end,
  gran,
}: {
  start?: string;
  end?: string;
  gran?: string;
}) {
  const [viewport, setViewport] = useState<{
    bounds: LngLatBounds;
    zoom: number;
  } | null>(null);

  const captureViewport = (map: MapLibreMap) =>
    setViewport({ bounds: map.getBounds(), zoom: map.getZoom() });

  let geoUrl: string | null = null;
  let histUrl: string | null = null;
  let statsUrl: string | null = null;
  if (viewport) {
    const params = new URLSearchParams({
      west: String(viewport.bounds.getWest()),
      south: String(viewport.bounds.getSouth()),
      east: String(viewport.bounds.getEast()),
      north: String(viewport.bounds.getNorth()),
    });

    const geoParams = new URLSearchParams(params);
    geoParams.set("zoom", String(viewport.zoom));
    if (start) geoParams.set("start", start);
    if (end) geoParams.set("end", end);

    geoUrl = `/geojson/history?${geoParams}`;
    statsUrl = `/stats/history?${geoParams}`;

    const bucket = BUCKETS.find((b) => b.label === gran) ?? BUCKETS[0];
    const histParams = new URLSearchParams(params);
    histParams.set("fmt", bucket.fmt);

    histUrl = `/histogram/history?${histParams}`;
  }

  const geoJSON = useFetch(geoUrl, parseGeoJSON) ?? EMPTY_FC;
  const histogram = useFetch<BucketResp[]>(histUrl, parseJSON) ?? [];
  const stats = useFetch<StatsResp>(statsUrl, parseJSON);

  return { geoJSON, histogram, stats, captureViewport };
}

async function parseGeoJSON(resp: Response): Promise<FeatureCollection> {
  const trimmed = (await resp.text()).trim();
  const features = trimmed
    ? JSON.parse("[" + trimmed.replaceAll("\n", ",") + "]")
    : [];
  return { type: "FeatureCollection", features };
}

const parseJSON = (resp: Response) => resp.json();

async function fetchAborting(
  url: string,
  signal: AbortSignal,
  handle: (resp: Response) => Promise<void>,
) {
  try {
    await handle(await fetch(url, { signal }));
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return;
    throw e;
  }
}

function useHash<T>(key: string, parse: (v: string) => T, initial: T): T;
function useHash<T>(key: string, parse: (v: string) => T): T | undefined;
function useHash<T>(
  key: string,
  parse: (v: string) => T,
  initial?: T,
): T | undefined {
  const raw = useSyncExternalStore(
    (cb) => {
      addEventListener("hashchange", cb);
      return () => removeEventListener("hashchange", cb);
    },
    () => parseHash()[key],
  );
  return raw !== undefined ? parse(raw) : initial;
}

/** falsy values remove the key */
function setHash(params: Record<string, string | undefined>) {
  const h: Record<string, string | undefined> = { ...parseHash(), ...params };
  for (const k of Object.keys(h)) if (!h[k]) delete h[k];
  const s = Object.entries(h)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  history.replaceState(null, "", s ? "#" + s : location.pathname);
  dispatchEvent(new HashChangeEvent("hashchange"));
}

const parseHash = (): Record<string, string> =>
  Object.fromEntries(
    location.hash
      .replace(/^#/, "")
      .split(",")
      .filter(Boolean)
      .map((s) => s.split("=")),
  );

const BUCKETS: { label: string; fmt: string }[] = [
  { label: "Y", fmt: "%Y" },
  { label: "M", fmt: "%Y-%m" },
  { label: "D", fmt: "%Y-%m-%d" },
];

function nextStart(s: string) {
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

const formatDuration = (ms: number) => {
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

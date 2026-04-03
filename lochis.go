package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"database/sql"
	"embed"
	"encoding/csv"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"time"

	_ "github.com/ncruces/go-sqlite3/driver"
	"github.com/ncruces/go-sqlite3/util/ioutil"
	"github.com/ncruces/go-sqlite3/vfs/readervfs"
	"go.senan.xyz/flagconf"
	"go.senan.xyz/sqlb"
	"golang.org/x/tools/txtar"
)

var (
	//go:embed schema.sql
	schema []byte
	//go:embed cities.db
	citiesDB []byte
	//go:embed index.html lochis.js
	indexFS embed.FS
)

func main() {
	var (
		listenAddr = flag.String("listen-addr", "", "listen addr")
		dbPath     = flag.String("db-path", "lochis.db", "DB path")
		apiKey     = flag.String("api-key", "", "API key")
	)
	flag.Parse()
	flagconf.ParseEnv()

	if *listenAddr == "" {
		slog.Error("need a listen addr")
		return
	}
	if *dbPath == "" {
		slog.Error("need a DB path")
		return
	}
	if *apiKey == "" {
		slog.Error("need an API key")
		return
	}

	dbURI, _ := url.Parse("file://?cache=shared&_fk=1")
	dbURI.Opaque = *dbPath
	db, err := sql.Open("sqlite3", dbURI.String())
	if err != nil {
		slog.Error("open db template", "err", err)
		return
	}
	defer db.Close()

	ctx := context.Background()
	if lev := slog.LevelInfo; slog.Default().Enabled(context.Background(), lev) {
		ctx = sqlb.WithLogFunc(ctx, func(ctx context.Context, typ string, query string, duration time.Duration) {
			slog.Log(ctx, lev, typ, "took", duration, "query", query)
		})
	}

	if err := dbMigrate(ctx, db); err != nil {
		slog.ErrorContext(ctx, "migrate db", "err", err)
		return
	}

	readervfs.Create("cities", ioutil.NewSizeReaderAt(bytes.NewReader(citiesDB)))
	cdb, err := sql.Open("sqlite3", "file:cities?vfs=reader")
	if err != nil {
		slog.ErrorContext(ctx, "open cities db", "err", err)
		return
	}
	defer cdb.Close()

	mux := http.NewServeMux()

	mux.HandleFunc("GET /geojson/history", func(w http.ResponseWriter, r *http.Request) {
		params := r.URL.Query()

		south, _ := strconv.ParseFloat(params.Get("south"), 64)
		north, _ := strconv.ParseFloat(params.Get("north"), 64)
		west, _ := strconv.ParseFloat(params.Get("west"), 64)
		east, _ := strconv.ParseFloat(params.Get("east"), 64)
		zoom, _ := strconv.ParseFloat(params.Get("zoom"), 64)

		q := sqlb.NewQuery(`
			select avg(latitude) as lat, avg(longitude) as lng, avg(altitude) as alt, count(*) as weight, coalesce(tag_id, 0) as tag_id
			from history
			where latitude between ? and ? and longitude between ? and ?`,
			south, north, west, east,
		)
		if v := params.Get("start"); v != "" {
			q.Append("and time >= ?", v)
		}
		if v := params.Get("end"); v != "" {
			q.Append("and time <= ?", v)
		}

		gridSize := 3.6 / math.Pow(2, zoom)
		q.Append("group by round(latitude / ?), round(longitude / ?), tag_id", gridSize, gridSize)

		var f Feature
		f.Type = "Feature"
		f.Geometry.Type = "Point"

		enc := json.NewEncoder(w)
		for err := range sqlb.Each(r.Context(), db, sqlb.Into(&f.Geometry.Coordinates[1], &f.Geometry.Coordinates[0], &f.Geometry.Coordinates[2], &f.Properties.Weight, &f.Properties.TagID), "?", q) {
			if err != nil {
				slog.ErrorContext(ctx, "scan grouped history", "err", err)
				continue
			}
			enc.Encode(&f)
		}
	})

	mux.HandleFunc("GET /tags", func(w http.ResponseWriter, r *http.Request) {
		var tags []Tag
		if err := sqlb.QueryRows(r.Context(), db, sqlb.Append(&tags), "select * from tags"); err != nil {
			http.Error(w, "error reading tags", http.StatusInternalServerError)
			return
		}
		if err := json.NewEncoder(w).Encode(tags); err != nil {
			http.Error(w, "error sending json", http.StatusInternalServerError)
			return
		}
	})

	mux.HandleFunc("POST /now", func(w http.ResponseWriter, r *http.Request) {
		var h History
		h.Latitude, _ = strconv.ParseFloat(r.FormValue("lat"), 64)
		h.Longitude, _ = strconv.ParseFloat(r.FormValue("lng"), 64)
		h.Time, _ = time.Parse(time.RFC3339Nano, r.FormValue("time"))
		h.Speed, _ = strconv.ParseFloat(r.FormValue("speed"), 64)
		h.Altitude, _ = strconv.ParseFloat(r.FormValue("alt"), 64)

		if err := sqlb.Exec(r.Context(), db, "insert into history ?", sqlb.InsertSQL(h)); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	})

	mux.HandleFunc("GET /now", func(w http.ResponseWriter, r *http.Request) {
		var h History
		if err := sqlb.QueryRow(r.Context(), db, &h, "select * from history where tag_id is null order by time desc limit 1"); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		const spread = 0.5

		var city City
		if err := sqlb.QueryRow(r.Context(), cdb, &city, `
			select *
			from cities
			where latitude between ? and ? and longitude between ? and ?
			order by (latitude-?)*(latitude-?) + (longitude-?)*(longitude-?) asc
			limit 1`,
			h.Latitude-spread, h.Latitude+spread, h.Longitude-spread, h.Longitude+spread,
			h.Latitude, h.Latitude, h.Longitude, h.Longitude,
		); err != nil && !errors.Is(err, sql.ErrNoRows) {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		resp := struct {
			History History `json:"history"`
			City    City    `json:"city,omitzero"`
		}{
			History: h,
			City:    city,
		}

		if err := json.NewEncoder(w).Encode(resp); err != nil {
			http.Error(w, "error sending json", http.StatusInternalServerError)
			return
		}
	})

	mux.HandleFunc("POST /import", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		if err := importData(r.Context(), db, r.Body); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	})

	mux.Handle("GET /", http.FileServer(http.FS(indexFS)))

	var handler http.Handler = mux
	handler = authMiddleware(handler, *apiKey)
	handler = logMiddleware(handler)

	server := &http.Server{
		Addr:        *listenAddr,
		Handler:     handler,
		BaseContext: func(l net.Listener) context.Context { return ctx },
	}

	slog.InfoContext(ctx, "starting http", "listen_addr", *listenAddr)

	if err := server.ListenAndServe(); err != nil {
		slog.ErrorContext(ctx, "start http", "err", err)
		return
	}
}

type GeoJSON struct {
	Type     string    `json:"type"`
	Features []Feature `json:"features"`
}

type Feature struct {
	Type       string     `json:"type"`
	Geometry   Geometry   `json:"geometry"`
	Properties Properties `json:"properties,omitzero"`
}

type Geometry struct {
	Type        string     `json:"type"`
	Coordinates [3]float64 `json:"coordinates"`
}

type Properties struct {
	Weight int `json:"weight"`
	TagID  int `json:"tag_id,omitempty"`
}

//go:generate go tool sqlbgen type History generated ID type Tag generated ID type City -- lochis.gen.go

type City struct {
	Name       string  `json:"name"`
	Latitude   float64 `json:"latitude"`
	Longitude  float64 `json:"longitude"`
	Country    string  `json:"country"`
	Population int     `json:"population"`
}

type Tag struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Colour string `json:"colour"`
}

type History struct {
	ID        int           `json:"id"`
	Time      time.Time     `json:"time"`
	Speed     float64       `json:"speed"`    // m/s
	Altitude  float64       `json:"altitude"` // m
	Latitude  float64       `json:"latitude"`
	Longitude float64       `json:"longitude"`
	TagID     sql.NullInt64 `json:"tag_id"`
}

func dbMigrate(ctx context.Context, db *sql.DB) error {
	var nextVer int
	if err := sqlb.QueryRow(ctx, db, sqlb.Into(&nextVer), "pragma user_version"); err != nil {
		return fmt.Errorf("get schema version: %w", err)
	}

	migrations := txtar.Parse(schema)
	for i := nextVer; i < len(migrations.Files); i++ {
		migration := migrations.Files[i]
		slog.InfoContext(ctx, "running migration", "name", migration.Name, "query", string(migration.Data))

		if err := sqlb.Exec(ctx, db, string(migration.Data)); err != nil {
			return fmt.Errorf("run migration %d: %w", i, err)
		}
		if err := sqlb.Exec(ctx, db, fmt.Sprintf("pragma user_version = %d", i+1)); err != nil {
			return fmt.Errorf("run migration %d: %w", i, err)
		}
	}
	return nil
}

func importData(ctx context.Context, db *sql.DB, src io.Reader) error {
	var tagIDs = map[string]int{}
	if err := sqlb.QueryRows(ctx, db, sqlb.ValueMap(tagIDs), "select name, id from tags"); err != nil {
		return err
	}

	r := csv.NewReader(src)
	r.Comma = '\t'

	records, err := r.ReadAll()
	if err != nil {
		return fmt.Errorf("read records: %w", err)
	}

	hist := make([]History, 0, 5000)
	for records := range slices.Chunk(records, cap(hist)) {
		hist = hist[:0]

		if w, g := 6, len(records[0]); w != g {
			return fmt.Errorf("expected %d columns, got %d", w, g)
		}

		for _, record := range records {
			var h History
			h.Time, _ = time.Parse(time.RFC3339Nano, record[0])
			h.Speed, _ = strconv.ParseFloat(record[1], 64)
			h.Altitude, _ = strconv.ParseFloat(record[2], 64)
			h.Latitude, _ = strconv.ParseFloat(record[3], 64)
			h.Longitude, _ = strconv.ParseFloat(record[4], 64)

			if tagID := tagIDs[record[5]]; tagID > 0 {
				h.TagID.Int64 = int64(tagID)
				h.TagID.Valid = true
			}

			hist = append(hist, h)
		}

		if err := sqlb.Exec(ctx, db, "insert into history ?", sqlb.InsertSQL(hist...)); err != nil {
			slog.ErrorContext(ctx, "insert db", "err", err)
			continue
		}
	}

	return nil
}

const cookieKey = "api-key"

func authMiddleware(next http.Handler, apiKey string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// exchange a valid basic auth request for a cookie that lasts 30 days
		if cookie, _ := r.Cookie(cookieKey); cookie != nil && subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(apiKey)) == 1 {
			next.ServeHTTP(w, r)
			return
		}
		if _, key, _ := r.BasicAuth(); subtle.ConstantTimeCompare([]byte(key), []byte(apiKey)) == 1 {
			http.SetCookie(w, &http.Cookie{Name: cookieKey, Value: apiKey, HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode, Expires: time.Now().Add(30 * 24 * time.Hour)})
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("WWW-Authenticate", `Basic realm="restricted", charset="UTF-8"`)
		http.Error(w, "unauthorised", http.StatusUnauthorized)
	})
}
func logMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		slog.InfoContext(r.Context(), "request", "url", r.URL)
		next.ServeHTTP(w, r)
	})
}

package main

import (
	"context"
	"database/sql"
	"embed"
	"encoding/csv"
	"encoding/json"
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
	_ "github.com/ncruces/go-sqlite3/embed"
	"go.senan.xyz/sqlb"
	"golang.org/x/tools/txtar"
)

func main() {
	var (
		listenAddr = flag.String("listen-addr", "", "listen addr for web interface")
		dbPath     = flag.String("db-path", "lochis.db", "db path for web interface")
	)
	flag.Parse()

	if *dbPath == "" {
		slog.Error("need a db path")
		return
	}
	if *listenAddr == "" {
		slog.Error("need a listen addr")
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
	if lev := slog.LevelDebug; slog.Default().Enabled(context.Background(), lev) {
		ctx = sqlb.WithLogFunc(ctx, func(ctx context.Context, typ string, query string, duration time.Duration) {
			slog.Log(ctx, lev, typ, "took", duration, "query", query)
		})
	}

	if err := dbMigrate(ctx, db); err != nil {
		slog.ErrorContext(ctx, "migrate db", "err", err)
		return
	}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /history", func(w http.ResponseWriter, r *http.Request) {
		params := r.URL.Query()

		var south, north, west, east float64
		fmt.Sscanf(params.Get("bbox"), "%f,%f,%f,%f", &west, &south, &east, &north)

		zoom, _ := strconv.ParseFloat(params.Get("zoom"), 64)

		q := sqlb.NewQuery(`
			select avg(latitude) as lat, avg(longitude) as lng, avg(altitude) as alt, count(*) as weight
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
		q.Append("group by round(latitude / ?), round(longitude / ?)", gridSize, gridSize)

		var f Feature
		f.Type = "Feature"
		f.Geometry.Type = "Point"

		enc := json.NewEncoder(w)
		for err := range sqlb.RowsScan(r.Context(), db, sqlb.Values(&f.Geometry.Coordinates[1], &f.Geometry.Coordinates[0], &f.Geometry.Coordinates[2], &f.Properties.Weight), "?", q) {
			if err != nil {
				slog.ErrorContext(ctx, "scan grouped history", "err", err)
				continue
			}
			enc.Encode(&f)
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

	server := &http.Server{
		Addr:        *listenAddr,
		Handler:     mux,
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
}

//go:generate go tool sqlbgen -to lochis.gen.go -generated ID History
type History struct {
	ID        int
	Time      time.Time
	Speed     float64
	Altitude  float64
	Latitude  float64
	Longitude float64
	TagID     sql.NullInt64
}

//go:embed schema.sql
var schema []byte

//go:embed index.html lochis.js
var indexFS embed.FS

func dbMigrate(ctx context.Context, db *sql.DB) error {
	var nextVer int
	if err := sqlb.ScanRow(ctx, db, sqlb.Values(&nextVer), "pragma user_version"); err != nil {
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
	if err := sqlb.ScanRows(ctx, db, sqlb.MapValue(tagIDs), "select name, id from tags"); err != nil {
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

// $ cd "/home/senan/scrap/go.h6hi"; and go run "main.go"

package main

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
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
		dbPath     = flag.String("db-path", "main.db", "db path for web interface")
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
		q := sqlb.NewQuery("select * from history where 1=1")
		if v := r.URL.Query().Get("start"); v != "" {
			q.Append(" and time >= ?", v)
		}
		if v := r.URL.Query().Get("end"); v != "" {
			q.Append(" and time <= ?", v)
		}
		q.Append(" order by time")

		rc := http.NewResponseController(w)
		enc := json.NewEncoder(w)

		query, args := q.SQL()
		for h, err := range sqlb.IterRows[History](r.Context(), db, query, args...) {
			if err != nil {
				slog.ErrorContext(ctx, "select history", "err", err)
				continue
			}
			if err := enc.Encode(Feature{
				Type: "Feature",
				Geometry: Geometry{
					Type:        "Point",
					Coordinates: [3]float64{h.Longitude, h.Latitude, h.Altitude},
				},
			}); err != nil {
				slog.ErrorContext(ctx, "encode feature", "err", err)
				return
			}
			rc.Flush()
		}
	})

	mux.HandleFunc("POST /import", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		if err := importData(r.Context(), db, r.Body); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	})

	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write(indexHTML)
	})

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
	Type     string   `json:"type"`
	Geometry Geometry `json:"geometry"`
}

type Geometry struct {
	Type        string     `json:"type"`
	Coordinates [3]float64 `json:"coordinates"`
}

//go:generate go tool sqlbgen -to main.gen.go -generated ID History
type History struct {
	ID        int
	Time      time.Time
	Speed     float64
	Altitude  float64
	Latitude  float64
	Longitude float64
}

//go:embed schema.sql
var schema []byte

//go:embed index.html
var indexHTML []byte

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
	r := csv.NewReader(src)
	r.Comma = '\t'

	records, err := r.ReadAll()
	if err != nil {
		return fmt.Errorf("read records: %w", err)
	}

	hist := make([]History, 0, 5000)
	for records := range slices.Chunk(records, cap(hist)) {
		hist = hist[:0]

		if w, g := 5, len(records[0]); w != g {
			return fmt.Errorf("expected %d columns, got %d", w, g)
		}

		for _, record := range records {
			var h History
			h.Time, _ = time.Parse(time.RFC3339Nano, record[0])
			h.Speed, _ = strconv.ParseFloat(record[1], 64)
			h.Altitude, _ = strconv.ParseFloat(record[2], 64)
			h.Latitude, _ = strconv.ParseFloat(record[3], 64)
			h.Longitude, _ = strconv.ParseFloat(record[4], 64)

			hist = append(hist, h)
		}

		if err := sqlb.Exec(ctx, db, "insert into history ?", sqlb.InsertSQL(hist...)); err != nil {
			slog.ErrorContext(ctx, "insert db", "err", err)
			continue
		}
	}

	return nil
}

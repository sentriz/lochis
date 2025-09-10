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
	"log/slog"
	"net/http"
	"net/url"
	"os"
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

	if lev := slog.LevelDebug; slog.Default().Enabled(context.Background(), lev) {
		sqlb.SetLog(func(ctx context.Context, typ string, duration time.Duration, query string) {
			slog.Log(ctx, lev, typ, "took", duration, "query", query)
		})
	}

	if err := dbMigrate(context.Background(), db); err != nil {
		slog.Error("migrate db", "err", err)
		return
	}

	switch flag.Arg(0) {
	case "import":
		if err := importData(context.Background(), db, flag.Arg(1)); err != nil {
			slog.Error("import data", "err", err)
			return
		}
		return
	}

	// TODO: stream output instead of buffering whole response
	http.HandleFunc("GET /history", func(w http.ResponseWriter, r *http.Request) {
		gj := GeoJSON{
			Type: "FeatureCollection",
		}
		for h, err := range sqlb.Iter[History](r.Context(), db, "select * from history") {
			if err != nil {
				slog.Error("select history", "err", err)
				continue
			}
			gj.Features = append(gj.Features, Feature{
				Type: "Feature",
				Geometry: Geometry{
					Type:        "Point",
					Coordinates: [3]float64{h.Longitude, h.Latitude, h.Altitude},
				},
			})
		}
		if err := json.NewEncoder(w).Encode(gj); err != nil {
			slog.Error("encode g", "err", err)
			return
		}
	})

	http.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "index.html")
	})

	if err := http.ListenAndServe(*listenAddr, nil); err != nil {
		slog.Error("start http", "err", err)
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

//go:generate go tool sqlbgen History
type History struct {
	ID        int
	Speed     float64
	Altitude  float64
	Latitude  float64
	Longitude float64
}

//go:embed schema.sql
var schema []byte

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

func importData(ctx context.Context, db *sql.DB, srcFile string) error {
	f, err := os.Open(srcFile)
	if err != nil {
		return fmt.Errorf("migrate db: %w", err)
	}
	defer f.Close()

	r := csv.NewReader(f)
	r.Comma = '\t'

	records, err := r.ReadAll()
	if err != nil {
		return fmt.Errorf("read records: %w", err)
	}

	hist := make([]History, 0, 5000)
	for records := range slices.Chunk(records, cap(hist)) {
		hist = hist[:0]

		if len(records[0]) != 5 {
			return fmt.Errorf("bad data")
		}

		for _, record := range records {
			var h History
			h.Speed, _ = strconv.ParseFloat(record[1], 64)
			h.Altitude, _ = strconv.ParseFloat(record[2], 64)
			h.Latitude, _ = strconv.ParseFloat(record[3], 64)
			h.Longitude, _ = strconv.ParseFloat(record[4], 64)

			hist = append(hist, h)
		}

		if err := sqlb.Exec(ctx, db, "insert into history ?", sqlb.InsertSQL(hist...)); err != nil {
			slog.Error("insert db", "err", err)
			continue
		}
	}

	return nil
}

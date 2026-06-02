package web

import "embed"

//go:generate npm run build

//go:embed index.html favicon.svg dist
var FS embed.FS

// Package web holds the editor page's built assets, embedded into the binary.
package web

import "embed"

// Assets holds editor.html, editor.js and editor.css at its root. The server
// serves them as the page. editor.js and editor.css are built by
// `npm run build:editor` and checked in, so `go install` needs no Node.
//
//go:embed editor.html editor.js editor.css
var Assets embed.FS

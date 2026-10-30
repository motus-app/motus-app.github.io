# motus-app.github.io

Website of **Motus**, a free program for one-dimensional seismic site response (equivalent-linear and nonlinear effective-stress solvers, with an MCP agent interface). Live at https://motus-app.github.io.

Static HTML/CSS/JS, no build step. Preview locally with `python3 -m http.server` in this folder.

Downloads live in `downloads/` and are served by GitHub Pages with the site. To publish a new version, build the macOS (x86_64 + aarch64) and Windows (x86_64-pc-windows-gnu) targets in the Motus source tree, run `bash web/package.sh` (it replaces the zips and rewrites `downloads/config.js` and `SHA256SUMS.txt`), then commit and push this folder.

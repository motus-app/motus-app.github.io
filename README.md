# motus-app.github.io

Website of **Motus**, a free program for one-dimensional seismic site response (equivalent-linear and nonlinear effective-stress solvers, with an MCP agent interface). Live at https://motus-app.github.io.

Static HTML/CSS/JS, no build step. Preview locally with `python3 -m http.server` in this folder.

Downloads are GitHub Release assets. To publish a new version from the Motus source tree, build the macOS (x86_64 + aarch64) and Windows (x86_64-pc-windows-gnu) targets, then run

```sh
BASE_URL=https://github.com/motus-app/motus-app.github.io/releases/download/vX.Y.Z bash web/package.sh
gh release create vX.Y.Z web/downloads/*.zip web/downloads/SHA256SUMS.txt -R motus-app/motus-app.github.io
```

and commit the rewritten `downloads/config.js`.

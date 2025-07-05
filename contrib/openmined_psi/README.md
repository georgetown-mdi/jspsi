The Docker file builds [OpenMined PSI](https://github.com/OpenMined/PSI) for JavaScript. This obviously requires Docker. To build it:
1. Execute `./build_psi.sh`
2. Extract the `tgz` gzipped tarball that gets created
3. Copy `psi_wasm_web.js` and `psi_wasm_web.js.map` to `./public/javascripts/psi`.

TODO:
1. Unpin version number.

export function loadPSILibrary() {
  return new Promise((resolve, reject) => {
    // @ts-ignore - PSI is imported in client-side route code
    //import('/js/psi_wasm_web.js').then(() => {
      // @ts-ignore
      return PSI().then((psi) => { resolve(psi) });
    //})
  });
}
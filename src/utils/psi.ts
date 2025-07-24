export function loadPSILibrary() {
  return new Promise((resolve, _reject) => {
    // @ts-ignore - PSI is imported in client-side route code
    return PSI().then((psi) => { resolve(psi) });
  });
}
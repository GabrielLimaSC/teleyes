/*
 * S19-05: everything under src/demo-static is reachable only from code guarded by
 * `import.meta.env.VITE_DEMO_STATIC === '1'` (set by `vite build --mode demo-static`).
 * Vite replaces that expression with a literal, so the normal build drops these
 * modules; `scripts/check-bundles.mjs` fails the build if one ever leaks in.
 */
export const DEMO_REPO_URL = 'https://github.com/GabrielLimaSC/teleyes'
export const DEMO_INSTALL_URL = 'https://github.com/GabrielLimaSC/teleyes#quick-start-self-hosting'

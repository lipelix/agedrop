import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

/** The same policy as public/_headers, as a meta tag, so it also holds in `vite preview` and the tests. */
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src https://api.github.com; manifest-src 'self'; base-uri 'none'; form-action 'none'";

function contentSecurityPolicy(): Plugin {
  return {
    name: "agedrop-csp",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: CSP },
        injectTo: "head-prepend",
      },
    ],
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  plugins: [contentSecurityPolicy()],
  build: {
    outDir: fileURLToPath(new URL("../dist-web", import.meta.url)),
    emptyOutDir: true,
    target: ["es2022", "safari16"],
    sourcemap: true,
  },
  preview: { port: 4173, strictPort: true },
});

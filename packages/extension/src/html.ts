/**
 * Turns the Vite-built index.html (built with `base: "./"`) into webview HTML:
 * - every relative asset URL is rewritten to a webview resource URI (inside the extension's dist folder);
 * - every <script> gets the per-load nonce;
 * - a strict Content-Security-Policy is injected: nothing remote, no network.
 *
 * Pure (no `vscode` import) so it can be unit-tested.
 */
export function buildWebviewHtml(
  indexHtml: string,
  opts: { nonce: string; cspSource: string; resourceUri: (relativePath: string) => string },
): string {
  const { nonce, cspSource } = opts;
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} data: blob:`, // exported PNG/SVG previews are data:/blob:
    `style-src ${cspSource} 'unsafe-inline'`, // React style={} attributes; no remote stylesheets
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}' ${cspSource}`, // our bundle and its lazily imported chunks only
    "worker-src blob:", // the inlined force-layout worker
    `connect-src ${cspSource} data: blob:`, // no http(s): the webview cannot reach the network
  ].join("; ");
  if (!/<head>/i.test(indexHtml)) throw new Error("webview index.html has no <head>");
  return indexHtml
    .replace(/(src|href)="\.\/([^"]+)"/g, (_m, attr: string, path: string) => `${attr}="${opts.resourceUri(path)}"`)
    .replace(/<script\b/gi, `<script nonce="${nonce}"`)
    .replace(/<head>/i, `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
}

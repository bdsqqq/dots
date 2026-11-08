import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export interface RouterConfig { port: number; databasePort: number; collectorPort: number }
/** Share the existing authenticated TLS ingress without granting new network
 * ports. Database authentication and collector authentication stay independent.
 */
export async function startArchiveRouter(config: RouterConfig) {
  if ([config.port, config.databasePort, config.collectorPort].some(p => !Number.isInteger(p) || p < 1 || p > 65535)
    || new Set([config.port, config.databasePort, config.collectorPort]).size !== 3) throw new Error('invalid archive router ports');
  const server = http.createServer((req, res) => {
    const raw = req.url ?? '/';
    if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\r\n#]/.test(raw)) { res.writeHead(400); res.end(); return; }
    const archive = raw === '/archive' || raw.startsWith('/archive/');
    const path = archive ? raw.slice('/archive'.length) || '/' : raw;
    const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
      ...(req.headers.connection ?? '').toLowerCase().split(',').map(s => s.trim())]);
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !hop.has(key)));
    headers.host = `127.0.0.1:${archive ? config.collectorPort : config.databasePort}`;
    const upstream = http.request({ host: '127.0.0.1', port: archive ? config.collectorPort : config.databasePort, path, method: req.method, headers }, response => {
      const excluded = new Set([...hop, ...(response.headers.connection ?? '').toLowerCase().split(',').map(s => s.trim())]);
      res.writeHead(response.statusCode ?? 502, Object.fromEntries(Object.entries(response.headers).filter(([key]) => !excluded.has(key))));
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.setTimeout(60_000, () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => upstream.destroy());
    req.on('error', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(config.port, '127.0.0.1', ok); });
  return { close: () => new Promise<void>(ok => { server.close(() => ok()); server.closeAllConnections(); }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = await startArchiveRouter(JSON.parse(await readFile(process.argv[2]!, 'utf8')) as RouterConfig);
    const stop = () => void server.close();
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch { console.error('archive ingress router unavailable'); process.exitCode = 1; }
}

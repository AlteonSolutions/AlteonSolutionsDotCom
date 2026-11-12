// Local stand-in for the Azure Function, for end-to-end testing without the
// Functions host. Same handler, plus permissive CORS for the local page.
//
//   FLOW_URL=http://localhost:7072/flow FLOW_SHARED_KEY=dev TURNSTILE_ENABLED=false npm run dev

import { createServer } from 'node:http';
import { clientIp, handleContact, loadConfig } from '../src/handler';
import { RateLimiter } from '../src/rateLimit';

const port = Number(process.env.PORT || 7071);
const config = loadConfig(process.env);
const limiter = new RateLimiter(config.rateLimitPerHour);

createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  if (req.method !== 'POST' || req.url !== '/api/contact') return res.writeHead(404).end();
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const ip = clientIp(req.headers['x-forwarded-for'] as string | undefined, req.socket.remoteAddress ?? '');
  const result = await handleContact(Buffer.concat(chunks).toString('utf8'), ip, config, {
    fetch,
    limiter,
    log: (entry) => console.log(JSON.stringify(entry)),
  });
  res.writeHead(result.status, { 'Content-Type': 'application/json' }).end(result.body);
}).listen(port, () => console.log('contact proxy listening on http://localhost:' + port + '/api/contact'));

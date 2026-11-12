import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { clientIp, handleContact, loadConfig } from '../handler';
import { RateLimiter } from '../rateLimit';

const config = loadConfig(process.env);
const limiter = new RateLimiter(config.rateLimitPerHour);

export async function contact(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const ip = clientIp(request.headers.get('x-forwarded-for'));
  const result = await handleContact(await request.text(), ip, config, {
    fetch,
    limiter,
    log: (entry) => (entry.event === 'forwarded' ? context.log : context.warn)(JSON.stringify(entry)),
  });
  return { status: result.status, body: result.body, headers: { 'Content-Type': 'application/json' } };
}

// CORS (allowing https://alteonsolutions.com) is configured on the Function
// App, not here; see README.md.
app.http('contact', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'contact',
  handler: contact,
});

# Contact form proxy

A small Azure Function that sits between the "Request a call" form on
alteonsolutions.com and the Power Automate flow that emails you.

Today the page POSTs straight to the flow's public URL, so bots skip the page
and POST to the flow directly. With this in place:

```
browser ──► Azure Function (/api/contact) ──► Power Automate flow ──► email
            filters junk, checks Turnstile    only runs when the
            adds x-alteon-key header          x-alteon-key header matches
```

## What it rejects

Every rejection is answered with `200 {"ok":true}`, the same response a real
submission gets, so bots learn nothing. Each one is logged with its reason.

| Reason (as logged)                 | Rule |
|------------------------------------|------|
| `rate-limited`                     | More than `RATE_LIMIT_PER_HOUR` requests from one IP in an hour |
| `too-large`, `bad-json`            | Body over 32 KB, or not JSON |
| `honeypot`                         | Hidden `website` field filled in |
| `too-fast`                         | `elapsedMs` missing or under 3000 (this also catches every direct POST built for the old flow URL) |
| `name-blank`, `name-too-long`      | Name empty after trimming, or over 100 characters |
| `email-invalid`                    | Email missing or not shaped like `x@y.z` |
| `email-example-domain`             | Domain is example.com / .net / .org (or a subdomain of them) |
| `email-test-local`                 | Local part starts with `test` or `victim` |
| `email-gmail-dots`                 | Gmail / Googlemail local part with 4 or more dots |
| `company-llc-and-gibberish-name`   | Company like `Aaobdysmav LLC` **and** a gibberish name |
| `name-gibberish`, `message-gibberish` | A single 12+ letter word with 3+ lowercase-to-uppercase switches (e.g. `FPPJCvVEeBHLvgWjqZ`). Clean CamelCase such as `SharePointPowerAutomate` is allowed. |
| `turnstile`                        | Turnstile token missing or rejected by Cloudflare |

Real failures are not hidden: if Cloudflare or the flow can't be reached, or
the flow returns an error, the function returns 502 and the page shows its
usual "Something went wrong…" message so the person can retry or email you.

The rules live in [`src/validate.ts`](src/validate.ts) and are covered by
[`test/validate.test.ts`](test/validate.test.ts), which includes every junk
submission received so far and the cases that must always pass.

## App settings

Set these on the Function App (Portal: Function App → Settings → Environment
variables). **Never commit the values.**

| Name                   | Secret? | Value |
|------------------------|---------|-------|
| `FLOW_URL`             | yes     | The flow's HTTP trigger URL, including `sig=` |
| `FLOW_SHARED_KEY`      | yes     | A long random string, also pasted into the flow's header check. Generate one with `openssl rand -hex 32` |
| `TURNSTILE_SECRET_KEY` | yes     | The Turnstile widget's **secret** key |
| `TURNSTILE_ENABLED`    | no      | `true` (default). Set to `false` to switch Turnstile off; every other check still runs |
| `RATE_LIMIT_PER_HOUR`  | no      | Default `5`. `0` turns the limit off |

If `FLOW_URL` or `FLOW_SHARED_KEY` is missing (or `TURNSTILE_SECRET_KEY` while
Turnstile is on), the function returns 500 instead of forwarding anything.

To switch Turnstile off completely, set `TURNSTILE_ENABLED=false` here **and**
set `turnstileSiteKey = ''` in the page (see "Page settings" below).

## Rate limit caveat

The per-IP limit is kept in memory on each function instance. It stops a
single bot hammering the form, but it resets when Azure recycles the instance,
and two instances keep separate counts. That is fine for this volume; a
durable limit would need Table Storage and isn't included.

## Deploy

You need the Azure CLI (`az`) and Azure Functions Core Tools v4 (`func`).

### 1. Turnstile widget (Cloudflare dashboard)

1. Cloudflare dashboard → **Turnstile** → **Add widget**.
2. Hostnames: `alteonsolutions.com` and `www.alteonsolutions.com`.
3. Widget mode: **Managed**. The page renders it with
   `appearance: 'interaction-only'`, so most visitors never see it; it only
   appears if Cloudflare wants a click.
4. Copy the **site key** (public, goes in the page) and the **secret key**
   (goes in `TURNSTILE_SECRET_KEY` only).

### 2. Function App

Replace the names in angle brackets. Function App names must be globally unique.

```bash
az login
az group create --name rg-alteon-contact --location eastus
az storage account create --name <storageacct> --resource-group rg-alteon-contact \
  --location eastus --sku Standard_LRS --allow-blob-public-access false
az functionapp create --name <function-app> --resource-group rg-alteon-contact \
  --storage-account <storageacct> --flexconsumption-location eastus \
  --runtime node --runtime-version 22
```

Allow the website to call it (CORS is handled by the platform, not the code):

```bash
az functionapp cors add --name <function-app> --resource-group rg-alteon-contact \
  --allowed-origins https://alteonsolutions.com https://www.alteonsolutions.com
```

Add the app settings from the table above in the Portal (Environment
variables → Add). Using the Portal keeps the flow URL and secrets out of your
shell history.

### 3. Publish

```bash
cd server
npm ci
npm test            # builds and runs the unit tests
func azure functionapp publish <function-app>
```

The endpoint is `https://<default-domain>/api/contact`. Copy the default domain
from the Function App's Overview page (newer apps get a hostname with a random
suffix, so don't guess it).

### 4. Smoke test

A junk POST should get `{"ok":true}` and never reach the flow:

```bash
curl -s -X POST https://<default-domain>/api/contact \
  -H 'Content-Type: application/json' \
  -d '{"name":"","email":"victim-x@example.com","company":"","message":""}'
```

Check that it was logged as rejected (Function App → Log stream, or in
Application Insights):

```kusto
traces
| where message has '"event":"rejected"'
| project timestamp, message
| order by timestamp desc
```

To check for false positives later, look for `"event":"rejected"` entries
whose reason isn't `too-fast`, `honeypot` or `turnstile`. Logs hold the reason,
the IP and the email domain only, never the name or message.

## Page settings

The page (`index.html`, inside the bundled template) has two settings near the
top of `class Component`:

```js
contactEndpoint = 'https://<default-domain>/api/contact';
turnstileSiteKey = '<public site key>';
```

Edit them with the template tool from the repo root, never by hand in
`index.html`:

```bash
node tools/bundle-template.mjs decode index.html /tmp/page.html
# edit /tmp/page.html
node tools/bundle-template.mjs encode /tmp/page.html index.html
node tools/bundle-template.mjs check index.html
```

## Local development

```bash
cd server
npm ci
npm test
FLOW_URL=http://localhost:7072/flow FLOW_SHARED_KEY=dev TURNSTILE_ENABLED=false npm run dev
```

`npm run dev` runs the same handler on plain Node at
`http://localhost:7071/api/contact`, so you don't need the Functions host.
`func start` also works if you copy `local.settings.example.json` to
`local.settings.json` (git-ignored) and fill it in.

The full browser test runs the real page against this code with a mocked
flow and Turnstile, all on this machine:

```bash
(cd server && npm run build)
NODE_PATH=$(npm root -g) node tools/e2e-contact.mjs
```

## Alternative: Cloudflare Worker

The same `src/validate.ts` and `src/handler.ts` would run in a Cloudflare
Worker with a few-line wrapper, using Worker secrets for the settings. A Worker
has a built-in rate-limiting binding, so the per-IP limit would be reliable
rather than per-instance. It isn't set up here because the site already lives
on Azure.

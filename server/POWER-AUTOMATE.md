# Power Automate changes (manual)

These steps lock the "Discovery Call Request" flow so that only the proxy can
trigger it. Do them in the order given in **Rollout order** at the bottom.
Nothing here is automated.

You'll need the same `FLOW_SHARED_KEY` value you put in the Function App's
settings.

---

## 1. Header check right after the trigger

This makes the flow ignore any call that doesn't carry the proxy's secret
header, including bots that already know the old URL.

1. Open the flow in the designer (make.powerautomate.com → My flows → the flow → Edit).
2. Under the trigger **When an HTTP request is received**, select **+** →
   **Add an action** → **Control** → **Condition**. Make it the very first step,
   above everything else.
3. Set the condition:
   - Left value: select the field, choose **Expression** (fx), paste
     ```
     triggerOutputs()?['headers']?['x-alteon-key']
     ```
     and select **Add**.
   - Operator: **is equal to**.
   - Right value: paste the `FLOW_SHARED_KEY` value.
4. In the **False** branch, add:
   1. **Request** → **Response**: Status Code `200`, Body `{"ok":true}`.
   2. **Control** → **Terminate**: Status **Succeeded**.
5. Leave the **True** branch empty. Your existing steps stay below the
   Condition. They only run when the header matched, because the False branch
   has already terminated the run.
6. **Response actions:** once the flow has a Response action anywhere, the
   caller waits for one. If the flow didn't already end with a Response, add a
   **Response** (Status Code `200`) as the last step of the normal path, after
   the email is sent. Without it, real submissions can come back as errors
   even though the email went out.
7. Save.

Notes:
- The secret is stored in plain text in the flow definition, visible to flow
  owners only. That's acceptable here. If you'd rather not, store it in a
  solution environment variable and reference that instead.
- Header names are case-insensitive over HTTP, but use exactly
  `x-alteon-key` in the expression as written.

## 2. Request body schema

1. Select the trigger **When an HTTP request is received**.
2. In **Request Body JSON Schema**, paste:
   ```json
   {
     "type": "object",
     "properties": {
       "name":    { "type": "string", "minLength": 1 },
       "email":   { "type": "string", "minLength": 3 },
       "company": { "type": "string" },
       "message": { "type": "string" }
     },
     "required": ["name", "email"]
   }
   ```
3. Optional, recommended: open the trigger's **Settings** and turn on **Schema
   Validation**. Without it, the schema only drives the dynamic content picker
   and isn't enforced. With it on, a body that doesn't match is refused with a
   400 before any step runs. The proxy already guarantees a non-blank name, so
   a 400 here means something unexpected reached the flow.
4. Keep **Who can trigger the flow** set to **Anyone**. The proxy
   authenticates with the URL's `sig` plus the header, not with an Entra ID
   token.
5. Save, then send a real test submission through the website (after the page
   update is live) and confirm the email arrives.

## 3. Rotate the trigger URL

The current `sig=` value is public: it was in the page and is still in this
repo's git history (removing it from the file doesn't remove it from history).
Rotating it makes the old URL stop working.

> ⚠️ **Check this before relying on it.** Microsoft's documented method is
> below, but that article is dated September 2024. That's before trigger URLs
> moved to `*.environment.api.powerplatform.com`, which is the kind your flow
> uses. I couldn't confirm it still applies to the new URLs. Follow it, then
> **verify** using step 3.4. If it doesn't work, use the fallback.

### 3.1 Note the current `sig`

In the designer, open the trigger and copy the **HTTP URL**. Note the value
after `sig=`.

### 3.2 Regenerate the key (Microsoft's documented method)

Source: Microsoft Learn, "Regenerate the SAS key used in HTTP trigger flows"
(`learn.microsoft.com/power-automate/regenerate-sas-key`).

1. Open the flow's **Details** page (not the designer).
2. Open the browser's developer tools (F12) → **Network** tab. Clear the log,
   make sure recording is on, and refresh the page.
3. Filter on `api.flow` and select the request that starts with
   `runs?api-version=`.
4. From **Headers**, copy the **Request URL** into a text editor and replace
   the word `runs` with `regenerateAccessKey`.
5. From the same request's **Headers**, copy the **Authorization** header
   value (just that header).
6. In the **Console** tab, run:
   ```js
   fetch('<regenerateAccessKey URL from step 4>', {
     method: 'POST',
     headers: {
       'Content-type': 'application/json; charset=UTF-8',
       'Authorization': '<Authorization value from step 5>'
     }
   }).then(r => r.json()).then(console.log)
   ```
   Microsoft notes the promise can show as rejected even when the key was
   regenerated, so always check 3.4.

### 3.3 Fallback if 3.2 doesn't change the `sig`

Make a copy of the flow (**Save As**). The copy gets a new workflow ID and a
new `sig`. Apply sections 1 and 2 to the copy if they didn't carry over, turn
the copy on, then turn off (and later delete) the original. The old URL
belongs to the original flow, so it stops working once that flow is off or
deleted.

### 3.4 Verify

1. Reopen the trigger in the designer: the `sig=` value must be different
   from the one you noted in 3.1. Copy the full new URL.
2. Put the new URL in the Function App setting `FLOW_URL` and save. The app
   restarts in a few seconds.
3. Send a real submission through the website and confirm the email arrives.
4. Check that the old URL is dead: POSTing to it should now fail (401/403/404)
   instead of starting a run. Check the flow's run history to confirm no new
   run appeared.

Between rotating the URL and updating `FLOW_URL`, real submissions fail with
the page's normal error message. Do the rotation at a quiet time and update
the setting straight away.

---

## Rollout order

This order never leaves the form broken:

1. **Deploy the proxy** (see `README.md`) with `FLOW_URL` set to the
   **current** flow URL and `FLOW_SHARED_KEY` set. The flow ignores the extra
   header for now, so nothing changes yet.
2. **Smoke-test the proxy** with the junk `curl` in `README.md` and confirm
   it's logged as rejected.
3. **Merge the website PR** (with the real `contactEndpoint` and
   `turnstileSiteKey` filled in). GitHub Pages serves the new page within a
   few minutes. Send yourself a real test submission and confirm the email
   arrives.
4. **Wait about 15 minutes** so cached copies of the old page (which post
   directly to the flow) expire, then **add the header check and schema**
   (sections 1 and 2). From here on, direct POSTs to the flow are dropped.
   Send another real test.
5. **Rotate the trigger URL** (section 3) and immediately update `FLOW_URL`.
   Send a final real test.

If real submissions stop arriving after step 4, delete the Condition and save.
The flow goes back to accepting any caller, and the proxy keeps working either
way.

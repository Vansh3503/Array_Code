# WhatsApp Cloud API setup

TravelPulse sends messages only through Meta's **official WhatsApp Cloud API**. It does not handle incoming messages and has no chatbot. Inbound webhook messages are ignored.

## Key facts to know first

| Topic | What it means for you |
|-------|----------------------|
| **Templates are mandatory** | Your parents never message the business number, so every update is *business-initiated*. Business-initiated messages need a **pre-approved message template**. Free-form text only works within 24 hours of the recipient messaging the number. |
| **Opt-in** | Meta requires recipients' consent. Ask Mom and Dad and keep a note that they agreed. With the test number they also confirm a verification code on WhatsApp. |
| **Cost: test number** | Messages from Meta's test number are **free**. No payment method is needed. It is limited to **5 pre-verified recipient numbers**, which is enough for two. |
| **Cost: own number** | Meta charges per delivered template message. Utility templates to Indian numbers cost about ₹0.11–0.15 each (unverified third-party figures; check Meta's rate card). Example: ~30 messages a day for 3 weeks ≈ **₹100 (≈ US$1.20)**. A payment method is required in WhatsApp Manager. Utility templates sent while a 24-hour customer-service window is open are free. |
| **Category risk** | Submit the template as **Utility**. If Meta reclassifies it as **Marketing**, each message costs roughly ₹0.8–1.1, and India's per-user marketing caps may silently block delivery (error 131049). Keep the wording transactional, as in the template below. |
| **Approval time** | Template review usually takes minutes, but can take up to 24 hours. **Submit it today.** |
| **API version** | `v25.0` by default. Graph API v26.0 was released in July 2026. Change `WHATSAPP_API_VERSION` in `wrangler.toml` if needed. |

## Option A: test number (fastest, free, recommended for this trip)

1. Go to <https://developers.facebook.com/apps> → **Create App**. Choose the *Connect with customers through WhatsApp* use case (or app type *Business*). Create or choose a Business portfolio when asked.
2. In the app, open **WhatsApp → API Setup**. Meta assigns a **test phone number**. Copy:
   - **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - **WhatsApp Business Account ID** (for reference)
3. In the **To** field, choose **Manage phone number list → Add** your Mom's and Dad's numbers. Each receives a code on WhatsApp that they read back to you. Sending to a number that isn't on this list fails with error 131030.
4. Click **Send message** to send them the built-in `hello_world` template. This proves delivery works end to end.
5. Create the template (see below) under this WhatsApp Business Account.
6. Create a **permanent token** (see below). The token on the API Setup page expires after 24 hours.

Limitations of the test number:

- The sender appears as a test number, not your name.
- It only reaches the 5 verified numbers.
- Meta intends it for testing, so availability isn't guaranteed. Keep the manual fallback shortcut ready.

## Option B: own business number (production)

Use this if you want a proper display name or more recipients. You need:

- A phone number that is **not** registered on WhatsApp, or has been deleted from WhatsApp. For example, a spare SIM.
- **WhatsApp Manager → Phone numbers → Add**: verify it by SMS or voice, and set a display name (Meta reviews it).
- **WhatsApp Manager → Payment settings**: add a card.
- Unverified businesses can message a limited number of unique recipients a day (hundreds), which is plenty here. Business verification is not required.

Then update `WHATSAPP_PHONE_NUMBER_ID` to the new number's ID.

## The message template

Go to **WhatsApp Manager → Message templates → Create template** and use these settings:

- **Category**: Utility
- **Name**: `travel_update`
- **Language**: English. The language code must match `WHATSAPP_TEMPLATE_LANG`: `en` for "English", `en_US` for "English (US)".
- **Header**: none. **Buttons**: none.
- **Body** (copy exactly):

```
✈️ Travel Update

{{1}}

📍 Location: {{2}}
🕒 Local time: {{3}}
🇮🇳 India time: {{4}}
🔋 Battery: {{5}}
🌡️ Temperature: {{6}}
🛫 Next destination: {{7}}

Google Maps: {{8}}
Live tracking: {{9}}

Automatic update from TravelPulse.
```

- **Footer** (optional): `Sent automatically from Vansh's phone`

**Sample values**, which Meta asks for during review:

1. `Vansh has arrived in New York, USA 🇺🇸`
2. `JFK International Airport`
3. `3:30 PM`
4. `2:00 AM (next day)`
5. `78%`
6. `8°C`
7. `Las Vegas (LAS)`
8. `https://maps.google.com/?q=40.64130,-73.77810`
9. `https://travelpulse.example.workers.dev/v/abc123`

The body ends with fixed text because Meta rejects templates that end with a variable.

## Permanent access token (System User)

1. Open **Business Settings** at <https://business.facebook.com/settings> → **Users → System users → Add**. Give it a name such as `travelpulse` and the **Admin** role.
2. **Assign assets**:
   - your **App**, with *Full control*
   - your **WhatsApp account**, with *Full control*
3. **Generate new token**:
   - Select the app.
   - Expiration: **Never**.
   - Permissions: `whatsapp_business_messaging` and `whatsapp_business_management`.
4. Store it:
   ```bash
   npx wrangler secret put WHATSAPP_TOKEN
   npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
   ```
5. In `wrangler.toml`, set `WHATSAPP_MODE = "template"`, then run `npx wrangler deploy`.

## Verify delivery

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" $URL/api/admin/test-message
curl -H "Authorization: Bearer $ADMIN_TOKEN" $URL/api/admin/health   # outbox shows sent / failed + error codes
```

Common errors:

| Code | Meaning | Fix |
|------|---------|-----|
| `190` | Token expired or invalid | Use a System User token with expiry *Never*. |
| `131030` | Recipient isn't on the test-number allow list | Add and verify the number (Option A, step 3). |
| `132001` | Template name or language doesn't exist (or isn't approved yet) | Check the template name, its approval status, and `WHATSAPP_TEMPLATE_LANG`. |
| `132000` | Wrong number of parameters | The template body must have exactly 9 variables. |
| `131047` | 24-hour window closed (text mode) | Handled automatically: the server falls back to the template. |
| `131049` | Meta withheld delivery for engagement reasons (marketing category) | Make sure the template category is Utility. |
| `131026` | Message undeliverable | The recipient isn't on WhatsApp, or is on an old app version. |

Transient failures (network errors, 5xx, rate limits) are retried by the cron every 10 minutes, for up to 2 hours.

## Optional: delivery receipts webhook

The API's `200 OK` only means Meta *accepted* the message. To record **delivered** and **read** receipts and late failures:

1. Store the two secrets:
   - `npx wrangler secret put WHATSAPP_APP_SECRET`. The value is in **App settings → Basic → App secret**.
   - `npx wrangler secret put WHATSAPP_VERIFY_TOKEN`. Use any random string.
2. In the app, open **WhatsApp → Configuration → Webhook → Edit** and enter:
   - Callback URL: `WORKER_URL/webhooks/whatsapp`
   - Verify token: the same string as `WHATSAPP_VERIFY_TOKEN`
3. Subscribe to the **messages** field. Status updates arrive through it. Incoming chat messages are ignored.
4. Signatures are checked with `X-Hub-Signature-256`.

The outbox status then moves through `sent → delivered → read`, or `failed` with Meta's error code.

## If WhatsApp isn't ready by departure

- Leave `WHATSAPP_MODE = "dry_run"`. Location collection and the dashboard still work fully.
- Send your parents the dashboard link once, by hand.
- Use the `TravelPulse Fallback` shortcut (docs/SHORTCUTS.md §4) to send updates from your own WhatsApp. This requires a tap each time.

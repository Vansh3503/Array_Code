# iPhone setup (Apple Shortcuts)

Signed `.shortcut` files can't be generated outside an Apple device, so you build these by hand. It takes about 15 minutes. You need iOS 17 or later, which lets almost every automation trigger use **Run Immediately**.

You need two values from `scripts/setup.sh`:

- `WORKER_URL`, e.g. `https://travelpulse.yourname.workers.dev`
- `DEVICE_TOKEN`

## 0. iPhone settings (do these first)

1. **Settings → Privacy & Security → Location Services**: turn it **On**.
   - **Shortcuts**: set to *While Using the App* and turn **Precise Location** on.
   - **System Services → Significant Locations**: turn it on. Location automations work better with it.
2. **Settings → Shortcuts → Advanced**: turn on *Allow Running Scripts*.
3. **Mobile data abroad.** Turn on *Data Roaming*, or install a travel eSIM. Without data, updates are only sent over Wi‑Fi.
4. **Background App Refresh** for Shortcuts: turn it on.

## 1. Main shortcut: `TravelPulse`

Open **Shortcuts → + (new shortcut)** and name it `TravelPulse`.

At the top, tap **ⓘ / Receive input**:

- **Receive**: *Text* only
- **If there's no input**: *Continue*

Add these actions in this order:

| # | Action | Setting |
|---|--------|---------|
| 1 | **Text** | Insert the magic variable **Shortcut Input**. This becomes the trigger name. If it's empty, the server treats the run as a manual check-in. |
| 2 | **Get Current Location** | — |
| 3 | **Get Battery Level** | — |
| 4 | **Current Date** | — |
| 5 | **Format Date** | Date: *Current Date*. Date Format: **ISO 8601**. Turn **Include ISO 8601 Time** on. This produces a value like `2026-11-29T15:30:00+05:30`; the offset is required. |
| 6 | **Random Number** | Minimum `100000`, maximum `999999` |
| 7 | **Get Contents of URL** | See the table below |
| 8 | **Get Dictionary Value** | Get **Value** for key `summary` in *Contents of URL* |
| 9 | **Show Notification** | Body: *Dictionary Value* |

Configure **Get Contents of URL** (step 7) like this:

- URL: `WORKER_URL/api/ping`
- Tap **Show More**:
  - **Method**: `POST`
  - **Headers**: key `Authorization`, value `Bearer DEVICE_TOKEN`
  - **Request Body**: `JSON`, with these fields:

| Key | Type | Value |
|-----|------|-------|
| `lat` | Number | *Current Location*. Tap the variable and choose **Latitude**. |
| `lon` | Number | *Current Location* → **Longitude** |
| `city` | Text | *Current Location* → **City** |
| `country` | Text | *Current Location* → **Country** |
| `battery` | Number | *Battery Level* |
| `ts` | Text | *Formatted Date* |
| `nonce` | Text | *Formatted Date*, then a `-`, then *Random Number* |
| `trigger` | Text | *Text* (the output of step 1) |

Run it once by hand and allow the location and network prompts. You should see a notification like `📍 Logged. manual_checkin → WhatsApp 2/2`.

> **About location accuracy:** Shortcuts' built-in actions don't expose GPS accuracy, so `accuracy` is left out. The server accepts it if you add it later. Coordinates are checked for plausibility on the server: impossible jumps are ignored.

**One‑tap manual check-in.** This is the fallback when automations don't fire.

- **Home Screen**: on the shortcut, choose **… → Share → Add to Home Screen**.
- **Lock Screen / Control Center widget**: add the Shortcuts widget and pick `TravelPulse`.
- **Action button** (iPhone 15 Pro and later): Settings → Action Button → Shortcut → `TravelPulse`.
- **Siri**: say "TravelPulse".

## 2. Helper shortcuts

**`TravelPulse SOS`** (emergency alert)

1. **Choose from Menu** with the prompt "Send EMERGENCY alert to Mom & Dad?" and two options, *Send* and *Cancel*.
2. Under *Send*:
   - **Text** `emergency`
   - **Run Shortcut** `TravelPulse`. Tap **Input** and choose *Text*.
3. Under *Cancel*: **Stop This Shortcut**.

Add it to the Home Screen as well. Emergency alerts are sent even when tracking is paused, and they bypass the hourly message limit.

**`TravelPulse Pause` / `TravelPulse Resume`** (turn tracking off or on)

- **Get Contents of URL**:
  - URL: `WORKER_URL/api/tracking`
  - Method: `POST`
  - Header: `Authorization: Bearer DEVICE_TOKEN`
  - JSON body: `enabled` (Boolean) = *false*. Use *true* for the Resume shortcut.
- **Get Dictionary Value** `summary` → **Show Notification**.

**`TravelPulse Note`** (optional: check in with a message)

1. Duplicate `TravelPulse`.
2. Add **Ask for Input** (Text, "Note for Mom & Dad") at the top.
3. Add a JSON field `note` (Text) = *Provided Input*.

## 3. Automations

Open **Shortcuts → Automation → + → Create Personal Automation**. For every automation:

1. Pick the trigger from the table below.
2. Choose **Run Immediately**, and turn **Notify When Run** off. The shortcut shows its own notification.
3. **New Blank Automation**, then add:
   - **Text** containing the trigger value from the table
   - **Run Shortcut** `TravelPulse`, with **Input** set to *Text*

| Event | Trigger setup | Text value |
|-------|---------------|-----------|
| Arriving at airports | **Arrive** → Location: search the airport. Radius ≈ 1–2 km. Time: *Any Time*. Create one each for AMD, DOH, JFK, LAS, SFO, LHR and DEL. | `arrive_airport` |
| Leaving airports | **Leave** → same airport locations. Most useful for LAS, SFO and AMD (home), where you leave by road. | `leave_airport` |
| Landing (airplane mode off) | **Airplane Mode → Is Turned Off**. Add a **Wait 20 seconds** action *before* Run Shortcut so mobile data has time to connect. | `airplane_off` |
| Wi‑Fi | **Wi‑Fi** → choose networks such as the airport, hotel or home Wi‑Fi. You can only pick networks the phone has seen, so add the Treasure Island Wi‑Fi after you first join it. | `wifi` |
| Hotel arrival | **Arrive** → *Treasure Island Hotel & Casino, Las Vegas*, radius ≈ 200 m | `arrive_hotel` |
| Low battery | **Battery Level → Falls Below 15%** | `low_battery` |
| Periodic heartbeat (recommended) | **Time of Day**, e.g. 09:00, 13:00, 18:00 and 22:00, Daily | `scheduled` |

Notes and limitations:

- **No continuous background tracking.** Updates are sent only when an automation fires or you tap the shortcut. The dashboard always shows the *last confirmed* location with its timestamp.
- Location automations rely on iOS geofencing. They can fire late, only fire once you are some way inside the area, or not fire at all after a long flight. The *Airplane Mode → Off* automation is the most reliable landing signal. Tap the manual check-in if you see no notification.
- If the request fails (no data yet), the shortcut stops with an error notification. Nothing is queued on the phone, so tap `TravelPulse` again once you have signal.
- Duplicate triggers are harmless. When *Airplane Mode Off* and *Arrive JFK* fire together, the server sends only **one** WhatsApp message.

## 4. Manual WhatsApp fallback (no server or WhatsApp API)

Use this if the backend or the WhatsApp API is unavailable. Create a shortcut called `TravelPulse Fallback`:

1. **Get Current Location**
2. **Get Battery Level**
3. **Text**:
   ```
   ✈️ Travel Update
   I'm at [Current Location → City], [Current Location → Country]
   🔋 Battery: [Battery Level]%
   Map: https://maps.google.com/?q=[Latitude],[Longitude]
   ```
4. **Send Message via WhatsApp** to Mom, then the same again for Dad. These steps ask you to confirm. You can also use the built-in **Send Message** action to send an SMS instead.

## 5. Pre-departure test (do this at home)

1. Run `TravelPulse` manually and check that your parents receive the message.
2. Turn Airplane Mode on, then off, and check that `airplane_off` arrives.
3. Open the dashboard link on your parents' phones.
4. Run the simulator in `--live` mode (see the README). Then **reset** the data before you leave.

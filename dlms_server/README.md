# AMR data server

Receives meter readings and the serial log from the AMR firmware
(`firmware/`, FW 2.0.1 and later) over TCP. Stores them in SQLite plus daily
log files, and shows them on a small web page with a REST API.

```
ESP32 + EC200U ──TCP 7001──▶ src/tcp-server.js ──▶ data/amr-data.db
                                                └─▶ data/logs/<IMEI>/<date>.log
browser ────────HTTP 7002──▶ src/http-server.js (page + /api)
```

## Run

Node.js 18 or newer.

```bash
cd dlms_server
npm install
cp .env.example .env      # set VIEW_PASSWORD and MASTER_SECRET
npm start
npm test                  # unit + end-to-end tests
npm run send-sample       # act as a device: one reading + one log
npm run check             # is the server receiving packets? (see below)
```

### Checking that packets arrive

`tools/check-receive.js` sends one READING and one LOG as a device would, then
reads them back through the API. Each step prints PASS or FAIL with the reason;
the exit code is 0 only if all passed. On the server itself `npm run check` is
enough (settings come from `.env`). From another machine:

```bash
node tools/check-receive.js --host 65.20.77.137 --pass <VIEW_PASSWORD> --secret <MASTER_SECRET>
```

| Option | Default |
|---|---|
| `--host` | 127.0.0.1 |
| `--port` / `--http` | `TCP_PORT` / `HTTP_PORT` (7001 / 7002) |
| `--user` / `--pass` | `VIEW_USER` / `VIEW_PASSWORD` |
| `--secret` | `MASTER_SECRET` (`""` sends unsigned) |
| `--device` | `TEST-CHECK` (shows up as a device on the page) |
| `--no-api` | only check the TCP side (when port 7002 is not reachable) |

Open `http://<host>:7002/` and sign in with `VIEW_USER` / `VIEW_PASSWORD` on the
sign-in page; **Log out** is in the top bar. Sessions end after `SESSION_IDLE_SEC`
(12 h) without use, after `SESSION_MAX_SEC` (7 days), or when the server restarts.
Scripts can send the same login as HTTP Basic (`curl -u admin:<VIEW_PASSWORD>`).
Without `VIEW_PASSWORD` the page has no login and only listens on 127.0.0.1.
For HTTPS, put nginx in front and keep `HTTP_HOST=127.0.0.1`.

On the VM, open the device port and (if not behind nginx) the page port:

```bash
sudo ufw allow 7001/tcp
sudo ufw allow 7002/tcp
```

Then set `DATA_SERVER_HOST` in `firmware/config.h` to the VM address, build, and
upload the image on the OTA dashboard. To run it as a service, see
`deploy/README.md`.

## Page

A device is **Online** when its last message (reading or log) is at most
`ONLINE_AFTER_MIN` (35) minutes old, **Delayed** up to `OFFLINE_AFTER_MIN` (90),
then **Offline**. Problems with the meter itself (last read cycle failed, logs
but no readings, no reading for a long time, unsigned data while signatures are
checked) are listed as issues next to the status.

- **Sidebar:** Home, and the Fleet group (all meters, offline, read failures,
  unsigned data) with live counts. From 1280 px wide it can be collapsed to
  icons (the choice is remembered), between 1024 and 1279 px it is always
  icons, and below 1024 px it opens as a drawer from the menu button.
- **Top bar:** breadcrumb, meter search (Ctrl+K or "/"), a connection pill
  (live with the time of the last load, updating, or connection problem),
  refresh, light/dark switch and the account menu (theme System / Light /
  Dark, the server's status settings, log out).
- **Home:** quick actions (offline meters, read failures, CSV export, all
  meters); device counts by status; readings and failed reads today, each
  with the change against yesterday until the same time of day; a chart of
  reads and log uploads per hour today; fleet health; the devices that need
  attention (most urgent first); the latest message of each device; status
  by device firmware.
- **Meters:** every device with status, last message, last read result, V
  R/Y/B, current, kW, kWh, firmware and issues; search, status filters,
  sorting, paging, links to each meter's trends and device log, and CSV
  export of the meters shown.
- **Meter page** (header with status and banners, then tabs):
  - *Instantaneous:* R/Y/B phase cards (V, A, PF, kW), frequency, kW / kvar /
    kVA, voltage and current unbalance.
  - *Energy & demand:* energy registers, maximum demand with its time from the
    billing profile, time-of-day zones.
  - *Meter info:* name plate, CT/PT ratio and periods, meter counters.
  - *Trends:* voltage / current / PF / power / frequency / energy, or any
    numeric value, over 24 h / 7 d / 30 d / a custom range; chart, table, CSV.
  - *Load profile:* block load, daily load (with consumption per day),
    instantaneous, name plate and other profiles; chart, table, CSV.
  - *Billing:* consumption per billing period and MD charts, all billing
    entries side by side, CSV.
  - *Events:* all event logs merged, with category filter and the snapshot
    values recorded with each event.
  - *Communication:* read cycles per day, failure rate, delivery delay, boots,
    log uploads and dropped log bytes (last 7 days).
  - *All values, Read cycles, Device log:* the raw values of the last cycle,
    every read cycle, and the serial log of one day (last 256 KB).

### Device names

Each device can be given a name (up to 64 characters) with the ✎ button next to
its title on the meter page; saving an empty name clears it. Pages show the name,
else the meter serial, else the IMEI, with the other identifiers below it. The
search boxes match names too, the Meter info tab lists the name, and CSV
downloads start with it. Names are kept in the `devices` table, which device
messages never change. Two devices may share a name; the meter page then warns
about it. Scripts can set a name with
`curl -u admin:<VIEW_PASSWORD> -X PUT -H 'X-AMR-Data: 1' -H 'Content-Type: application/json' -d '{"name":"Feeder B"}' http://<host>:7002/api/devices/<IMEI>/name`.

Values of the latest reading are matched by OBIS code (`public/js/obis.js`,
names as in `firmware/obis_names.h`) and shown with the unit the device sent.
Server times are shown in `TIMEZONE`; profile times are the meter's own clock.
The page refreshes every 30 s while visible (history tabs only when opened or
changed) and warns when it has not refreshed for over a minute. The theme
follows the system light/dark setting unless one is chosen in the account
menu (kept in the browser). Chart.js is served from `node_modules` and loaded
only on pages with charts, so the page loads nothing from other sites.

## Device protocol

One TCP connection after each read cycle. Each message is a JSON header line
and then exactly `bytes` bytes of body:

```text
{"type":"READING","deviceId":"<IMEI>","boot":B,"seq":N,"fw":"2.0.1","ageS":A,"bytes":M,"sig":"..."}\n<M bytes>
{"type":"LOG","deviceId":"<IMEI>","boot":B,"seq":N,"bytes":M,"dropped":D,"uptimeS":U,"sig":"..."}\n<M bytes>
```

| Field | Meaning |
|---|---|
| `boot` | random per boot (0 = none). With `seq`, a resent message is stored once. |
| `seq` | per type, counts up from 0 after each boot |
| `ageS` | seconds since the reading was taken (it may have waited in the queue). The server stores `read_at = received - ageS`. |
| `dropped` | log bytes lost because the device's ring buffer was full |
| `sig` | optional, see below |

READING body (values as on the BLE link):

```json
{"ret":0,"values":[
  {"obis":"1.0.1.8.0.255","name":"Cumulative Energy kWh","v":12.345,"u":"kWh"},
  {"obis":"0.0.96.1.0.255","name":"Meter Serial Number","s":"X1234567"}]}
```

`ret` is the meter cycle's result code (0 = OK). A failed cycle is still sent, so
communication problems with the meter show up on the page.

FW 2.0.2 adds the profile rows read in the cycle (left out when there are none):

```json
"profiles":[{"obis":"1.0.99.1.0.255","name":"Block Load Profile",
  "cols":[{"obis":"0.0.1.0.0.255","name":"Clock","u":""},{"obis":"1.0.1.29.0.255","name":"Block kWh","u":"kWh"}],
  "rows":[{"t":"2026-10-23 10:30:00","c":["2026-10-23 10:30:00",0.42]},
          {"t":"2026-03-07 22:56:25","c":["2026-03-07 22:56:25",7],"e":"Over voltage - Occ"}]}]
```

`t` is the row time in meter local time (or `null`), `c` one cell per column
(number, string or `null`), `e` the event name of event log rows. The firmware
sends only rows it has not sent before (plus the current billing row and the
instantaneous snapshot each time), but after a reboot or an outage it may send
some again: each row is stored once per device and profile. Timed rows are
keyed by `t` (a resend with other values replaces the row); event rows and
rows without a time by a hash of `t` and `c`.

| Profile | Read (firmware defaults, settable over BLE / `SET`) | Sent |
|---|---|---|
| Meter readings (values) | every 15 min (`read`) | all values |
| Instantaneous 1.0.94.91.0.255 | every 30 min (`profile`) | the snapshot |
| Block load 1.0.99.1.0.255 | every 30 min | new blocks |
| Billing 1.0.98.1.0.255 | every 30 min | current row; closed months once |
| Event logs 0.0.99.98.0-5.255 | every 30 min | new events |
| Daily load 1.0.99.2.0.255 | first cycle after midnight | new days |
| Name plate, others | boot and BLE "read now" | every row |

The LOG body is raw serial text.

The server answers each message with one line (`{"ok":true,...}`,
`{"ok":true,...,"dup":true}` or `{"ok":false,"error":...}`). The firmware does
not wait for these; it relies on the modem's `SEND OK`. A framing error (bad
header) closes the connection.

The 2.0.0 firmware's log upload (no `boot`, unsigned) is still accepted.

### Signatures

```
device_key = HMAC_SHA256(MASTER_SECRET, IMEI)                 (hex, as on the OTA server)
sig        = HMAC_SHA256(device_key, "<type>|<deviceId>|<boot>|<seq>|<sha256(body) hex>")
```

The device gets its key when it is approved on the OTA dashboard. Until then it
sends no `sig`.

| Setting | Signed, valid | Signed, wrong | Unsigned |
|---|---|---|---|
| `MASTER_SECRET` set, `REQUIRE_SIGNED=false` (default) | stored, verified | rejected | stored, unverified |
| `REQUIRE_SIGNED=true` | stored, verified | rejected | rejected |
| no `MASTER_SECRET` | stored, unverified | stored, unverified | stored, unverified |

Once every device is approved, set `REQUIRE_SIGNED=true` so nobody can post data
under your IMEIs.

## REST API

All times are epoch milliseconds. `from` / `to` also take ISO dates. Profile
rows are the exception (meter local time as text, see the table).

| Call | Returns |
|---|---|
| `GET /api/health` | `{ok:true}` (no login) |
| `POST /auth/login` | `{username, password}` with header `X-AMR-Data: 1`: sets the session cookie (no login) |
| `POST /auth/logout` | ends the session (header `X-AMR-Data: 1`) |
| `GET /auth/me` | `{username}`, or 401 when not signed in |
| `GET /api/config` | `{timezone, onlineAfterMin, offlineAfterMin, signing, login, now}` |
| `GET /api/meters` | `{now, counts, meters}`: each device with status, issues and key values of its newest reading with values |
| `GET /api/fleet` | counts, readings / failed / logs per hour since midnight (`TIMEZONE`), last message, devices needing attention, status by firmware |
| `GET /api/devices` | devices, last seen first |
| `GET /api/devices/:id/stats?days=7` | read cycles (per day and total), failures, boots, delivery delay, log uploads, last log |
| `GET /api/devices/:id/latest` | latest reading with all values, or `null` |
| `GET /api/devices/:id/readings?from=&to=&limit=` | read cycles (default last 7 days, max 5000) |
| `GET /api/devices/:id/readings?obis=1.0.32.7.0.255&from=&to=` | one value over time |
| `GET /api/devices/:id/profiles` | profiles the device sent: columns, row count, newest row time |
| `GET /api/devices/:id/profiles/:obis?from=&to=&limit=` | `{obis, name, cols, rows}`, rows newest first (default 500, max 5000). `from` / `to` are meter local time `YYYY-MM-DD[ hh:mm[:ss]]`; a bare `to` date includes that day. |
| `GET /api/devices/:id/log-dates` | days with a log file, newest first |
| `GET /api/devices/:id/logs?date=YYYY-MM-DD&tail=65536` | end of that day's log (text) |

## Settings

See `.env.example`. `RETENTION_DAYS` (default 0 = keep everything) deletes
older readings and log files once an hour.

## Files

| File | |
|---|---|
| `src/server.js` | entry point |
| `src/config.js` | `.env` and defaults |
| `src/framing.js` | header line + body parser |
| `src/verify.js` | device key and signature check |
| `src/reading.js` | READING body check |
| `src/db.js` | SQLite schema and queries |
| `src/log-store.js` | daily log files |
| `src/tcp-server.js` | device port |
| `src/http-server.js` | page, REST API, login |
| `src/meters.js` | device status, issues, meter list and fleet summary |
| `src/message.js` | builds device messages (tests, sample tool) |
| `public/` | web page: ES modules, no build step (`js/main.js` router, `js/views/` pages and tabs) |
| `tools/send-sample.js` | fake device |

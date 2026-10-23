# AMR data server

Receives meter readings and the serial log from the AMR firmware
(`client/`, FW 2.0.1 and later) over TCP. Stores them in SQLite plus daily
log files, and shows them on a small web page with a REST API.

```
ESP32 + EC200U ──TCP 5100──▶ src/tcp-server.js ──▶ data/amr-data.db
                                                └─▶ data/logs/<IMEI>/<date>.log
browser ────────HTTP 5101──▶ src/http-server.js (page + /api)
```

## Run

Node.js 18 or newer.

```bash
cd server
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
| `--port` / `--http` | `TCP_PORT` / `HTTP_PORT` (5100 / 5101) |
| `--user` / `--pass` | `VIEW_USER` / `VIEW_PASSWORD` |
| `--secret` | `MASTER_SECRET` (`""` sends unsigned) |
| `--device` | `TEST-CHECK` (shows up as a device on the page) |
| `--no-api` | only check the TCP side (when port 5101 is not reachable) |

Open `http://<host>:5101/` and log in with `VIEW_USER` / `VIEW_PASSWORD`.
Without `VIEW_PASSWORD` the page has no login and only listens on 127.0.0.1.
For HTTPS, put nginx in front and keep `HTTP_HOST=127.0.0.1`.

On the VM, open the device port and (if not behind nginx) the page port:

```bash
sudo ufw allow 5100/tcp
sudo ufw allow 5101/tcp
```

Then set `DATA_SERVER_HOST` in `client/config.h` to the VM address, build, and
upload the image on the OTA dashboard. To run it as a service, see
`amr-data.service`.

## Page

- **Device list:** IMEI, last seen (green under 35 min, amber under 90 min, red
  after that), firmware, signed/unsigned.
- **Latest:** every value of the last read cycle, with a filter.
- **History:** one numeric value over 24 h / 7 d / 30 d, as a chart and a table.
- **Profiles:** block load, daily load, billing, instantaneous, event logs and
  name plate as tables (FW 2.0.2). Wide profiles (billing, instantaneous) are
  shown one line per column with the newest 12 entries side by side.
- **Readings:** each read cycle with its result code and value count.
- **Log:** the serial log of one day (last 256 KB).

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
| `GET /api/devices` | devices, last seen first |
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
| `src/message.js` | builds device messages (tests, sample tool) |
| `public/` | web page (no build step) |
| `tools/send-sample.js` | fake device |

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
```

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

- **Device list:** IMEI, last seen (green under 10 min, amber under 30 min, red
  after that), firmware, signed/unsigned.
- **Latest:** every value of the last read cycle, with a filter.
- **History:** one numeric value over 24 h / 7 d / 30 d, as a chart and a table.
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

All times are epoch milliseconds. `from` / `to` also take ISO dates.

| Call | Returns |
|---|---|
| `GET /api/health` | `{ok:true}` (no login) |
| `GET /api/devices` | devices, last seen first |
| `GET /api/devices/:id/latest` | latest reading with all values, or `null` |
| `GET /api/devices/:id/readings?from=&to=&limit=` | read cycles (default last 7 days, max 5000) |
| `GET /api/devices/:id/readings?obis=1.0.32.7.0.255&from=&to=` | one value over time |
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

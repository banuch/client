# AMR project

Automatic meter reading for IS 15959 DLMS energy meters: an ESP32-S3 device reads the
meter and sends readings, profiles and its serial log over 4G, and takes signed,
device-specific firmware updates.

| Folder | What | Run |
|---|---|---|
| [`firmware/`](firmware) | ESP32-S3 + EC200U Arduino sketch (FW version in `firmware/config.h`) | `firmware\build.bat [COMx] [compile\|upload\|monitor]` |
| [`dlms_server/`](dlms_server/README.md) | Receives readings, profiles and logs; SQLite, web page, REST API | `cd dlms_server && npm install && npm start` |
| [`ota_server/`](ota_server/README.md) | Registration, device keys, OTA releases, dashboard | `cd ota_server && npm install && npm start` |
| [`shared/`](shared) | Device key + HMAC code used by both servers | — |
| [`docs/`](docs) | IS 15959 standards (2011, 2016, 2017) | — |

```
             RS-232 (DLMS/HDLC)          TCP 7001
  meter ◀──────────────────▶ device ─────────────────▶ dlms_server  (web + API :7002)
                               │  ▲
                        BLE    │  │  HTTP 7000 (register, check, firmware, report)
  phone app ◀──────────────────┘  └────────────────▶ ota_server   (dashboard :7000)
```

## Ports

| Port | Who listens | Set in |
|---|---|---|
| 7001/tcp | `dlms_server` device port | `DATA_SERVER_PORT` in `firmware/config.h`, `TCP_PORT` in `dlms_server/.env` |
| 7002/tcp | `dlms_server` web page + API | `HTTP_PORT` in `dlms_server/.env` |
| 7000/tcp | `ota_server` device API + dashboard | `OTA_PORT_DEFAULT` in `firmware/config.h` (NVS `port` overrides), `PORT` in `ota_server/.env` |

## Device keys

Each device's key is `HMAC_SHA256(MASTER_SECRET, IMEI)` (`shared/device-key.js`). The
device gets it from `ota_server` when an admin approves its registration, then signs both
its OTA requests and its data messages with it. **Both servers must have the same
`MASTER_SECRET`** in their `.env`; `dlms_server` uses it to mark data as verified.

## Release

1. Bump `FW_VERSION` in `firmware/config.h`.
2. `firmware\build.bat COMx compile` → `firmware/release/amr_client_<ver>.bin`.
3. Upload that file on the OTA dashboard (Releases) with the same version, then point a
   channel at it or pin devices.

## Deploying the servers

Clone the whole repository on the VM (both servers load `../shared`), then in each server
folder: `npm install`, `cp .env.example .env`, edit it, `npm start`.
`dlms_server/amr-data.service` runs the data server under systemd. Open 7000, 7001 and
7002 in the firewall (or put nginx in front of the web ports).

# Source code analysis

Inventory of the repository at commit `7fef5c5` (branch `master`), built by reading the
source. Line numbers refer to that commit. Server addresses, passwords and keys found
in the code are deliberately **not** reproduced here.

Scope: this repository only (`client/`). Sibling folders in the parent directory
(`bridge_server`, `dlms_client`, `server_new`, `tcp-server`, …) are older or separate
projects and are not part of the deployed system described by `README.md`; they were
not analysed.

## Repository map

| Area | Path | Language | Size (project code) |
|---|---|---|---|
| Device firmware | `firmware/` | Arduino C++ (ESP32-S3), 13 `.ino` tabs + C++ helpers | ~6 900 lines |
| DLMS/COSEM library | `firmware/src/*.c`, `firmware/include/*.h`, `GXDLMSClient.*` | C (Gurux DLMS, GPL v2) | vendored |
| Data server | `dlms_server/` | Node.js 18+, Express 4, better-sqlite3 | ~1 400 lines server + ~2 900 lines SPA |
| OTA server | `ota_server/` | Node.js 18+, Express 4, better-sqlite3, multer | ~1 450 lines server + 600 lines dashboard |
| Shared crypto | `shared/device-key.js` | Node.js | 36 lines |
| Deployment | `deploy/`, `tools/deploy.ps1` | systemd units, bash, PowerShell | — |
| Field tool | `tools/ble-configurator/index.html` | Web Bluetooth page | 1 248 lines |
| Standards | `docs/IS 15959 *.pdf` | reference | — |

Tests: `dlms_server/test` (34 tests, `node --test`), `ota_server/test` (33 tests). No
firmware unit tests or hardware-in-the-loop tests exist.

## Implemented vs. not implemented

| Topic from the brief | Status | Evidence |
|---|---|---|
| UART to meter (RS-232 via MAX3232) | Implemented | `firmware.ino` L49-67, L164-171 |
| RS-485 | **Not implemented** | no code or pin definition |
| DLMS/COSEM (HDLC, LN, LLS) | Implemented (device side only) | `firmware.ino` L550-606, Gurux `src/` |
| HLS / ciphering | Library supports it, **not enabled** | `firmware.ino` L1670-1685 commented out |
| OBIS processing, scaler/unit | Implemented | `firmware.ino` L1290-1465, `profiles.ino` L277-331 |
| Profile Generic (block load, daily, billing, events) | Implemented | `profiles.ino` |
| 4G modem (EC200U) | Implemented | `modem.ino` |
| TCP client | Implemented (device → server only) | `modem.ino` L444-560, `log_bridge.ino` |
| TCP server / bridge | Implemented (`dlms_server`), receives JSON, **does no DLMS** | `dlms_server/src/tcp-server.js` |
| Server → device commands / polling | **Not implemented** | server only writes reply lines |
| OTA | Implemented (HTTP pull, HMAC-signed offer, MD5, dual slot) | `ota_client.ino`, `ota_server/src/routes/device.js` |
| OTA rollback confirmation | **Not implemented** | no `esp_ota_mark_app_valid_cancel_rollback` |
| Watchdog | **Not implemented** in sketch | no `esp_task_wdt*` / `enableLoopWDT` |
| Local buffering | RAM/PSRAM queue (48 readings) + NVS profile markers | `reading_upload.ino` |
| Database | SQLite (two separate files) | `dlms_server/src/db.js`, `ota_server/src/db.js` |
| Dashboard | Two SPAs (meter data; OTA admin) | `dlms_server/public`, `ota_server/public` |
| BLE local interface | Implemented | `ble_meter.cpp`, `ota_ble.ino` |
| TLS | **Not implemented** (plain TCP / HTTP) | `modem.ino` L455, `http_lite.ino` |

## Firmware modules

| File | Purpose | Key functions (line) | Inputs → outputs | Depends on | Errors / recovery | Config |
|---|---|---|---|---|---|---|
| `firmware.ino` | Entry point, meter transport, association view, value formatting | `setup` 1635, `loop` 1728, `com_readAllObjects` 1530, `com_initializeConnection` 550, `readDLMSPacket` 310, `com_readDataBlock` 380, `com_readSerialPort` 251, `com_close` 420, `av_read` 1230, `av_parse` 1171, `av_readScalers` 1290, `av_readValues` 1469, `formatValue` 1390, `readAttribute` 1250 | HDLC bytes on UART1 → values via `rd_add*`, `ble_readingAdd*` | Gurux client, `profiles.ino`, `meter_password.ino`, `schedule.ino` | 10 s per frame, 3 resends, 50 s deadline per exchange, 3 association attempts; link error aborts cycle | `METER_*`, `WAIT_TIME`, `RESEND_COUNT`, `CONNECT_RETRY` |
| `profiles.ino` | Profile Generic reading and row selection | `pg_readCycle` 1148, `pg_readProfile` 938, `pg_applyScalers` 277, `pg_collect` 746, `pg_readClock` 1125, `pg_rangeSelector` 541, `pg_entrySelector` 575 | capture objects + buffer → `rd_profile*` rows, markers | `firmware.ino` readAttribute, `reading_upload.ino` | range → by-entry fallback; skip > 400 rows w/o marker; link errors abort | `PG_*` limits L40-47 |
| `schedule.ino` | When to read values / profiles / daily | `sched_due` 87, `sched_done` 125, `sched_syncClock` 60 | meter clock → CYCLE flags | `g_cfg` | uptime fallback until clock read; daily read retried on failure | `READ_INTERVAL_*`, `PROFILE_INTERVAL_*`, `SCHED_DELAY_S` |
| `meter_password.ino` | LLS password list, search | `mpw_begin` 236, `mpw_search` 291, `mpw_isRejected` 263 | AARE result → active password | NVS, `Client.SetPassword` | search max every 6 h; stops on link error | `METER_PASSWORDS_DEFAULT`, `MPW_*` |
| `reading_upload.ino` | Build READING JSON, queue, profile markers | `rd_begin` 101, `rd_end` 413, `rd_pop` 474, `rd_reject` 492, `mk_get` 288, `mk_advance` 312, `mk_commit` 332, `mk_checkEpoch` 371 | values/rows → queued bodies (PSRAM) | Preferences (NVS) | queue full → drop oldest + marker rollback; OOM → not queued | `RD_QUEUE_MAX` 48, `PG_MARK_EPOCH` |
| `log_bridge.ino` | Upload readings + trace to `dlms_server` | `lb_upload` 225, `lb_sendReading` 115, `lb_readReply` 144, `lb_sendLog` 195, `lb_sigField` 77 | queue + trace → TCP frames | `modem.ino`, `ota_client.ino` (HMAC) | failure keeps queue, forces modem re-init | `DATA_SERVER_*`, `LOG_UPLOAD_MAX` |
| `trace_tee.cpp/.h` | USB print + ring buffer capture | `TraceTee::write` , `peek`, `consume` | all trace text → USB + 256 KB ring | PSRAM | overflow drops oldest, counted | `TRACE_LOG_SIZE` |
| `modem.ino` | EC200U AT driver | `modem_hwInit` 85, `modem_init` 116, `modem_autoApn` 244, `modem_tryApn` 222, `modem_ensure` 342, `modem_tcpOpen` 444, `modem_tcpSend` 478, `modem_tcpRead` 518, `modem_epochSeconds` 404 | AT text on UART2 | NVS (APN cache) | PWRKEY x2, ESP restart after 2 h silent; QIOPEN retry once | `MODEM_*`, `APN_TABLE` |
| `http_lite.ino` | Minimal HTTP/1.1 over modem socket | `http_open` 309, `http_read` 359, `http_requestJson` 378 | request → status/body | `modem.ino` | 30 s idle timeout; chunked rejected; 2 KB JSON max | `HTTP_*` |
| `ota_client.ino` | Signed OTA check/download/report | `ota_run` 293, `ota_check` 133, `ota_download` 185, `ota_report` 115, `ota_reportBootResult` 280, `ota_hmac` 40 | server offer → flashed slot | `http_lite`, `esp_ota_*`, mbedTLS | abort on any mismatch; retry 900 s | `OTA_*`, `CHECK_*` |
| `register.ino` | Automatic device-key provisioning | `reg_run` 182, `reg_unwrap` 146, `reg_sessionKey` 110 | ECDH + AES-GCM reply → device key in NVS | mbedTLS, `http_lite` | pending poll 60-120 s; 403 waits interval | `SERVER_REG_PUBKEY_HEX`, `REGISTER_*` |
| `nvs_config.ino` | Runtime configuration | `cfg_load` 6, `cfg_set` 41 | NVS ↔ `g_cfg` | Preferences | invalid stored values replaced by defaults | keys `K_*` in `config.h` |
| `commands.ino` | Text command interpreter (USB + BLE) | `cmd_handle` 125, `cmd_set` 94, `cmd_authOk` 48 | command line → action/text | cfg, mpw, mk | BLE writes need device key once provisioned | — |
| `ble_meter.cpp/.h` | BLE meter GATT service | `ble_begin` 215, `ble_poll` 268, `ble_reading*` 336-371 | app commands ↔ readings | NimBLE | callbacks only set flags | UUIDs in `ble_meter.h` |
| `ota_ble.ino` | BLE Nordic-UART command channel | `otaBle_init`, `otaBle_poll` | BLE line → `cmd_handle` | `ble_meter` | one pending command | `OTA_BLE_*` |
| `reset_reason.cpp` | Reset reason text | `resetReasonText` | — | ESP-IDF | — | — |
| `obis_names.h` | OBIS and event name tables | `OBIS_NAMES` L17, `EVENT_NAMES` L236 | — | — | — | — |
| `config.h` | Build-time configuration and shared structs | — | — | — | — | `FW_VERSION` 2.0.12 |
| `build.bat` | arduino-cli compile/upload/monitor, release copy | — | sketch → `release/amr_client_<ver>.bin` | arduino-cli | — | FQBN with `app3M_fat9M_16MB`, `PSRAM=opi` |

## dlms_server modules

| File | Purpose | Key functions | Notes |
|---|---|---|---|
| `src/server.js` | Start TCP + HTTP, retention timer | `start()` L13 | hourly prune when `RETENTION_DAYS > 0` |
| `src/config.js` | `.env` loader, limits | `loadConfig` L32, `assertConfig` L77 | binds web to 127.0.0.1 without `VIEW_PASSWORD` |
| `src/tcp-server.js` | Device port, reply per message | `createTcpServer` L24, `handle` L31 | idle 120 s, `maxConnections` 200 |
| `src/framing.js` | Header-line + body framing | `FrameParser.push` L69, `validateHeader` L32 | any framing error closes the socket |
| `src/verify.js` | HMAC check | `checkMessage` L22 | unsigned accepted unless `REQUIRE_SIGNED` |
| `src/reading.js` | READING JSON validation | `parseReading` L96, `parseProfile` L38 | caps: 2000 values, 50 profiles, 256 cols, 5000 rows |
| `src/db.js` | SQLite schema, writes, queries | `openDb` L165, `saveReading` L210, `migrate` L134 | dedupe by (device, boot, seq); profile row upsert by `row_key`; open billing row key |
| `src/log-store.js` | Per-device daily log files | `append`, `tail`, `prune` | |
| `src/meters.js` | Status/issues for the UI | `buildMeters`, `meterIssues`, `attention` | online ≤ 35 min, offline > 90 min |
| `src/http-server.js` | REST API, login, static SPA | `createHttpApp` L96 | in-memory sessions, lockout, CSP |
| `public/js/*` | SPA: router, API, views | `main.js`, `api.js`, `views/*.js` | 30 s refresh of the visible view |

## ota_server modules

| File | Purpose | Key functions | Notes |
|---|---|---|---|
| `src/server.js`, `src/app.js` | Express app, request log (token stripped) | `createApp` | 15 min socket timeout |
| `src/routes/device.js` | `/ota/check`, `/register`, `/firmware`, `/report` | router L58 | flat JSON, Content-Length set |
| `src/hmac.js` | Signature check, `ReplayGuard` | `verifyRequest` L36 | ±300 s window |
| `src/resolver.js` | Target version | `resolveTarget` L39 | pin > channel-if-newer |
| `src/regkey.js` | Server P-256 key, device-key wrapping | `loadRegKey`, `wrapDeviceKey` | key file created on first start |
| `src/db.js` | releases, channels, devices, tokens, events, users, sessions | `issueToken` L221, `consumeToken` L228 | single-use token, TTL 600 s |
| `src/auth.js` | scrypt passwords, DB sessions, roles | | CSRF header on writes |
| `src/routes/admin.js` | Dashboard API | releases upload L135 (checks ESP magic `0xE9`, computes MD5) | |

## Message formats (as implemented)

* **Device → dlms_server** (TCP 7001): `{"type":"READING"|"LOG","deviceId","boot","seq","bytes",…,"sig"}\n` + `bytes` of body.
  Signature: `HMAC_SHA256(device_key, "<type>|<deviceId>|<boot>|<seq>|<sha256(body)>")`.
* **dlms_server → device**: one JSON line per message: `{"ok":true,"seq":N[,"dup"][,"skipped"]}` or `{"ok":false,…}`.
* **Device ↔ ota_server** (HTTP 7000): `POST /ota/register`, `POST /ota/check`, `GET /ota/firmware`, `POST /ota/report` (see Diagram 6).
* **Device key**: `HMAC_SHA256(MASTER_SECRET, IMEI)`, delivered to the device encrypted with P-256 ECDH + AES-256-GCM.

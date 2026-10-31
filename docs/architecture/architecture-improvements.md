# Architecture and code-quality review — prioritized improvements

Analysis only; no source code was changed. Severity: **High** = can lose data, brick or
compromise devices; **Medium** = reliability or operability gap; **Low** = hygiene.
"Recommended" items are proposals, not current behaviour.

## Summary

The codebase is unusually careful for an embedded IoT project: bounded timeouts on every
meter and modem exchange, acknowledged uploads with server-side de-duplication, profile
markers committed only after the server stores the rows, signed OTA offers bound to the
request timestamp, single-use download tokens, and ECDH-wrapped key delivery. The main
gaps are around **supervision (watchdog, rollback)**, **transport confidentiality**, and
**persistence of queued data across resets**.

## Findings

| # | Severity | Area | Finding | Impact | Files | Recommendation |
|---|---|---|---|---|---|---|
| 1 | High | OTA robustness | No `esp_ota_mark_app_valid_cancel_rollback()` / rollback logic. Whether the bootloader's app-rollback is enabled in the Arduino core build is **Not verified**. | A new image that boots but crashes or cannot reach the network can strand the device until a site visit. | `firmware/ota_client.ino` L252-290 | Enable `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` (custom sdkconfig / PlatformIO), mark the app valid only after a successful upload or OTA check, otherwise reboot into the previous slot. |
| 2 | High | Reliability | No watchdog. Every call is blocking in one task; an OTA download at 9600 baud blocks `loop()` for ~25 min by design, and a wedged driver call is never recovered. | Silent hang in the field. | `firmware/firmware.ino` `loop()`; `modem.ino`; `ota_client.ino` | Add `esp_task_wdt` on the loop task with feeds inside long loops (`com_readSerialPort`, `ota_download`, `modem_waitAttach`); set the timeout above the longest legitimate step. |
| 3 | High | Security | Plain TCP and HTTP: readings, logs (meter serial numbers, IMEI, traces) and firmware images travel in clear. HMAC gives integrity/authenticity but no confidentiality. | Eavesdropping; firmware images can be copied. | `modem.ino` L455, `http_lite.ino`, both servers | Use EC200U SSL sockets (`AT+QSSLCFG`/`QSSLOPEN`) or a TLS-terminating proxy (nginx) with a pinned CA; keep HMAC for end-to-end authenticity. |
| 4 | High | Data completeness | The READING queue lives only in RAM/PSRAM (48 items). Any reset (brown-out, OTA, modem-silent restart after 2 h) loses unsent register values; profile rows are recovered from NVS markers, register snapshots are not. | Gaps in instantaneous/energy history after outages. | `firmware/reading_upload.ino` L31-47, L413-465 | Persist queued bodies to the unused FAT partition (9 MB in `app3M_fat9M_16MB`) or LittleFS; replay after boot. |
| 5 | Medium | Security | `dlms_server` accepts unsigned data by default (`REQUIRE_SIGNED=false`) and stores it as "unverified" for any device id. | Anyone who can reach port 7001 can inject readings for an arbitrary id. | `dlms_server/src/verify.js` L22-32, `.env.example` | Set `REQUIRE_SIGNED=true` in production once all devices are provisioned; firewall 7001 to carrier ranges if possible. |
| 6 | Medium | Security | Default meter LLS passwords, the data server address and the registration public key are compiled into `config.h` and committed. | Credentials leak with the repository; changing them needs a firmware release. | `firmware/config.h` L45, L69, L82, L103 | Move meter passwords to NVS provisioning only; keep server address in NVS (already overridable for OTA host); do not commit real meter passwords. |
| 7 | Medium | Security | Over BLE, an **unprovisioned** device accepts `SET host=… port=…` and `METER_PW` without authentication (documented as intentional commissioning). | A nearby attacker can redirect an unprovisioned device; offers still need a valid HMAC so firmware cannot be pushed. | `firmware/commands.ino` L48-54 | Require a physical action (button / USB) or a time window after power-on for unauthenticated commissioning. |
| 8 | Medium | OTA integrity | Image integrity is MD5 (bound into the HMAC-signed offer) plus `esp_ota_end` validation. No image signature by a release key. | Server compromise (holder of `MASTER_SECRET`) can push any image to every device. | `ota_client.ino` L133-262, `ota_server/src/routes/admin.js` L135 | Sign release images offline (ECDSA) and verify on device, or enable ESP32 Secure Boot v2; switch MD5 → SHA-256. |
| 9 | Medium | OTA robustness | No resume: a dropped connection restarts the whole 1.5 MB transfer (≈25 min at 9600 baud) after 15 min. | Repeated failures on weak coverage; long loop blocking. | `ota_client.ino` L185-262, `config.h` L30-33 | Raise `MODEM_BAUD` to 115200 (comment in `config.h` already suggests it); add HTTP `Range` resume. |
| 10 | Medium | Config bug | `CHECK_INTERVAL_DEFAULT_S` is `600L` but its comment says "24 h". `cfg_load` uses it as the default OTA check interval. | Devices without a server override check every 10 min instead of daily (the server default is 86400 s, so this only matters until the first check reply). | `firmware/config.h` L92, `nvs_config.ino` L12 | Align value and comment deliberately. |
| 11 | Medium | Monitoring | Only liveness endpoints; no alerting for offline meters, failed reads, upload refusals, disk usage. | Problems are noticed only on the dashboard. | `dlms_server/src/http-server.js`, `ota_server/src/app.js` | Export Prometheus-style metrics or a daily summary; alert on `attention()` list. |
| 12 | Medium | Data quality | No server-side gap detection for block-load intervals and no expected-OBIS checklist per meter type; missing values just disappear from the UI. | Incomplete data is not flagged. | `dlms_server/src/meters.js`, `public/js/views/meter-history.js` | Compute expected rows from capture period and flag gaps; flag readings missing core OBIS codes. |
| 13 | Low | Data quality | When a register scaler cannot be read after 3 tries the value is uploaded unscaled and without unit, indistinguishable from scaled values. | Wrong magnitudes on dashboards (e.g. Wh shown where kWh expected). | `firmware/firmware.ino` L1290-1326, L1397-1411 | Send a flag (e.g. `"raw":true`) or omit the value. |
| 14 | Low | Firmware | `s_byEntry` remembers the "use selective access by entry" fallback per profile **kind**, so one event log that needs it switches all event logs. | Slightly larger reads than necessary (Inferred). | `firmware/profiles.ino` L1006-1008 | Key the fallback by OBIS. |
| 15 | Low | Firmware | Marker RAM cache holds `PG_MARK_MAX` = 12 profiles; more marked profiles fall back to NVS each cycle and may re-send rows (server dedupes). | Extra traffic only. | `reading_upload.ino` L288-330 | Size from the association view. |
| 16 | Low | Backend | `dlms_server` sessions are in memory; restart signs users out. Single shared viewer account. | Operability. | `dlms_server/src/http-server.js` L114 | Reuse the OTA server's user/session model. |
| 17 | Low | Backend scalability | Synchronous SQLite writes on the event loop; no batching. | Latency spikes at scale (Inferred). | `dlms_server/src/db.js` | Acceptable now; consider a worker thread or Postgres for > 1 000 devices. |
| 18 | Low | Testing | No firmware unit tests; protocol compatibility between firmware and servers is only checked by the JS message builder (`message.js`). | Regressions in framing/signature surface found late. | `dlms_server/test`, `firmware/` | Add golden-message tests generated from the firmware formats; host-compile `reading_upload`/`profiles` logic. |
| 19 | Low | Dead code | EEPROM helpers, optical-head Mode-E path, `com_readProfileGenerics`/`com_readValues`, invocation-counter path are unused with the current configuration. | Maintenance noise. | `firmware/firmware.ino` L140-161, L477-547, L924-1077 | Remove or guard. |

## Assessment by topic

| Topic | Rating | Notes |
|---|---|---|
| Modularity | Good | Clear per-concern `.ino` tabs; shared globals (`g_cfg`, `g_ota`, `Client`) couple them. |
| Firmware state management | Fair | Single cooperative loop, explicit flags; no state machine for modem; long blocking sections. |
| Communication reliability | Good | Acked uploads, idempotent server, bounded timeouts, APN fallback, PWRKEY recovery. |
| DLMS completeness | Good for reading | GET with selective access, block transfer, scaler profiles, vendor quirks (Avon, L&T, Genus, Secure). No SET/ACTION, no HLS. |
| Data completeness | Fair | Profile catch-up via markers is solid; register values lost on reset; no gap detection. |
| Memory / buffer safety | Good | Bounded line buffers, size checks before copies, PSRAM fallback; `frameData` grows unbounded within the 50 s deadline only. |
| Retry / reconnect | Good | Every path has a bound; restart only for a silent modem. |
| Security | Fair | Strong key handling and signed offers; no TLS, unsigned data accepted by default, secrets in source. |
| OTA robustness | Fair | Safe write path; no rollback, no resume, no watchdog during download. |
| Database design | Good | Normalised readings, idempotent keys, migrations; no backups. |
| Backend scalability | Adequate for a small fleet | Synchronous SQLite, single process. |
| Dashboard data quality | Fair | Clear status/issues; missing-value handling is silent. |
| Logging / diagnostics | Good | Device trace uploaded every cycle with drop counts and reset reasons; OTA events audited. |

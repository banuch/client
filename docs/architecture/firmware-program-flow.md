# Firmware program flow

Firmware: `firmware/` (Arduino sketch for ESP32-S3, `FW_VERSION` 2.0.12). All work runs in
the Arduino `loop()` task; every call is blocking. BLE callbacks only set flags that
`loop()` consumes.

| Diagram | What it shows |
|---|---|
| [02 Firmware architecture](diagrams/02-firmware-architecture.svg) | Modules and call dependencies |
| [03 Program flow](diagrams/03-firmware-program-flow.svg) | Power-on → `setup()` → `loop()` |
| [04 DLMS reading](diagrams/04-dlms-reading-flow.svg) | One read cycle, request by request |
| [09 Hardware interface](diagrams/09-hardware-interface.svg) | Pins and peripherals |
| [10 Error recovery](diagrams/10-error-recovery.svg) | Faults and what the code does |

## Boot (`setup()`, `firmware.ino` L1635)

1. USB CDC trace at 115200, waits at most 3 s; 256 KB PSRAM trace ring.
2. DLMS client: LN referencing, client address 32, server logical 1, LLS, HDLC
   (max info 1024, window 1). UART1 9600 8N1.
3. `cfg_load()` — NVS values or defaults. There is **no "config invalid" failure path**:
   each bad value is silently replaced by its default.
4. Meter password list (`mpw_begin`), BLE services, advertising.
5. Firmware version, running partition and reset reason are printed (and later uploaded).
6. Modem: PWRKEY pulse, UART2, 5 s boot wait, AT init, APN selection, PDP. Failure only
   clears `modemReady`; boot continues.
7. If the modem is up, report the result of a pending OTA (`ota_reportBootResult`).
8. Random boot id for message de-duplication; one-time marker epoch reset; first OTA check
   in 5 s.

There is no "hardware initialised?" check for UART1/UART2: `begin()` results are not tested.

## Main loop (`loop()`, L1728)

1. Commands from USB and BLE, BLE interval changes (`cfg_set`).
2. Decide the cycle: first run or BLE "read" → everything; else `sched_due()`.
3. Read cycle: `com_readAllObjects` → `com_close` (DISC) → `rd_end` (queue, also when
   the cycle failed) → `sched_done`.
4. `lb_upload()` — push queued readings and trace.
5. If due and not busy, `ota_run()` (may reboot into a new image).

## Read cycle (`com_readAllObjects`, L1530)

| Step | Code | Retry / limit |
|---|---|---|
| Association | `com_initializeConnection` L550 | 3 attempts, DISC + 1.5 s between |
| Wrong password | `mpw_search` (`meter_password.ino` L291) | every other password once; at most every 6 h unless forced |
| Object list (first cycle after boot) | `av_read` L1230 | failure aborts the cycle |
| Scalers | `av_readScalers` L1290 | 3 tries per register over cycles |
| Meter clock | `pg_readClock` (`profiles.ino` L1125) | drives the scheduler |
| Values | `av_readValues` L1469 | stops on link error |
| Profiles | `pg_readCycle` L1148 | range → entry fallback; ≤ 400 rows; catch-up ≤ 7 days |

Per request (`readDLMSPacket` L310): 10 s per frame, 3 resends, 50 s hard deadline;
`com_readDataBlock` follows HDLC segmentation / block transfer with ReceiverReady.

### Block Load Profile and its scaler profile

`1.0.99.1.0.255` (Block Load) rows are scaled using, in order: the register's own
scaler (attribute 3, read for the association view) → the same quantity's tariff
register → the Block Load Scalar Profile `1.0.94.91.4.255` (one row of `{scaler, unit}`
per column). Rows are read by date range from the newest row already sent (NVS marker
`m1_0_99_1_0`) to now + one period, or by entry when the meter refuses the range. Empty
clock cells are rebuilt from the previous row plus the capture period. See
[F05](function-flows/F05-pg_readProfile.svg) and [F06](function-flows/F06-pg_collect.svg).

## Scheduling (`schedule.ino`)

Intervals that divide a day are aligned to the **meter clock** (e.g. 30 min → hh:01:00 and
hh:31:00, i.e. the boundary plus `SCHED_DELAY_S` = 60 s). Until the clock has been read once, plain uptime
timers are used. The daily load profile rides on the first cycle of a new day and is
retried on the next cycle if it failed.

## Function-level flowcharts

| Function | File : line | Purpose | Returns | Diagram |
|---|---|---|---|---|
| `setup()` | `firmware.ino:1635` | boot initialisation | — | [F01](function-flows/F01-setup.svg) |
| `loop()` | `firmware.ino:1728` | main cycle | — | [F02](function-flows/F02-loop.svg) |
| `com_readAllObjects(ic, flags)` | `firmware.ino:1530` | one meter session | 0 / DLMS error | [F03](function-flows/F03-com_readAllObjects.svg) |
| `readDLMSPacket(data, reply)` / `com_readDataBlock` | `firmware.ino:310` / `:380` | frame exchange with resend | 0 / error | [F04](function-flows/F04-readDLMSPacket.svg) |
| `pg_readProfile(...)` | `profiles.ino:938` | read one profile generic | link error or 0 | [F05](function-flows/F05-pg_readProfile.svg) |
| `pg_collect(...)` | `profiles.ino:746` | select rows, advance marker | rows queued | [F06](function-flows/F06-pg_collect.svg) |
| `lb_upload()` | `log_bridge.ino:225` | push readings + trace | — | [F07](function-flows/F07-lb_upload.svg) |
| `modem_ensure()` | `modem.ino:342` | modem health, recovery | bool | [F08](function-flows/F08-modem_ensure.svg) |
| `ota_run()` | `ota_client.ino:293` | OTA state machine | — (may reboot) | [F09](function-flows/F09-ota_run.svg) |
| `ota_download(offer, detail)` | `ota_client.ino:185` | stream to OTA slot | "" / failure status | [F10](function-flows/F10-ota_download.svg) |
| `reg_run()` | `register.ino:182` | obtain device key | 0 / seconds to wait | [F11](function-flows/F11-reg_run.svg) |
| `handle()` + `saveReading` | `dlms_server/src/tcp-server.js:31`, `db.js:210` | server side of a message | reply object | [F12](function-flows/F12-dlms_server_handle.svg) |

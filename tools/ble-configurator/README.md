# BLE configurator

One HTML page (`index.html`) that an installer opens in Chrome or Edge (desktop or Android) to
commission and troubleshoot an AMR device over Bluetooth. No server, no install, no build.

* Open `index.html` from `file://` or `http://localhost` (Web Bluetooth needs a secure context).
* `index.html?demo` runs the same page against a simulated device — for training and for
  testing the page without hardware.

## Goals

Each goal names the firmware feature it relies on. The page does nothing the firmware cannot do;
where the firmware has a limit, the page shows it instead of hiding it.

| # | Goal | Firmware it uses |
|---|---|---|
| G1 | **Find and identify the device**: name, firmware version, IMEI, running partition. | Advertised name `DLMS-Meter-XXXX` and meter service UUID (`ble_meter.cpp` `ble_begin`, `ble_startAdvertising`); `GET_STATUS` (`commands.ino` `cmd_status`) |
| G2 | **Answer "is this installation working?" in one screen**: a checklist for device key, modem, APN, meter link, meter password, meter clock, last reading and OTA — each with pass / attention / fail and what to do next. | `GET_STATUS` lines; meter status characteristic (`state`, `ret`, `age`); DLMS return codes (`firmware/include/errorcodes.h`) |
| G3 | **Read the meter on site** and show every value it returned, with the key electrical values on top. | Meter service `{"cmd":"read"}` / `{"cmd":"get"}`, data characteristic JSON lines (`ble_meter.h`) |
| G4 | **Change the settings an installer is allowed to change**, checked with the firmware's own rules before sending: read and profile intervals, APN (auto or fixed), OTA server and check interval, device key. | `{"cmd":"interval"}`, `{"cmd":"profile"}` (meter service); `SET` (`commands.ino`, rules in `nvs_config.ino` `cfg_set`) |
| G5 | **Fix a meter that refuses the password**: list (masked), add, delete, detect. | `METER_PW LIST/ADD/DEL/CLEAR/DETECT` (`meter_password.ino`) |
| G6 | **Maintenance**: OTA check now, reboot. | `CHECK_OTA`, `REBOOT` |
| G7 | **Leave a record**: download a commissioning report (status, checklist, readings) and the session log. | — (page only) |
| G8 | **Never leak secrets**: the device key and meter passwords are masked in the log and the report and are never stored by the page. | Firmware masks them too (`commands.ino`, `mpw_mask`) |

## Firmware behaviour the page has to respect

* **One command at a time.** The command service keeps one pending line and ignores writes until
  `loop()` has handled it (`ota_ble.ino` `BleRxCb`). The page queues commands and sends the next only
  after the device answered. Commands longer than 200 bytes are cut by the device; the page refuses them.
* **The device is single-threaded.** While it reads the meter, uploads, or downloads an OTA image,
  BLE commands wait (`firmware.ino` `loop`). A read cycle plus upload can take minutes. The page shows
  "waiting for the device" and keeps waiting up to 3 minutes instead of sending more commands.
* **No end-of-reply marker.** Command replies are plain lines in 180-byte notifications. A reply is
  taken as complete 0.8 s after the last notification.
* **Auth over BLE.** Once a device has its key, `SET` and `METER_PW ADD/DEL/CLEAR/DETECT` need
  `auth=<device key>`. The BLE link is **not encrypted**, so the key can be overheard nearby
  (audit finding F4). The page says so next to the key field. Interval changes on the meter service
  need no key.
* **"Read meter now" also retries the password list** when the meter refuses the saved password
  (`mpw_forceSearch`). Repeated wrong passwords can lock some meters' ports, so the page asks before
  a second read within a minute.
* **Serial-only commands** (`RESET_MARKS`) are refused over BLE; the page does not offer them.
* **APN status** (`apn_use`, `apn_from`, `operator`, `sim`) exists from FW 2.0.12. On older firmware
  the page shows the configured APN only.

## Not goals

* Firmware upload over BLE (the firmware has no BLE OTA transfer; OTA is over LTE from `ota_server`).
* Viewing profiles or history — that is the dashboard's job (`dlms_server`).
* Approving devices — done on the OTA dashboard; the page shows the IMEI and key fingerprint to
  compare there.

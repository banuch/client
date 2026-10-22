// =============================================================================
//  config.h  --  connectivity and OTA build-time configuration
//
//  Meter settings stay in client.ino. This file holds what the EC200U is used
//  for: the log upload (log_bridge.ino) and device-specific OTA updates
//  (ota_client.ino, register.ino).
//
//  Runtime values (OTA server host/port, device key, interval, APN) live in NVS
//  and are set over serial or BLE -- see commands.ino. The defaults below are
//  only used until NVS holds a value.
// =============================================================================
#pragma once
#include <Arduino.h>
#include "trace_tee.h"

// ── Firmware identity ───────────────────────────────────────────────────────
#define FW_VERSION "2.0.1" // MAJOR.MINOR.PATCH -- bump before each release

// ── Debug output ────────────────────────────────────────────────────────────
// OTA results go through the trace tee, so they also reach the data server.
// Raw AT and HTTP traffic is printed on USB only, like the log bridge did.
#define DEBUG_SERIAL TraceLog
#define MODEM_DEBUG Serial

// ── EC200U modem (UART2) ────────────────────────────────────────────────────
#define MODEM Serial2
#define MODEM_TX_PIN 17
#define MODEM_RX_PIN 18
#define MODEM_WAKE_PIN 10
// UART rate between ESP32 and EC200U. 9600 is ~1 KB/s: a 1.5 MB image then
// takes ~25 min. If the module is set to 115200 (AT+IPR=115200;&W) change
// this to 115200 for ~10x faster downloads.
#define MODEM_BAUD 9600
#define MODEM_RX_BUFFER 4096
#define MODEM_QUIET_WINDOW_MS 1500UL
#define OTA_CONNECT_ID 0 // QIOPEN connect id, shared by OTA and the log upload
// EC200U AT+CCLK? returns UTC time plus an informational tz field (see
// modem_epochSeconds()). 0 = treat the time as local and subtract tz.
#define MODEM_CCLK_IS_UTC 1

// ── Data upload (reading_upload.ino, log_bridge.ino) ────────────────────────
// After each read cycle the meter values and everything printed on the USB
// serial port are sent to the data server (client/server, its TCP_PORT).
// "" = upload off.
#define DATA_SERVER_HOST ""               // e.g. "65.20.77.137"
#define DATA_SERVER_PORT 5100
#define LOG_DEVICE_ID ""                  // "" = IMEI (ESP-<MAC> until it is read)
#define LOG_UPLOAD_MAX (128UL * 1024UL)   // most log bytes sent per cycle

// ── OTA server / timing defaults (NVS overrides) ────────────────────────────
#define OTA_HOST_DEFAULT "65.20.77.137"
#define OTA_PORT_DEFAULT 3000
#define APN_DEFAULT "airtelgprs.com"
#define CHECK_INTERVAL_DEFAULT_S 86400UL // 24 h; the server may override per device
#define CHECK_INTERVAL_MIN_S 300UL
#define CHECK_RETRY_S 900UL        // after a failed check / download
#define BOOT_CHECK_DELAY_MS 5000UL // after the modem attaches

// ── Automatic registration (register.ino) ───────────────────────────────────
// The OTA server's registration public key. Get this line from the server:
//   cd server && npm run pubkey
// Empty = automatic registration off; provision with SET secret=... instead.
#define SERVER_REG_PUBKEY_HEX "048b2d915fa60116e353eb5bd63d13d06c02224aa181ad5452449e853bc0a8f3b8c92a48ac827cb53b0b4dd616687b3aef590635c5e3c16a257d00698f69913f32"

#define REGISTER_POLL_S 600UL // while waiting for approval (server may say otherwise)

// ── Transfer limits ─────────────────────────────────────────────────────────
#define OTA_CHUNK_SIZE 1024          // AT+QIRD request size
#define HTTP_JSON_MAX 2048           // largest JSON reply we accept
#define HTTP_IDLE_TIMEOUT_MS 30000UL // no bytes for this long -> abort
#define OTA_MIN_FW_SIZE 65536UL

// ── NVS ─────────────────────────────────────────────────────────────────────
#define NVS_NAMESPACE "otacfg"
#define K_HOST "host"
#define K_PORT "port"
#define K_SECRET "secret" // 64-char hex device key
#define K_INTERVAL "interval"
#define K_APN "apn"
#define K_PENDING_VER "pend_ver" // set before reboot into a new image
#define K_REG_KEY "reg_key"      // registration key pair (32 priv + 65 pub), until a key arrives

// ── BLE OTA command service (Nordic UART style, ota_ble.ino) ────────────────
// A second service on the same BLE server as the meter service (ble_meter.h).
#define OTA_BLE_ENABLE 1
#define OTA_BLE_SERVICE_UUID "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define OTA_BLE_RX_UUID "6e400002-b5a3-f393-e0a9-e50e24dcca9e" // phone -> device (write)
#define OTA_BLE_TX_UUID "6e400003-b5a3-f393-e0a9-e50e24dcca9e" // device -> phone (notify)

// ── Shared state (defined in the .ino files) ────────────────────────────────
// One queued READING body (reading_upload.ino). Declared here so the
// Arduino-generated prototypes can use it.
struct RdItem
{
    uint32_t seq;
    uint32_t readMs;
    char* body;
    size_t len;
};

struct DeviceConfig
{
    String host;
    uint16_t port;
    String secret; // device key, 64 hex chars ("" = not provisioned)
    uint32_t intervalS;
    String apn;
};
extern DeviceConfig g_cfg;

struct OtaOffer
{
    bool available = false;
    String version;
    uint32_t size = 0;
    String md5;
    String token;
    uint32_t intervalS = 0;
    String reason;
};

struct OtaState
{
    String imei;
    bool modemReady = false;
    String lastResult = "never_checked";
    String lastOfferVer;
    uint32_t lastCheckMs = 0;
    uint32_t nextCheckMs = 0;
    bool checkRequested = false;
    bool busy = false;
};
extern OtaState g_ota;

// Command source -- BLE gets a restricted command set (see commands.ino).
enum CmdSource
{
    CMD_SERIAL,
    CMD_BLE
};

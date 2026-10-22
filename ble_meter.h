// =============================================================================
//  ble_meter.h  --  BLE GATT interface between the DLMS client and the
//                   mobile app (meter_app).
//
//  Service  4fafc201-1fb5-459e-8fcc-c5c9c331914b
//    command  beb5483e-36e1-4688-b7f5-ea07361b26a8  Write
//             {"cmd":"read"}             read the meter now and stream values
//             {"cmd":"get"}              stream the last cached reading
//             {"cmd":"status"}           notify the current status
//             {"cmd":"interval","s":300} auto-read interval in seconds (RAM only)
//    data     beb5483e-36e1-4688-b7f5-ea07361b26a9  Notify
//             Newline-terminated JSON lines, split into MTU sized chunks:
//             {"t":"begin","src":"meter"|"cache"}
//             {"t":"r","obis":"1.0.1.8.0.255","name":"...","v":12.3,"u":"kWh"}
//             {"t":"r","obis":"0.0.96.1.0.255","name":"...","s":"text"}
//             {"t":"end","ret":0,"n":42}
//    status   beb5483e-36e1-4688-b7f5-ea07361b26aa  Read + Notify
//             {"t":"status","state":"idle"|"reading"|"error","ret":0,
//              "n":42,"age":12,"interval":300}
//
//  BLE callbacks only set flags. All meter and BLE data work runs in loop().
// =============================================================================
#ifndef BLE_METER_H
#define BLE_METER_H

#include <Arduino.h>

#define BLE_SERVICE_UUID  "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define BLE_COMMAND_UUID  "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define BLE_DATA_UUID     "beb5483e-36e1-4688-b7f5-ea07361b26a9"
#define BLE_STATUS_UUID   "beb5483e-36e1-4688-b7f5-ea07361b26aa"

class BLEServer;

// Create the BLE server and the meter service as "DLMS-Meter-XXXX" (last 2
// MAC bytes). Other services (ota_ble.ino) are added to ble_server() before
// ble_startAdvertising() is called.
void ble_begin(uint32_t readIntervalMs);
void ble_startAdvertising();
BLEServer* ble_server();
bool ble_isConnected();

// Call every loop(): restarts advertising after a disconnect, answers
// "get" and "status" requests.
void ble_poll();

// True once after the app sent {"cmd":"read"}.
bool ble_takeReadRequest();

// Auto-read interval, can be changed from the app.
uint32_t ble_readIntervalMs();

// A meter reading cycle: begin, one add per value, end.
void ble_readingBegin();
void ble_readingAddNumber(const char* obis, const char* name, double value, const char* unit);
void ble_readingAddText(const char* obis, const char* name, const char* text);
void ble_readingEnd(int ret);

#endif // BLE_METER_H

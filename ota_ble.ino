// =============================================================================
//  ota_ble.ino  --  BLE OTA command channel (Nordic-UART-style service)
//
//  A second service on the meter's BLE server (ble_meter.cpp owns the server,
//  the connection state and advertising). Write a command line to RX
//  (6e400002...), responses arrive as notifications on TX (6e400003...).
//  Any BLE UART app (nRF Connect, Serial Bluetooth Terminal) works. Commands
//  are queued here and executed from loop(), never inside the BLE callback.
//  See commands.ino for the BLE-specific restrictions.
// =============================================================================
#if OTA_BLE_ENABLE
#include <BLEDevice.h>
#include <BLEServer.h>
#include "ble_meter.h"

static BLECharacteristic* s_bleTx = nullptr;
static String             s_bleCmd;
static volatile bool      s_bleCmdReady = false;

// Print sink that buffers a response and sends it as notifications.
class BlePrint : public Print {
public:
    String buf;
    size_t write(uint8_t c) override { buf += (char)c; return 1; }
    void flush() override {
        if (!s_bleTx || !ble_isConnected()) { buf = ""; return; }
        for (size_t off = 0; off < buf.length(); off += 180) {
            String part = buf.substring(off, min(buf.length(), off + 180));
            s_bleTx->setValue((uint8_t*)part.c_str(), part.length());
            s_bleTx->notify();
            delay(20);
        }
        buf = "";
    }
};

class BleRxCb : public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic* c) override {
        if (s_bleCmdReady) return;   // previous command still pending
        String v = c->getValue();
        if (v.length() > 200) v = v.substring(0, 200);
        s_bleCmd = v;
        s_bleCmdReady = true;
    }
};

// Call after ble_begin() and before ble_startAdvertising().
void otaBle_init() {
    BLEServer* srv = ble_server();
    if (!srv) return;
    BLEService* svc = srv->createService(OTA_BLE_SERVICE_UUID);
    s_bleTx = svc->createCharacteristic(OTA_BLE_TX_UUID, BLECharacteristic::PROPERTY_NOTIFY);
    // CCCD (0x2902) is added automatically by the NimBLE backend for NOTIFY.
    BLECharacteristic* rx = svc->createCharacteristic(
        OTA_BLE_RX_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
    rx->setCallbacks(new BleRxCb());
    svc->start();
    DEBUG_SERIAL.println("[BLE] OTA command service ready");
}

void otaBle_poll() {
    if (!s_bleCmdReady) return;
    String cmd = s_bleCmd;
    s_bleCmdReady = false;
    BlePrint out;
    cmd_handle(cmd, CMD_BLE, out);
    out.flush();
}
#else
void otaBle_init() {}
void otaBle_poll() {}
#endif

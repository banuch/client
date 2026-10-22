// =============================================================================
//  ble_meter.cpp  --  BLE GATT interface. See ble_meter.h for the protocol.
// =============================================================================
#include "ble_meter.h"
#include "trace_tee.h"
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLE2902.h>
#include <esp_mac.h>
#include <vector>

// Smallest auto-read interval the app may set.
#define BLE_MIN_INTERVAL_S   30
// Pause between notifications so the BLE stack queue does not overflow.
#define BLE_NOTIFY_GAP_MS    8
// Longest JSON line (name + text value + keys).
#define BLE_LINE_SIZE        200

typedef struct
{
  char obis[24];
  char name[40];
  bool numeric;
  double value;
  char unit[8];
  char text[64];
} BleReading;

static BLEServer* g_server = NULL;
static BLECharacteristic* g_data = NULL;
static BLECharacteristic* g_status = NULL;

// Set from BLE callbacks (BLE task), consumed in loop().
static volatile bool g_connected = false;
static volatile bool g_wasConnected = false;
static volatile bool g_readRequest = false;
static volatile bool g_getRequest = false;
static volatile bool g_statusRequest = false;
static volatile uint32_t g_intervalMs = 300000UL;

// Last complete reading. Only used from loop().
static std::vector<BleReading> g_cache;
static std::vector<BleReading> g_pending;
static int g_lastRet = 0;
static uint32_t g_lastReadMs = 0;
static bool g_hasReading = false;
static bool g_reading = false;

//---------------------------------------------------------------------------
// Helpers
//---------------------------------------------------------------------------

// Copy a string into a JSON string literal (with quotes), escaping as needed.
static size_t jsonString(char* out, size_t size, const char* str)
{
  size_t pos = 0;
  if (size < 3)
  {
    return 0;
  }
  out[pos++] = '"';
  for (; *str != 0 && pos + 3 < size; ++str)
  {
    char c = *str;
    if (c == '"' || c == '\\')
    {
      out[pos++] = '\\';
      out[pos++] = c;
    }
    else if ((unsigned char)c < 0x20)
    {
      out[pos++] = ' ';
    }
    else
    {
      out[pos++] = c;
    }
  }
  out[pos++] = '"';
  out[pos] = 0;
  return pos;
}

// Send one line on the data characteristic, split to the negotiated MTU.
static void sendLine(const char* line)
{
  if (!g_connected || g_data == NULL)
  {
    return;
  }
  uint16_t mtu = g_server->getPeerMTU(g_server->getConnId());
  size_t chunk = (mtu > 23 ? mtu : 23) - 3;
  size_t len = strlen(line);
  for (size_t pos = 0; pos < len; pos += chunk)
  {
    size_t n = len - pos < chunk ? len - pos : chunk;
    g_data->setValue((uint8_t*)(line + pos), n);
    g_data->notify();
    delay(BLE_NOTIFY_GAP_MS);
  }
}

static void sendReading(const BleReading* r)
{
  char line[BLE_LINE_SIZE + 64];
  char obis[32], name[48], text[80];
  jsonString(obis, sizeof(obis), r->obis);
  jsonString(name, sizeof(name), r->name);
  if (r->numeric)
  {
    jsonString(text, sizeof(text), r->unit);
    snprintf(line, sizeof(line), "{\"t\":\"r\",\"obis\":%s,\"name\":%s,\"v\":%.4f,\"u\":%s}\n",
             obis, name, r->value, text);
  }
  else
  {
    jsonString(text, sizeof(text), r->text);
    snprintf(line, sizeof(line), "{\"t\":\"r\",\"obis\":%s,\"name\":%s,\"s\":%s}\n",
             obis, name, text);
  }
  sendLine(line);
}

static void sendBegin(const char* src)
{
  char line[48];
  snprintf(line, sizeof(line), "{\"t\":\"begin\",\"src\":\"%s\"}\n", src);
  sendLine(line);
}

static void sendEnd(int ret, size_t count)
{
  char line[48];
  snprintf(line, sizeof(line), "{\"t\":\"end\",\"ret\":%d,\"n\":%u}\n", ret, (unsigned)count);
  sendLine(line);
}

// Update the status characteristic and notify it.
static void publishStatus()
{
  if (g_status == NULL)
  {
    return;
  }
  const char* state = g_reading ? "reading" : (g_lastRet != 0 ? "error" : "idle");
  long age = g_hasReading ? (long)((millis() - g_lastReadMs) / 1000) : -1;
  char line[128];
  snprintf(line, sizeof(line),
           "{\"t\":\"status\",\"state\":\"%s\",\"ret\":%d,\"n\":%u,\"age\":%ld,\"interval\":%lu}",
           state, g_lastRet, (unsigned)g_cache.size(), age, (unsigned long)(g_intervalMs / 1000));
  g_status->setValue((uint8_t*)line, strlen(line));
  if (g_connected)
  {
    g_status->notify();
  }
}

//---------------------------------------------------------------------------
// BLE callbacks
//---------------------------------------------------------------------------

class ServerCallbacks : public BLEServerCallbacks
{
  void onConnect(BLEServer* server) override
  {
    g_connected = true;
    g_wasConnected = true;
  }
  void onDisconnect(BLEServer* server) override
  {
    g_connected = false;
  }
};

class CommandCallbacks : public BLECharacteristicCallbacks
{
  void onWrite(BLECharacteristic* characteristic) override
  {
    String cmd = characteristic->getValue();
    if (cmd.indexOf("\"read\"") >= 0)
    {
      g_readRequest = true;
    }
    else if (cmd.indexOf("\"get\"") >= 0)
    {
      g_getRequest = true;
    }
    else if (cmd.indexOf("\"status\"") >= 0)
    {
      g_statusRequest = true;
    }
    else if (cmd.indexOf("\"interval\"") >= 0)
    {
      int pos = cmd.indexOf("\"s\":");
      if (pos >= 0)
      {
        long s = cmd.substring(pos + 4).toInt();
        if (s >= BLE_MIN_INTERVAL_S)
        {
          g_intervalMs = (uint32_t)s * 1000UL;
        }
      }
      g_statusRequest = true;
    }
  }
};

//---------------------------------------------------------------------------
// Public API
//---------------------------------------------------------------------------

void ble_begin(uint32_t readIntervalMs)
{
  g_intervalMs = readIntervalMs;
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_BT);
  char name[24];
  snprintf(name, sizeof(name), "DLMS-Meter-%02X%02X", mac[4], mac[5]);

  BLEDevice::init(name);
  BLEDevice::setMTU(247);
  g_server = BLEDevice::createServer();
  g_server->setCallbacks(new ServerCallbacks());

  BLEService* service = g_server->createService(BLE_SERVICE_UUID);
  BLECharacteristic* command = service->createCharacteristic(
    BLE_COMMAND_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  command->setCallbacks(new CommandCallbacks());

  g_data = service->createCharacteristic(BLE_DATA_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  g_data->addDescriptor(new BLE2902());

  g_status = service->createCharacteristic(
    BLE_STATUS_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  g_status->addDescriptor(new BLE2902());
  service->start();
  publishStatus();

  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(BLE_SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  TraceLog.printf("\r\nBLE advertising as %s\r\n", name);
}

void ble_poll()
{
  // Restart advertising after the app disconnected.
  if (g_wasConnected && !g_connected)
  {
    g_wasConnected = false;
    delay(200);
    BLEDevice::startAdvertising();
    TraceLog.print("\r\nBLE client disconnected, advertising again\r\n");
  }
  if (g_getRequest)
  {
    g_getRequest = false;
    sendBegin("cache");
    for (size_t pos = 0; pos != g_cache.size(); ++pos)
    {
      sendReading(&g_cache[pos]);
    }
    sendEnd(g_hasReading ? g_lastRet : -1, g_cache.size());
  }
  if (g_statusRequest)
  {
    g_statusRequest = false;
    publishStatus();
  }
}

bool ble_takeReadRequest()
{
  if (g_readRequest)
  {
    g_readRequest = false;
    return true;
  }
  return false;
}

uint32_t ble_readIntervalMs()
{
  return g_intervalMs;
}

void ble_readingBegin()
{
  g_reading = true;
  g_pending.clear();
  publishStatus();
  sendBegin("meter");
}

static BleReading* addPending(const char* obis, const char* name)
{
  g_pending.push_back(BleReading());
  BleReading* r = &g_pending.back();
  memset(r, 0, sizeof(BleReading));
  strlcpy(r->obis, obis, sizeof(r->obis));
  strlcpy(r->name, name != NULL ? name : "", sizeof(r->name));
  return r;
}

void ble_readingAddNumber(const char* obis, const char* name, double value, const char* unit)
{
  BleReading* r = addPending(obis, name);
  r->numeric = true;
  r->value = value;
  strlcpy(r->unit, unit != NULL ? unit : "", sizeof(r->unit));
  sendReading(r);
}

void ble_readingAddText(const char* obis, const char* name, const char* text)
{
  BleReading* r = addPending(obis, name);
  r->numeric = false;
  strlcpy(r->text, text != NULL ? text : "", sizeof(r->text));
  sendReading(r);
}

void ble_readingEnd(int ret)
{
  g_reading = false;
  g_lastRet = ret;
  // Keep the previous good reading if this cycle returned nothing.
  if (!g_pending.empty())
  {
    g_cache.swap(g_pending);
    g_lastReadMs = millis();
    g_hasReading = true;
  }
  g_pending.clear();
  sendEnd(ret, g_cache.size());
  publishStatus();
}

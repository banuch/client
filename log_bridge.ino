// =============================================================================
//  log_bridge.ino  --  Upload readings and the serial trace over the EC200U
//
//  After each read cycle, when the meter UART is idle, one TCP connection to
//  DATA_SERVER_HOST:DATA_SERVER_PORT (client/server) carries the queued
//  readings (reading_upload.ino), oldest first, and then the trace kept in
//  TraceLog's ring buffer (trace_tee.h). Each message is a header line plus
//  `bytes` bytes of body:
//
//    {"type":"READING","deviceId":"<IMEI>","boot":B,"seq":N,"fw":"2.0.1",
//     "ageS":A,"bytes":M,"sig":"..."}\n<M bytes of JSON>
//    {"type":"LOG","deviceId":"<IMEI>","boot":B,"seq":N,"bytes":M,
//     "dropped":D,"uptimeS":U,"sig":"..."}\n<M bytes of raw trace text>
//
//  boot is random per boot; with seq it lets the server drop a resend.
//  sig = HMAC_SHA256(device key, "<type>|<deviceId>|<boot>|<seq>|<sha256(body)>")
//  with the OTA device key (register.ino). It is left out until the device
//  has a key, or when the device id is not the IMEI (the server derives the
//  key from the IMEI).
//
//  A reading leaves the queue, and the trace leaves the ring buffer, only
//  after every chunk got SEND OK. On failure the rest goes with the next
//  cycle (same seq).
//
//  The modem is shared with OTA: power-up, AT init and the TCP socket come
//  from modem.ino. Modem traffic is printed on USB only (MODEM_DEBUG) and is
//  not captured.
// =============================================================================
#include <mbedtls/sha256.h>

#define LB_CHUNK 1024

static uint32_t g_lbSeq = 0;
static uint32_t g_lbBoot = 0;
static char g_lbDeviceId[32];

//The IMEI once the modem has been read (it matches the OTA dashboard),
//ESP-<last 3 MAC bytes> until then, or LOG_DEVICE_ID if it is set.
static const char* lb_deviceId()
{
  if (LOG_DEVICE_ID[0] != 0)
  {
    snprintf(g_lbDeviceId, sizeof(g_lbDeviceId), "%s", LOG_DEVICE_ID);
  }
  else if (g_ota.imei.length() != 0)
  {
    snprintf(g_lbDeviceId, sizeof(g_lbDeviceId), "%s", g_ota.imei.c_str());
  }
  else
  {
    uint64_t mac = ESP.getEfuseMac();
    snprintf(g_lbDeviceId, sizeof(g_lbDeviceId), "ESP-%02X%02X%02X",
             (unsigned)(mac >> 24) & 0xFF, (unsigned)(mac >> 32) & 0xFF, (unsigned)(mac >> 40) & 0xFF);
  }
  return g_lbDeviceId;
}

//Print the upload settings. Called once from setup().
void lb_begin()
{
  do
  {
    g_lbBoot = esp_random();
  } while (g_lbBoot == 0);   //0 means "no boot id" on the server
  TraceSerial.printf("\r\nData upload: device %s -> %s:%u\r\n", lb_deviceId(),
                     DATA_SERVER_HOST[0] != 0 ? DATA_SERVER_HOST : "(off)",
                     (unsigned)DATA_SERVER_PORT);
}

//",\"sig\":\"<hex>\"" for a message, or "" when it cannot be signed.
static String lb_sigField(const char* type, uint32_t seq, const uint8_t hash[32])
{
  if (g_cfg.secret.length() != 64 || g_ota.imei.length() == 0 || g_ota.imei != lb_deviceId())
  {
    return "";
  }
  String surface = String(type) + "|" + g_lbDeviceId + "|" + String(g_lbBoot) + "|" +
                   String(seq) + "|" + ota_toHex(hash, 32);
  return String(",\"sig\":\"") + ota_hmac(surface) + "\"";
}

static void lb_hashReading(const RdItem* item, uint8_t hash[32])
{
  mbedtls_sha256((const unsigned char*)item->body, item->len, hash, 0);
}

//SHA256 of the first total bytes of the trace buffer.
static void lb_hashLog(size_t total, uint8_t hash[32])
{
  mbedtls_sha256_context ctx;
  uint8_t chunk[LB_CHUNK];
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts(&ctx, 0);
  for (size_t done = 0; done < total;)
  {
    size_t len = TraceLog.peek(done, chunk, total - done < LB_CHUNK ? total - done : LB_CHUNK);
    if (len == 0)
    {
      break;
    }
    mbedtls_sha256_update(&ctx, chunk, len);
    done += len;
  }
  mbedtls_sha256_finish(&ctx, hash);
  mbedtls_sha256_free(&ctx);
}

//Send one queued reading. True on SEND OK for all of it.
static bool lb_sendReading(const RdItem* item)
{
  uint8_t hash[32];
  lb_hashReading(item, hash);
  char header[160];
  snprintf(header, sizeof(header),
                   "{\"type\":\"READING\",\"deviceId\":\"%s\",\"boot\":%lu,\"seq\":%lu,\"fw\":\"%s\","
                   "\"ageS\":%lu,\"bytes\":%u",
                   lb_deviceId(), (unsigned long)g_lbBoot, (unsigned long)item->seq, FW_VERSION,
                   (unsigned long)((millis() - item->readMs) / 1000), (unsigned)item->len);
  String line = String(header) + lb_sigField("READING", item->seq, hash) + "}\n";
  if (!modem_tcpSend((const uint8_t*)line.c_str(), line.length()))
  {
    return false;
  }
  for (size_t sent = 0; sent < item->len; sent += LB_CHUNK)
  {
    size_t len = item->len - sent < LB_CHUNK ? item->len - sent : LB_CHUNK;
    if (!modem_tcpSend((const uint8_t*)item->body + sent, len))
    {
      return false;
    }
  }
  return true;
}

//Send the first total bytes of the trace. True on SEND OK for all of it.
static bool lb_sendLog(size_t total, uint32_t dropped)
{
  uint8_t hash[32];
  lb_hashLog(total, hash);
  char header[192];
  snprintf(header, sizeof(header),
                   "{\"type\":\"LOG\",\"deviceId\":\"%s\",\"boot\":%lu,\"seq\":%lu,\"bytes\":%u,"
                   "\"dropped\":%lu,\"uptimeS\":%lu",
                   lb_deviceId(), (unsigned long)g_lbBoot, (unsigned long)g_lbSeq, (unsigned)total,
                   (unsigned long)dropped, (unsigned long)(millis() / 1000));
  String line = String(header) + lb_sigField("LOG", g_lbSeq, hash) + "}\n";
  if (!modem_tcpSend((const uint8_t*)line.c_str(), line.length()))
  {
    return false;
  }
  uint8_t chunk[LB_CHUNK];
  for (size_t sent = 0; sent < total;)
  {
    size_t len = TraceLog.peek(sent, chunk, total - sent < LB_CHUNK ? total - sent : LB_CHUNK);
    if (len == 0 || !modem_tcpSend(chunk, len))
    {
      return false;
    }
    sent += len;
  }
  return true;
}

//Upload queued readings and the captured trace. Called from loop() after
//each read cycle.
void lb_upload()
{
  if (DATA_SERVER_HOST[0] == 0)
  {
    return;
  }
  size_t total = TraceLog.pending();
  if (total == 0 && rd_waiting() == 0)
  {
    return;
  }
  if (total > LOG_UPLOAD_MAX)
  {
    total = LOG_UPLOAD_MAX;
  }
  uint32_t dropped = TraceLog.dropped();
  uint32_t start = millis();
  unsigned readings = 0;
  TraceLog.setCapture(false);
  MODEM_DEBUG.printf("\r\n[DATA] Uploading %u readings + %u log bytes, seq %lu\r\n",
                     (unsigned)rd_waiting(), (unsigned)total, (unsigned long)g_lbSeq);
  if (!g_ota.modemReady)
  {
    g_ota.modemReady = modem_init();
  }
  bool ok = g_ota.modemReady && modem_tcpOpen(DATA_SERVER_HOST, DATA_SERVER_PORT);
  if (ok)
  {
    for (RdItem* item = rd_peek(); ok && item != NULL; item = rd_peek())
    {
      ok = lb_sendReading(item);
      if (ok)
      {
        rd_pop();
        ++readings;
      }
    }
    if (ok && total != 0)
    {
      ok = lb_sendLog(total, dropped);
      if (ok)
      {
        TraceLog.consume(total);
        TraceLog.clearDropped();
        ++g_lbSeq;
      }
    }
    modem_tcpClose();
  }
  if (!ok)
  {
    //Start again from AT on the next upload or OTA check.
    g_ota.modemReady = false;
  }
  TraceLog.setCapture(true);
  //Captured, so the server sees the result of the previous upload.
  TraceSerial.printf("\r\n[DATA] Upload %s: %u readings, %u log bytes in %lu ms, %u readings waiting\r\n",
                     ok ? "OK" : "failed", readings, ok ? (unsigned)total : 0U,
                     (unsigned long)(millis() - start), (unsigned)rd_waiting());
}

// =============================================================================
//  log_bridge.ino  --  Upload the serial trace to the log server over EC200U
//
//  Everything printed through TraceSerial is kept in TraceLog's ring buffer
//  (trace_tee.h). After each read cycle, when the meter UART is idle, the
//  buffer is sent to LOG_SERVER_HOST:LOG_SERVER_PORT (server_new, log port):
//
//    {"type":"LOG","deviceId":"...","seq":N,"bytes":M,"dropped":D,"uptimeS":U}\n
//    <M bytes of raw trace text>
//
//  The buffer is cleared only after every chunk got SEND OK. On failure the
//  text stays and goes with the next cycle (same seq).
//
//  The modem is shared with OTA: power-up, AT init and the TCP socket come
//  from modem.ino. Modem traffic is printed on USB only (MODEM_DEBUG) and is
//  not captured.
// =============================================================================

#define LB_CHUNK 1024

static uint32_t g_lbSeq = 0;
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

//Print the log settings. Called once from setup().
void lb_begin()
{
  TraceSerial.printf("\r\nLog bridge: device %s -> %s:%u\r\n", lb_deviceId(),
                     LOG_SERVER_HOST[0] != 0 ? LOG_SERVER_HOST : "(off)",
                     (unsigned)LOG_SERVER_PORT);
}

//Upload the captured trace. Called from loop() after each read cycle.
void lb_upload()
{
  if (LOG_SERVER_HOST[0] == 0)
  {
    return;
  }
  size_t total = TraceLog.pending();
  if (total == 0)
  {
    return;
  }
  if (total > LOG_UPLOAD_MAX)
  {
    total = LOG_UPLOAD_MAX;
  }
  uint32_t dropped = TraceLog.dropped();
  uint32_t start = millis();
  TraceLog.setCapture(false);
  MODEM_DEBUG.printf("\r\n[LOG] Uploading %u bytes, seq %lu\r\n", (unsigned)total, (unsigned long)g_lbSeq);
  if (!g_ota.modemReady)
  {
    g_ota.modemReady = modem_init();
  }
  bool ok = g_ota.modemReady && modem_tcpOpen(LOG_SERVER_HOST, LOG_SERVER_PORT);
  if (ok)
  {
    char header[192];
    int n = snprintf(header, sizeof(header),
                     "{\"type\":\"LOG\",\"deviceId\":\"%s\",\"seq\":%lu,\"bytes\":%u,"
                     "\"dropped\":%lu,\"uptimeS\":%lu}\n",
                     lb_deviceId(), (unsigned long)g_lbSeq, (unsigned)total,
                     (unsigned long)dropped, (unsigned long)(millis() / 1000));
    ok = modem_tcpSend((const uint8_t*)header, (size_t)n);
    uint8_t chunk[LB_CHUNK];
    size_t sent = 0;
    while (ok && sent < total)
    {
      size_t len = TraceLog.peek(sent, chunk, total - sent < LB_CHUNK ? total - sent : LB_CHUNK);
      ok = len != 0 && modem_tcpSend(chunk, len);
      sent += len;
    }
    modem_tcpClose();
  }
  if (ok)
  {
    TraceLog.consume(total);
    TraceLog.clearDropped();
    ++g_lbSeq;
  }
  else
  {
    //Start again from AT on the next upload or OTA check.
    g_ota.modemReady = false;
  }
  TraceLog.setCapture(true);
  //Captured, so the server sees the result of the previous upload.
  TraceSerial.printf("\r\n[LOG] Upload %s: %u bytes in %lu ms\r\n", ok ? "OK" : "failed",
                     (unsigned)total, (unsigned long)(millis() - start));
}

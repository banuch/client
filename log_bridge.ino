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
//  text stays and goes with the next cycle (same seq). Modem traffic is
//  printed on USB only (LB_DEBUG) and is not captured.
//
//  AT sequence, QIOPEN parameters and the quiet gap before QIOPEN follow the
//  field-tested dlms_client/server_send.ino.
// =============================================================================

#define LB_DEBUG        Serial
#define LB_CHUNK        1024
#define LB_BOOT_WAIT_MS 5000UL    // EC200U start-up time after the wake pulse
#define LB_QUIET_MS     1500UL    // gap after QICLOSE before QIOPEN

HardwareSerial ModemSerial(2);

static uint32_t g_lbBeginMs = 0;
static bool g_lbReady = false;
static uint32_t g_lbSeq = 0;
static char g_lbDeviceId[32];
static char g_lbRx[512];
static size_t g_lbRxLen = 0;

//Wake the modem and open its UART. Called once from setup().
void lb_begin()
{
  if (LOG_DEVICE_ID[0] != 0)
  {
    snprintf(g_lbDeviceId, sizeof(g_lbDeviceId), "%s", LOG_DEVICE_ID);
  }
  else
  {
    uint64_t mac = ESP.getEfuseMac();
    snprintf(g_lbDeviceId, sizeof(g_lbDeviceId), "ESP-%02X%02X%02X",
             (unsigned)(mac >> 24) & 0xFF, (unsigned)(mac >> 32) & 0xFF, (unsigned)(mac >> 40) & 0xFF);
  }
  pinMode(MODEM_WAKE_PIN, OUTPUT);
  digitalWrite(MODEM_WAKE_PIN, LOW);
  delay(200);
  digitalWrite(MODEM_WAKE_PIN, HIGH);
  delay(200);
  digitalWrite(MODEM_WAKE_PIN, LOW);
  ModemSerial.setRxBufferSize(1024);
  ModemSerial.begin(MODEM_BAUD, SERIAL_8N1, MODEM_RX_PIN, MODEM_TX_PIN);
  g_lbBeginMs = millis();
  TraceSerial.printf("\r\nLog bridge: device %s -> %s:%u, APN %s\r\n", g_lbDeviceId,
                     LOG_SERVER_HOST[0] != 0 ? LOG_SERVER_HOST : "(off)",
                     (unsigned)LOG_SERVER_PORT, LOG_APN);
}

static void lb_drain()
{
  while (ModemSerial.available())
  {
    ModemSerial.read();
  }
}

//Read modem output until one of the tokens is seen. Returns the token index,
//or -1 on timeout. The text read is kept in g_lbRx (last 512 bytes).
static int lb_waitAny(const char* const* tokens, int count, uint32_t timeoutMs)
{
  g_lbRxLen = 0;
  g_lbRx[0] = 0;
  uint32_t start = millis();
  while (millis() - start < timeoutMs)
  {
    while (ModemSerial.available())
    {
      char c = (char)ModemSerial.read();
      LB_DEBUG.write(c);
      if (c == 0)
      {
        continue;
      }
      if (g_lbRxLen == sizeof(g_lbRx) - 1)
      {
        memmove(g_lbRx, g_lbRx + 256, g_lbRxLen - 256);
        g_lbRxLen -= 256;
      }
      g_lbRx[g_lbRxLen++] = c;
      g_lbRx[g_lbRxLen] = 0;
      for (int i = 0; i != count; ++i)
      {
        if (strstr(g_lbRx, tokens[i]) != NULL)
        {
          return i;
        }
      }
    }
    delay(1);
  }
  return -1;
}

//Send an AT command and wait for OK or ERROR. True on OK.
static bool lb_cmd(const char* cmd, uint32_t timeoutMs)
{
  static const char* const DONE[] = {"\r\nOK\r\n", "ERROR"};
  lb_drain();
  LB_DEBUG.printf("[AT]>> %s\r\n", cmd);
  ModemSerial.print(cmd);
  ModemSerial.print("\r\n");
  bool ok = lb_waitAny(DONE, 2, timeoutMs) == 0;
  LB_DEBUG.print("\r\n");
  return ok;
}

static bool lb_pdpActive()
{
  if (lb_cmd("AT+QIACT?", 3000) && strstr(g_lbRx, "+QIACT: 1,1") != NULL)
  {
    return true;
  }
  lb_cmd("AT+QIACT=1", 30000);
  return lb_cmd("AT+QIACT?", 3000) && strstr(g_lbRx, "+QIACT: 1,1") != NULL;
}

static bool lb_modemInit()
{
  char cmd[96];
  while (millis() - g_lbBeginMs < LB_BOOT_WAIT_MS)
  {
    delay(100);
  }
  bool alive = false;
  for (int i = 0; i != 5 && !alive; ++i)
  {
    alive = lb_cmd("AT", 1000);
  }
  if (!alive)
  {
    LB_DEBUG.print("[LOG] Modem does not answer\r\n");
    return false;
  }
  lb_cmd("ATE0", 1000);
  if (!lb_cmd("AT+CPIN?", 5000) || strstr(g_lbRx, "READY") == NULL)
  {
    LB_DEBUG.print("[LOG] SIM not ready\r\n");
    return false;
  }
  //Set the APN only when it differs: rewriting it detaches the modem.
  lb_cmd("AT+CGDCONT?", 2000);
  snprintf(cmd, sizeof(cmd), "+CGDCONT: 1,\"IP\",\"%s\"", LOG_APN);
  if (strstr(g_lbRx, cmd) == NULL)
  {
    snprintf(cmd, sizeof(cmd), "AT+CGDCONT=1,\"IP\",\"%s\"", LOG_APN);
    lb_cmd(cmd, 2000);
  }
  lb_cmd("AT+CSQ", 1000);
  lb_cmd("AT+CGATT=1", 10000);
  bool attached = false;
  uint32_t start = millis();
  while (!attached && millis() - start < 30000UL)
  {
    attached = lb_cmd("AT+CGATT?", 2000) && strstr(g_lbRx, "+CGATT: 1") != NULL;
    if (!attached)
    {
      delay(1000);
    }
  }
  if (!attached)
  {
    LB_DEBUG.print("[LOG] Not attached to the network\r\n");
    return false;
  }
  return lb_pdpActive();
}

static bool lb_connect()
{
  static const char* const OPEN[] = {"+QIOPEN: 0,", "ERROR"};
  static const char* const EOL[] = {"\r"};
  char cmd[128];
  lb_cmd("AT+QICLOSE=0", 3000);
  if (!lb_pdpActive())
  {
    return false;
  }
  delay(LB_QUIET_MS);
  snprintf(cmd, sizeof(cmd), "AT+QIOPEN=1,0,\"TCP\",\"%s\",%u,0,0,1",
           LOG_SERVER_HOST, (unsigned)LOG_SERVER_PORT);
  lb_drain();
  LB_DEBUG.printf("[AT]>> %s\r\n", cmd);
  ModemSerial.print(cmd);
  ModemSerial.print("\r\n");
  //OK comes at once; the result is the URC "+QIOPEN: 0,<err>\r\n" seconds
  //later. Wait for the line end so the whole error code is read.
  int err = -1;
  if (lb_waitAny(OPEN, 2, 15000) == 0 && lb_waitAny(EOL, 1, 1000) == 0)
  {
    err = atoi(g_lbRx);
  }
  LB_DEBUG.printf("\r\n[LOG] TCP open result %d\r\n", err);
  return err == 0;
}

static bool lb_send(const uint8_t* data, size_t size)
{
  static const char* const PROMPT[] = {">", "ERROR"};
  static const char* const SENT[] = {"SEND OK", "SEND FAIL", "ERROR"};
  char cmd[32];
  snprintf(cmd, sizeof(cmd), "AT+QISEND=0,%u", (unsigned)size);
  lb_drain();
  ModemSerial.print(cmd);
  ModemSerial.print("\r\n");
  if (lb_waitAny(PROMPT, 2, 5000) != 0)
  {
    return false;
  }
  ModemSerial.write(data, size);
  return lb_waitAny(SENT, 3, 15000) == 0;
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
  LB_DEBUG.printf("\r\n[LOG] Uploading %u bytes, seq %lu\r\n", (unsigned)total, (unsigned long)g_lbSeq);
  if (!g_lbReady)
  {
    g_lbReady = lb_modemInit();
  }
  bool ok = g_lbReady && lb_connect();
  if (ok)
  {
    char header[192];
    int n = snprintf(header, sizeof(header),
                     "{\"type\":\"LOG\",\"deviceId\":\"%s\",\"seq\":%lu,\"bytes\":%u,"
                     "\"dropped\":%lu,\"uptimeS\":%lu}\n",
                     g_lbDeviceId, (unsigned long)g_lbSeq, (unsigned)total,
                     (unsigned long)dropped, (unsigned long)(millis() / 1000));
    ok = lb_send((const uint8_t*)header, (size_t)n);
    uint8_t chunk[LB_CHUNK];
    size_t sent = 0;
    while (ok && sent < total)
    {
      size_t len = TraceLog.peek(sent, chunk, total - sent < LB_CHUNK ? total - sent : LB_CHUNK);
      ok = len != 0 && lb_send(chunk, len);
      sent += len;
    }
    lb_cmd("AT+QICLOSE=0", 5000);
  }
  if (ok)
  {
    TraceLog.consume(total);
    TraceLog.clearDropped();
    ++g_lbSeq;
  }
  else
  {
    //Start again from AT on the next cycle.
    g_lbReady = false;
  }
  TraceLog.setCapture(true);
  //Captured, so the server sees the result of the previous upload.
  TraceSerial.printf("\r\n[LOG] Upload %s: %u bytes in %lu ms\r\n", ok ? "OK" : "failed",
                     (unsigned)total, (unsigned long)(millis() - start));
}

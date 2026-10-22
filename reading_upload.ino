// =============================================================================
//  reading_upload.ino  --  queue each read cycle's values for the data server
//
//  client.ino reports every value next to the BLE calls (rd_begin, rd_add*,
//  rd_end). Each cycle becomes one READING body:
//
//    {"ret":0,"values":[{"obis":"1.0.1.8.0.255","name":"...","v":12.345,"u":"kWh"},
//                       {"obis":"0.0.96.1.0.255","name":"...","s":"text"}]}
//
//  Bodies wait in PSRAM until log_bridge.ino has sent them (SEND OK). At most
//  RD_QUEUE_MAX cycles are kept; when it is full the oldest is dropped.
// =============================================================================

#define RD_QUEUE_MAX 24   // 2 h at the 5-minute read interval

// RdItem (one queued body) is declared in config.h.
static RdItem g_rdQueue[RD_QUEUE_MAX];
static uint8_t g_rdHead = 0;      // oldest item
static uint8_t g_rdCount = 0;
static uint32_t g_rdSeq = 0;
static uint32_t g_rdDropped = 0;
static String g_rdBody;
static bool g_rdValues = false;   // at least one value in g_rdBody
static uint32_t g_rdReadMs = 0;

//Append a JSON string literal (with quotes).
static void rd_jsonString(const char* str)
{
  g_rdBody += '"';
  for (; str != NULL && *str != 0; ++str)
  {
    char c = *str;
    if (c == '"' || c == '\\')
    {
      g_rdBody += '\\';
      g_rdBody += c;
    }
    else if ((unsigned char)c < 0x20)
    {
      g_rdBody += ' ';
    }
    else
    {
      g_rdBody += c;
    }
  }
  g_rdBody += '"';
}

static void rd_valueStart(const char* obis, const char* name)
{
  g_rdBody += g_rdValues ? ",{\"obis\":" : "{\"obis\":";
  g_rdValues = true;
  rd_jsonString(obis);
  g_rdBody += ",\"name\":";
  rd_jsonString(name);
}

//Start of a read cycle.
void rd_begin()
{
  g_rdBody = "";
  g_rdBody.reserve(16 * 1024);
  g_rdValues = false;
  g_rdReadMs = millis();
}

void rd_addNumber(const char* obis, const char* name, double value, const char* unit)
{
  if (!isfinite(value))
  {
    return;   //Not valid in JSON.
  }
  char num[32];
  snprintf(num, sizeof(num), "%.4f", value);
  rd_valueStart(obis, name);
  g_rdBody += ",\"v\":";
  g_rdBody += num;
  g_rdBody += ",\"u\":";
  rd_jsonString(unit);
  g_rdBody += '}';
}

void rd_addText(const char* obis, const char* name, const char* text)
{
  rd_valueStart(obis, name);
  g_rdBody += ",\"s\":";
  rd_jsonString(text);
  g_rdBody += '}';
}

//End of a read cycle: queue the body. A failed cycle is queued too, so the
//server sees the error code.
void rd_end(int ret)
{
  String body = String("{\"ret\":") + ret + ",\"values\":[" + g_rdBody + "]}";
  g_rdBody = "";
  char* copy = (char*)ps_malloc(body.length());
  if (copy == NULL)
  {
    copy = (char*)malloc(body.length());
  }
  if (copy == NULL)
  {
    TraceSerial.print("\r\n[DATA] Out of memory, reading not queued\r\n");
    return;
  }
  memcpy(copy, body.c_str(), body.length());
  if (g_rdCount == RD_QUEUE_MAX)
  {
    rd_pop();
    ++g_rdDropped;
  }
  RdItem* item = &g_rdQueue[(g_rdHead + g_rdCount) % RD_QUEUE_MAX];
  item->seq = g_rdSeq++;
  item->readMs = g_rdReadMs;
  item->body = copy;
  item->len = body.length();
  ++g_rdCount;
  TraceSerial.printf("\r\n[DATA] Reading seq %lu queued: %u bytes, %u waiting%s\r\n",
                     (unsigned long)item->seq, (unsigned)item->len, (unsigned)g_rdCount,
                     g_rdDropped != 0 ? " (older ones dropped)" : "");
}

//Oldest queued reading, or NULL.
RdItem* rd_peek()
{
  return g_rdCount != 0 ? &g_rdQueue[g_rdHead] : NULL;
}

//Remove the oldest reading once it is sent.
void rd_pop()
{
  if (g_rdCount == 0)
  {
    return;
  }
  free(g_rdQueue[g_rdHead].body);
  g_rdQueue[g_rdHead].body = NULL;
  g_rdHead = (g_rdHead + 1) % RD_QUEUE_MAX;
  --g_rdCount;
}

uint8_t rd_waiting()
{
  return g_rdCount;
}

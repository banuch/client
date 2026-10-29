// =============================================================================
//  reading_upload.ino  --  queue each read cycle's values for the data server
//
//  client.ino reports every value next to the BLE calls (rd_begin, rd_add*,
//  rd_end), profiles.ino the new profile rows (rd_profile*). Each cycle
//  becomes one READING body:
//
//    {"ret":0,"values":[{"obis":"1.0.1.8.0.255","name":"...","v":12.345,"u":"kWh"},
//                       {"obis":"0.0.96.1.0.255","name":"...","s":"text"}],
//     "profiles":[{"obis":"1.0.99.1.0.255","name":"Block Load Profile",
//                  "cols":[{"obis":"0.0.1.0.0.255","name":"Clock","u":""}, ...],
//                  "rows":[{"t":"2026-10-23 10:30:00","c":["2026-10-23 10:30:00",0.42,...]},
//                          {"t":"...","c":[...],"e":"Over voltage - Occ"}]}]}
//
//  "profiles" is left out when the cycle read none. Row cells are numbers
//  (scaled, same units as the values), strings or null; t is the row's
//  timestamp (meter local time) or null, e the event name of event log rows.
//
//  Bodies wait in PSRAM until log_bridge.ino has sent them and the server
//  replied (rd_pop, or rd_reject when it refused one). At most
//  RD_QUEUE_MAX cycles are kept; when it is full the oldest is dropped.
//
//  Profile markers ("newest row sent", see profiles.ino) ride along with the
//  item and are saved to NVS when it is sent. Until then the RAM copy is
//  ahead, so the next cycle does not queue the same rows again. A dropped
//  item rolls the RAM copy back to NVS and clears the markers of the items
//  still queued: its rows are read again (the server drops duplicates).
// =============================================================================
#include <Preferences.h>

#define RD_QUEUE_MAX 48       // 12 h at the 15-minute read interval
#define PG_MARK_NVS "pgmark"  // NVS namespace of the profile markers
#define PG_EPOCH_NVS "pgmarkv"  // marker epoch (its own namespace: RESET_MARKS clears "pgmark")
//Raise to make every device forget its block / daily load markers once, on
//the first boot of the new firmware (field devices cannot get RESET_MARKS).
//1 (FW 2.0.8): rows refused by servers before 2.0.7 were marked as sent.
#define PG_MARK_EPOCH 1

// RdItem (one queued body) is declared in config.h.
static RdItem g_rdQueue[RD_QUEUE_MAX];
static uint8_t g_rdHead = 0;      // oldest item
static uint8_t g_rdCount = 0;
static uint32_t g_rdSeq = 0;
static uint32_t g_rdDropped = 0;
static String g_rdBody;
static bool g_rdValues = false;   // at least one value in g_rdBody
static uint32_t g_rdReadMs = 0;

static String g_rdProfiles;          // items of the "profiles" array
static size_t g_rdProfileStart = 0;  // g_rdProfiles length before the open profile
static uint8_t g_rdProfilePhase = 0; // 0 = none open, 1 = columns, 2 = rows
static bool g_rdFirst = true;        // no column / row in the open list yet
static bool g_rdFirstCell = true;
static uint32_t g_rdProfileRows = 0; // rows queued this cycle

static PgMark g_rdCycleMarks[PG_MARK_MAX];   // markers advanced this cycle
static uint8_t g_rdCycleMarkCount = 0;
static PgMark g_mkRam[PG_MARK_MAX];          // RAM copy, loaded from NVS on use
static uint8_t g_mkRamCount = 0;
static bool g_mkRecover = false;             // markers reset by mk_checkEpoch() this boot

//Append a JSON string literal (with quotes).
static void rd_jsonStr(String& out, const char* str)
{
  out += '"';
  for (; str != NULL && *str != 0; ++str)
  {
    char c = *str;
    if (c == '"' || c == '\\')
    {
      out += '\\';
      out += c;
    }
    else if ((unsigned char)c < 0x20)
    {
      out += ' ';
    }
    else
    {
      out += c;
    }
  }
  out += '"';
}

static void rd_jsonString(const char* str)
{
  rd_jsonStr(g_rdBody, str);
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
  g_rdProfiles = "";
  g_rdProfilePhase = 0;
  g_rdProfileRows = 0;
  g_rdCycleMarkCount = 0;
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

// ── Profile rows ────────────────────────────────────────────────────────────

//Start one profile: then rd_profileColumn() per column, then the rows.
void rd_profileBegin(const char* obis, const char* name)
{
  rd_profileCancel();
  g_rdProfileStart = g_rdProfiles.length();
  g_rdProfiles += g_rdProfileStart != 0 ? ",{\"obis\":" : "{\"obis\":";
  rd_jsonStr(g_rdProfiles, obis);
  g_rdProfiles += ",\"name\":";
  rd_jsonStr(g_rdProfiles, name);
  g_rdProfiles += ",\"cols\":[";
  g_rdProfilePhase = 1;
  g_rdFirst = true;
}

void rd_profileColumn(const char* obis, const char* name, const char* unit)
{
  g_rdProfiles += g_rdFirst ? "{\"obis\":" : ",{\"obis\":";
  g_rdFirst = false;
  rd_jsonStr(g_rdProfiles, obis);
  g_rdProfiles += ",\"name\":";
  rd_jsonStr(g_rdProfiles, name);
  g_rdProfiles += ",\"u\":";
  rd_jsonStr(g_rdProfiles, unit);
  g_rdProfiles += '}';
}

static void rd_profileRowsStart()
{
  if (g_rdProfilePhase == 1)
  {
    g_rdProfiles += "],\"rows\":[";
    g_rdProfilePhase = 2;
    g_rdFirst = true;
  }
}

//t = row timestamp text, NULL if the row has none.
void rd_profileRowBegin(const char* t)
{
  rd_profileRowsStart();
  g_rdProfiles += g_rdFirst ? "{\"t\":" : ",{\"t\":";
  g_rdFirst = false;
  if (t != NULL)
  {
    rd_jsonStr(g_rdProfiles, t);
  }
  else
  {
    g_rdProfiles += "null";
  }
  g_rdProfiles += ",\"c\":[";
  g_rdFirstCell = true;
  ++g_rdProfileRows;
}

void rd_profileCellNumber(double value)
{
  if (!g_rdFirstCell)
  {
    g_rdProfiles += ',';
  }
  g_rdFirstCell = false;
  if (!isfinite(value))
  {
    g_rdProfiles += "null";
    return;
  }
  //"%.4f" without trailing zeros: 0.4200 -> 0.42, 7.0000 -> 7.
  char num[32];
  snprintf(num, sizeof(num), "%.4f", value);
  char* end = num + strlen(num);
  while (end > num && end[-1] == '0')
  {
    --end;
  }
  if (end > num && end[-1] == '.')
  {
    --end;
  }
  *end = 0;
  g_rdProfiles += strcmp(num, "-0") == 0 ? "0" : num;
}

//NULL = missing cell (JSON null).
void rd_profileCellText(const char* text)
{
  if (!g_rdFirstCell)
  {
    g_rdProfiles += ',';
  }
  g_rdFirstCell = false;
  if (text != NULL)
  {
    rd_jsonStr(g_rdProfiles, text);
  }
  else
  {
    g_rdProfiles += "null";
  }
}

//event = event name for event log rows, else NULL.
void rd_profileRowEnd(const char* event)
{
  g_rdProfiles += ']';
  if (event != NULL)
  {
    g_rdProfiles += ",\"e\":";
    rd_jsonStr(g_rdProfiles, event);
  }
  g_rdProfiles += '}';
}

void rd_profileEnd()
{
  if (g_rdProfilePhase == 0)
  {
    return;
  }
  rd_profileRowsStart();
  g_rdProfiles += "]}";
  g_rdProfilePhase = 0;
}

//Drop the open profile (the meter stopped answering in the middle of it).
void rd_profileCancel()
{
  if (g_rdProfilePhase != 0)
  {
    g_rdProfiles.remove(g_rdProfileStart);
    g_rdProfilePhase = 0;
  }
}

// ── Profile markers ─────────────────────────────────────────────────────────

static PgMark* mk_find(PgMark* list, uint8_t count, const char* key)
{
  for (uint8_t i = 0; i != count; ++i)
  {
    if (strcmp(list[i].key, key) == 0)
    {
      return &list[i];
    }
  }
  return NULL;
}

//Newest row already queued (RAM) or sent (NVS) for a profile, 0 = none.
uint32_t mk_get(const char* key)
{
  PgMark* m = mk_find(g_mkRam, g_mkRamCount, key);
  if (m != NULL)
  {
    return m->ts;
  }
  Preferences p;
  uint32_t ts = 0;
  if (p.begin(PG_MARK_NVS, true))
  {
    ts = p.getUInt(key, 0);
    p.end();
  }
  if (g_mkRamCount != PG_MARK_MAX)
  {
    m = &g_mkRam[g_mkRamCount++];
    strlcpy(m->key, key, sizeof(m->key));
    m->ts = ts;
  }
  return ts;
}

//Rows up to ts are in this cycle's reading.
void mk_advance(const char* key, uint32_t ts)
{
  mk_get(key);
  PgMark* m = mk_find(g_mkRam, g_mkRamCount, key);
  if (m != NULL)
  {
    m->ts = ts;
  }
  m = mk_find(g_rdCycleMarks, g_rdCycleMarkCount, key);
  if (m == NULL && g_rdCycleMarkCount != PG_MARK_MAX)
  {
    m = &g_rdCycleMarks[g_rdCycleMarkCount++];
    strlcpy(m->key, key, sizeof(m->key));
  }
  if (m != NULL)
  {
    m->ts = ts;
  }
}

static void mk_commit(const RdItem* item)
{
  if (item->markCount == 0)
  {
    return;
  }
  Preferences p;
  if (!p.begin(PG_MARK_NVS, false))
  {
    return;
  }
  for (uint8_t i = 0; i != item->markCount; ++i)
  {
    p.putUInt(item->marks[i].key, item->marks[i].ts);
  }
  p.end();
}

//Forget every marker (RESET_MARKS command, e.g. after the meter was
//replaced): the next cycles send the default history again.
void mk_resetAll()
{
  Preferences p;
  if (p.begin(PG_MARK_NVS, false))
  {
    p.clear();
    p.end();
  }
  g_mkRamCount = 0;
  for (uint8_t i = 0; i != g_rdCount; ++i)
  {
    g_rdQueue[(g_rdHead + i) % RD_QUEUE_MAX].markCount = 0;
  }
}

//Called once from setup(). When the saved epoch is older than PG_MARK_EPOCH,
//forget the block and daily load markers (as RESET_MARKS would, but only
//for those two) so their rows still in the meter are read and sent again.
//The server drops rows it already has.
void mk_checkEpoch()
{
  Preferences p;
  uint32_t epoch = 0;
  if (p.begin(PG_EPOCH_NVS, true))
  {
    epoch = p.getUInt("epoch", 0);
    p.end();
  }
  if (epoch >= PG_MARK_EPOCH)
  {
    return;
  }
  static const char* KEYS[] = {"m1_0_99_1_0", "m1_0_99_2_0"};   // pg_markKey of 1.0.99.1/2.0.255
  if (p.begin(PG_MARK_NVS, false))
  {
    for (size_t i = 0; i != sizeof(KEYS) / sizeof(KEYS[0]); ++i)
    {
      p.remove(KEYS[i]);
    }
    p.end();
  }
  g_mkRamCount = 0;
  if (p.begin(PG_EPOCH_NVS, false))
  {
    p.putUInt("epoch", PG_MARK_EPOCH);
    p.end();
  }
  g_mkRecover = true;
  TraceSerial.printf("\r\n[DATA] Marker epoch %lu -> %u: block and daily load history is sent again\r\n",
                     (unsigned long)epoch, (unsigned)PG_MARK_EPOCH);
}

//True after mk_checkEpoch() reset the markers this boot: an unmarked
//profile then reads its whole catch-up range instead of the usual window.
bool mk_recovering()
{
  return g_mkRecover;
}

//End of a read cycle: queue the body. A failed cycle is queued too, so the
//server sees the error code.
void rd_end(int ret)
{
  rd_profileCancel();
  String body = String("{\"ret\":") + ret + ",\"values\":[" + g_rdBody + "]";
  g_rdBody = "";
  if (g_rdProfiles.length() != 0)
  {
    body += ",\"profiles\":[";
    body += g_rdProfiles;
    body += ']';
  }
  body += '}';
  g_rdProfiles = "";
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
  bool dropped = false;
  if (g_rdCount == RD_QUEUE_MAX)
  {
    rd_pop(false);
    ++g_rdDropped;
    dropped = true;
  }
  RdItem* item = &g_rdQueue[(g_rdHead + g_rdCount) % RD_QUEUE_MAX];
  item->seq = g_rdSeq++;
  item->readMs = g_rdReadMs;
  item->body = copy;
  item->len = body.length();
  memcpy(item->marks, g_rdCycleMarks, sizeof(PgMark) * g_rdCycleMarkCount);
  item->markCount = g_rdCycleMarkCount;
  ++g_rdCount;
  if (dropped)
  {
    //The dropped rows must be read again: back to the markers in NVS, and
    //no queued item may move them past the gap.
    for (uint8_t i = 0; i != g_rdCount; ++i)
    {
      g_rdQueue[(g_rdHead + i) % RD_QUEUE_MAX].markCount = 0;
    }
    g_mkRamCount = 0;
  }
  TraceSerial.printf("\r\n[DATA] Reading seq %lu queued: %u bytes, %lu profile rows, %u waiting%s\r\n",
                     (unsigned long)item->seq, (unsigned)item->len, (unsigned long)g_rdProfileRows,
                     (unsigned)g_rdCount, g_rdDropped != 0 ? " (older ones dropped)" : "");
}

//Oldest queued reading, or NULL.
RdItem* rd_peek()
{
  return g_rdCount != 0 ? &g_rdQueue[g_rdHead] : NULL;
}

//Remove the oldest reading. sent = the server stored it: save its markers.
void rd_pop(bool sent)
{
  if (g_rdCount == 0)
  {
    return;
  }
  if (sent)
  {
    mk_commit(&g_rdQueue[g_rdHead]);
  }
  free(g_rdQueue[g_rdHead].body);
  g_rdQueue[g_rdHead].body = NULL;
  g_rdHead = (g_rdHead + 1) % RD_QUEUE_MAX;
  --g_rdCount;
}

//The server refused the oldest reading: forget it without saving its
//markers, and roll the RAM copy back to NVS so its rows are read again.
void rd_reject()
{
  rd_pop(false);
  for (uint8_t i = 0; i != g_rdCount; ++i)
  {
    g_rdQueue[(g_rdHead + i) % RD_QUEUE_MAX].markCount = 0;
  }
  g_mkRamCount = 0;
}

uint8_t rd_waiting()
{
  return g_rdCount;
}

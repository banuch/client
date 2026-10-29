// =============================================================================
//  profiles.ino  --  Read and print every profile generic (IC 7) object
//
//  IS 15959 profiles: instantaneous snapshot, block load, daily load,
//  billing, event logs and name plate. Attribute 3 lists the columns
//  (capture objects), attribute 2 holds the rows (buffer). Each profile has
//  a scaler profile 1.0.94.91.3..7.255 whose single row holds the
//  scaler_unit of every column.
//
//  Read strategy. Avon meters ignore selective access by entry and send the
//  whole buffer (see dlms_client/assoc_view.ino), so:
//    - capture_period > 0 and a column is the clock (block load, daily
//      load): selective access by date range, from the newest row already
//      sent (marker) to now. Without a marker, and always on a full read,
//      the last PG_WINDOW_PERIODS periods, at least PG_MIN_WINDOW_S. Never
//      further back than PG_MAX_BACK_S or PG_MAX_NEW_ROWS periods.
//    - otherwise (billing, events, snapshots): plain read of the buffer,
//      skipped when entries_in_use is above PG_PLAIN_MAX_ROWS.
//
//  Which profiles a cycle reads (CYCLE_* in config.h, schedule.ino decides):
//    CYCLE_PROFILES  instantaneous, block load, billing, event logs
//    CYCLE_DAILY     daily load
//    CYCLE_FULL      all of them (also name plate and any other profile),
//                    with every row printed. Other cycles print one line
//                    per profile, so the uploaded log stays small.
//
//  Upload (reading_upload.ino, rd_profile*):
//    block load, daily load, event logs  rows newer than the profile's marker
//    billing                             the current (newest) row every time,
//                                        closed months newer than the marker
//    instantaneous, name plate, others   every row read
//  Markers ("m<a>_<b>_<c>_<d>_<e>" in NVS, mk_get/mk_advance) hold the
//  timestamp of the newest row sent, so a power cut or network outage is
//  filled in by the next cycle.
// =============================================================================

#define PG_MIN_WINDOW_S     (24UL * 3600UL)   // block load: last 24 h
#define PG_WINDOW_PERIODS   7                 // daily load: last 7 days
#define PG_MAX_BACK_S       (7UL * 86400UL)   // longest catch-up after an outage
#define PG_MAX_NEW_ROWS     400UL             // ... and at most this many periods
#define PG_RECOVER_BACK_S   (45UL * 86400UL)  // after a marker epoch reset (daily load keeps 45 days)
#define PG_PLAIN_MAX_ROWS   400
#define PG_TABLE_MAX_COLS   16
#define PG_UPLOAD_MAX_COLS  256               // dlms_server reading.js MAX_COLUMNS

static const unsigned char CLOCK_LN[6] = {0, 0, 1, 0, 0, 255};

//Days since 1970-01-01 for a civil date (proleptic Gregorian).
static int32_t daysFromCivil(int32_t y, uint32_t m, uint32_t d)
{
  y -= m <= 2;
  int32_t era = (y >= 0 ? y : y - 399) / 400;
  uint32_t yoe = (uint32_t)(y - era * 400);
  uint32_t doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
  uint32_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + (int32_t)doe - 719468;
}

static void civilFromDays(int32_t z, uint16_t* y, uint8_t* m, uint8_t* d)
{
  z += 719468;
  int32_t era = (z >= 0 ? z : z - 146096) / 146097;
  uint32_t doe = (uint32_t)(z - era * 146097);
  uint32_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  uint32_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  uint32_t mp = (5 * doy + 2) / 153;
  *d = (uint8_t)(doy - (153 * mp + 2) / 5 + 1);
  *m = (uint8_t)(mp < 10 ? mp + 3 : mp - 9);
  *y = (uint16_t)(yoe + era * 400 + (*m <= 2));
}

//DLMS date-time (12 bytes) -> seconds since 1970 in meter local time.
//Unspecified time fields count as 0. False if the date is not specified.
static bool dtToSeconds(const unsigned char* d, uint32_t* out)
{
  uint16_t year = (uint16_t)((d[0] << 8) | d[1]);
  if (year == 0xFFFF || year < 1970 || d[2] < 1 || d[2] > 12 || d[3] < 1 || d[3] > 31)
  {
    return false;
  }
  uint32_t hh = d[5] < 24 ? d[5] : 0;
  uint32_t mm = d[6] < 60 ? d[6] : 0;
  uint32_t ss = d[7] < 60 ? d[7] : 0;
  *out = (uint32_t)daysFromCivil(year, d[2], d[3]) * 86400UL + hh * 3600 + mm * 60 + ss;
  return true;
}

//Seconds since 1970 -> DLMS date-time. Deviation and clock status come from ref.
static void dtFromSeconds(uint32_t t, const unsigned char* ref, unsigned char* d)
{
  int32_t days = (int32_t)(t / 86400UL);
  uint32_t sec = t % 86400UL;
  uint16_t y;
  uint8_t m, day;
  civilFromDays(days, &y, &m, &day);
  d[0] = (unsigned char)(y >> 8);
  d[1] = (unsigned char)y;
  d[2] = m;
  d[3] = day;
  //1 = Monday. 1970-01-01 was a Thursday.
  d[4] = (unsigned char)((days + 3) % 7 + 1);
  d[5] = (unsigned char)(sec / 3600);
  d[6] = (unsigned char)((sec / 60) % 60);
  d[7] = (unsigned char)(sec % 60);
  d[8] = 0;
  d[9] = ref[9];
  d[10] = ref[10];
  d[11] = ref[11];
}

static void dtText(const unsigned char* d, char* buff, size_t size)
{
  snprintf(buff, size, "%04u-%02u-%02u %02u:%02u:%02u", (unsigned)((d[0] << 8) | d[1]),
           d[2], d[3], d[5], d[6], d[7]);
}

static bool isDateTimeCell(const dlmsVARIANT* v)
{
  return v != NULL &&
         (v->vt == DLMS_DATA_TYPE_OCTET_STRING || v->vt == DLMS_DATA_TYPE_DATETIME) &&
         v->byteArr != NULL && v->byteArr->size == 12;
}

static bool isEventCode(const unsigned char* ln)
{
  return ln[0] == 0 && ln[1] == 0 && ln[2] == 96 && ln[3] == 11 && ln[5] == 255;
}

static bool pg_isScalerProfile(const unsigned char* ln)
{
  return ln[0] == 1 && ln[1] == 0 && ln[2] == 94 && ln[3] == 91 &&
         ln[4] >= 3 && ln[4] <= 7 && ln[5] == 255;
}

//Scaler profile of a data profile (IS 15959). False if it has none.
static bool pg_scalerProfileFor(const unsigned char* ln, unsigned char* out)
{
  static const unsigned char PAIRS[][2][6] =
  {
    {{1, 0, 94, 91, 0, 255}, {1, 0, 94, 91, 3, 255}},   // instantaneous
    {{1, 0, 99, 1, 0, 255},  {1, 0, 94, 91, 4, 255}},   // block load
    {{1, 0, 99, 2, 0, 255},  {1, 0, 94, 91, 5, 255}},   // daily load
    {{1, 0, 98, 1, 0, 255},  {1, 0, 94, 91, 6, 255}},   // billing
  };
  for (size_t pos = 0; pos != sizeof(PAIRS) / sizeof(PAIRS[0]); ++pos)
  {
    if (memcmp(ln, PAIRS[pos][0], 6) == 0)
    {
      memcpy(out, PAIRS[pos][1], 6);
      return true;
    }
  }
  //Event logs 0.0.99.98.e.255 share 1.0.94.91.7.255.
  if (ln[0] == 0 && ln[1] == 0 && ln[2] == 99 && ln[3] == 98 && ln[5] == 255)
  {
    static const unsigned char EVENTS[6] = {1, 0, 94, 91, 7, 255};
    memcpy(out, EVENTS, 6);
    return true;
  }
  return false;
}

static const char* eventName(int id)
{
  for (size_t pos = 0; pos != EVENT_NAMES_SIZE; ++pos)
  {
    if (EVENT_NAMES[pos].id == id)
    {
      return EVENT_NAMES[pos].name;
    }
  }
  return "(unknown event)";
}

static void pg_printError(const char* what, int ret)
{
  if (ret == DLMS_ERROR_CODE_READ_WRITE_DENIED)
  {
    TraceSerial.printf("  %s: no access\r\n", what);
  }
  else if (ret == DLMS_ERROR_CODE_UNDEFINED_OBJECT)
  {
    TraceSerial.printf("  %s: undefined object\r\n", what);
  }
  else
  {
    TraceSerial.printf("  %s: error %d\r\n", what, ret);
  }
}

//Read attribute 3 (capture objects): array of
//structure {class_id, logical_name, attribute_index, data_index}.
static int pg_readColumns(const unsigned char* ln, PgColumn** cols, uint16_t* count)
{
  dlmsVARIANT value;
  var_init(&value);
  *cols = NULL;
  *count = 0;
  int ret = readAttribute(DLMS_OBJECT_TYPE_PROFILE_GENERIC, ln, 3, NULL, &value);
  if (ret == 0 && (value.vt != DLMS_DATA_TYPE_ARRAY || value.Arr == NULL))
  {
    ret = DLMS_ERROR_CODE_INVALID_RESPONSE;
  }
  if (ret == 0)
  {
    uint16_t size = (uint16_t)value.Arr->size;
    *cols = (PgColumn*)calloc(size != 0 ? size : 1, sizeof(PgColumn));
    if (*cols == NULL)
    {
      ret = DLMS_ERROR_CODE_OUTOFMEMORY;
    }
    for (uint16_t pos = 0; ret == 0 && pos != size; ++pos)
    {
      dlmsVARIANT *item, *classId, *name, *attr, *index;
      if (va_getByIndex(value.Arr, pos, &item) != 0 ||
          item->vt != DLMS_DATA_TYPE_STRUCTURE || item->Arr == NULL || item->Arr->size < 4 ||
          va_getByIndex(item->Arr, 0, &classId) != 0 ||
          va_getByIndex(item->Arr, 1, &name) != 0 ||
          va_getByIndex(item->Arr, 2, &attr) != 0 ||
          va_getByIndex(item->Arr, 3, &index) != 0 ||
          name->vt != DLMS_DATA_TYPE_OCTET_STRING || name->byteArr == NULL || name->byteArr->size != 6)
      {
        ret = DLMS_ERROR_CODE_INVALID_RESPONSE;
        break;
      }
      PgColumn* c = &(*cols)[(*count)++];
      c->e.classId = (uint16_t)var_toInteger(classId);
      memcpy(c->e.ln, name->byteArr->data, 6);
      c->attr = (signed char)var_toInteger(attr);
      c->dataIndex = (uint16_t)var_toInteger(index);
    }
  }
  var_clear(&value);
  if (ret != 0)
  {
    free(*cols);
    *cols = NULL;
    *count = 0;
  }
  return ret;
}

//Copy the scaler of an association view register. tariffs = also match the
//other tariff registers of the same quantity (only value group E differs).
static void pg_scalerFromAv(PgColumn* cols, uint16_t count, bool tariffs)
{
  for (uint16_t c = 0; c != count; ++c)
  {
    if (cols[c].e.scalerRead || cols[c].attr != 2 || !hasScaler(cols[c].e.classId))
    {
      continue;
    }
    const unsigned char* ln = cols[c].e.ln;
    for (uint16_t a = 0; a != g_avCount; ++a)
    {
      const unsigned char* av = g_av[a].ln;
      if (g_av[a].scalerRead &&
          (memcmp(av, ln, 6) == 0 ||
           (tariffs && memcmp(av, ln, 4) == 0 && av[5] == ln[5])))
      {
        cols[c].e.scaler = g_av[a].scaler;
        cols[c].e.unit = g_av[a].unit;
        cols[c].e.scalerRead = 1;
        break;
      }
    }
  }
}

//Attach scaler and unit to the value columns. The register's own scaler
//(attribute 3, read for the association view) wins: the Avon scaler profiles
//give MD registers a wrong scaler. Then the same quantity's other tariffs,
//then the scaler profile for columns that are not in the association view.
static int pg_applyScalers(const unsigned char* ln, PgColumn* cols, uint16_t count)
{
  int ret = 0;
  unsigned char sln[6];
  pg_scalerFromAv(cols, count, false);
  pg_scalerFromAv(cols, count, true);
  if (pg_scalerProfileFor(ln, sln))
  {
    PgColumn* scols;
    uint16_t scount;
    if ((ret = pg_readColumns(sln, &scols, &scount)) == 0)
    {
      dlmsVARIANT value;
      dlmsVARIANT *row, *su, *scaler, *unit;
      var_init(&value);
      ret = readAttribute(DLMS_OBJECT_TYPE_PROFILE_GENERIC, sln, 2, NULL, &value);
      //Buffer: one row, one structure {scaler, unit} per column.
      if (ret == 0 && value.vt == DLMS_DATA_TYPE_ARRAY && value.Arr != NULL &&
          value.Arr->size != 0 && va_getByIndex(value.Arr, 0, &row) == 0 &&
          row->vt == DLMS_DATA_TYPE_STRUCTURE && row->Arr != NULL)
      {
        for (uint16_t s = 0; s != scount && s < row->Arr->size; ++s)
        {
          if (va_getByIndex(row->Arr, s, &su) != 0 || su->vt != DLMS_DATA_TYPE_STRUCTURE ||
              su->Arr == NULL || su->Arr->size < 2 ||
              va_getByIndex(su->Arr, 0, &scaler) != 0 || va_getByIndex(su->Arr, 1, &unit) != 0)
          {
            continue;
          }
          for (uint16_t c = 0; c != count; ++c)
          {
            if (!cols[c].e.scalerRead && cols[c].attr == 2 && hasScaler(cols[c].e.classId) &&
                memcmp(cols[c].e.ln, scols[s].e.ln, 6) == 0)
            {
              cols[c].e.scaler = (signed char)var_toInteger(scaler);
              cols[c].e.unit = (unsigned char)var_toInteger(unit);
              cols[c].e.scalerRead = 1;
            }
          }
        }
      }
      var_clear(&value);
      free(scols);
    }
    if (isLinkError(ret))
    {
      return ret;
    }
    if (ret != 0)
    {
      pg_printError("Scaler profile", ret);
    }
  }
  return 0;
}

static void pg_columnName(const PgColumn* c, char* buff, size_t size)
{
  char obis[24];
  const char* name = obisName(c->e.ln);
  if (*name == 0)
  {
    obisToString(c->e.ln, obis, sizeof(obis));
    name = obis;
  }
  if (c->attr == 2)
  {
    snprintf(buff, size, "%s", name);
  }
  else if (c->e.classId == DLMS_OBJECT_TYPE_EXTENDED_REGISTER && c->attr == 5)
  {
    snprintf(buff, size, "%s time", name);
  }
  else
  {
    snprintf(buff, size, "%s (attr %d)", name, c->attr);
  }
}

static const char* pg_unit(const PgColumn* c)
{
  double dummy = 0;
  return c->e.scalerRead ? unitSymbol(c->e.unit, &dummy) : "";
}

//Format one buffer cell. Numbers are shown without the unit (the unit is
//printed with the column name). Missing cells are shown as "-".
static void pg_formatCell(const PgColumn* c, dlmsVARIANT* cell, char* buff, size_t size)
{
  double number;
  const char* unit;
  if (cell == NULL || cell->vt == DLMS_DATA_TYPE_NONE)
  {
    snprintf(buff, size, "-");
    return;
  }
  if (formatValue(&c->e, cell, buff, size, &number, &unit))
  {
    size_t len = strlen(buff);
    size_t unitLen = strlen(unit);
    if (unitLen != 0 && len > unitLen && strcmp(buff + len - unitLen, unit) == 0)
    {
      len -= unitLen;
    }
    while (len != 0 && buff[len - 1] == ' ')
    {
      --len;
    }
    buff[len] = 0;
  }
}

//Cell text of a row. Column 1 timestamps may be left empty by the meter when
//they follow from the previous row; those are rebuilt from the capture period.
static void pg_cellText(const PgColumn* cols, uint16_t c, dlmsVARIANT* row, uint32_t period,
                        const unsigned char* ref, uint32_t* prevTs, bool* havePrev,
                        char* buff, size_t size)
{
  dlmsVARIANT* v = NULL;
  if (c >= row->Arr->size || va_getByIndex(row->Arr, c, &v) != 0)
  {
    v = NULL;
  }
  if (c == 0 && cols[0].e.classId == DLMS_OBJECT_TYPE_CLOCK)
  {
    uint32_t ts;
    if (isDateTimeCell(v) && dtToSeconds(v->byteArr->data, &ts))
    {
      *prevTs = ts;
      *havePrev = true;
    }
    else if (*havePrev && period != 0)
    {
      unsigned char d[12];
      *prevTs += period;
      dtFromSeconds(*prevTs, ref, d);
      dtText(d, buff, size);
      return;
    }
  }
  pg_formatCell(&cols[c], v, buff, size);
}

static int pg_eventId(const PgColumn* cols, uint16_t count, dlmsVARIANT* row)
{
  dlmsVARIANT* v;
  for (uint16_t c = 0; c != count; ++c)
  {
    if (isEventCode(cols[c].e.ln) && c < row->Arr->size &&
        va_getByIndex(row->Arr, c, &v) == 0 && isNumeric(v->vt))
    {
      return var_toInteger(v);
    }
  }
  return -1;
}

//Print the rows. Narrow profiles as a table with a column list, wide or
//single row profiles (billing, snapshots, name plate) one value per line.
static void pg_printBuffer(const PgColumn* cols, uint16_t count, dlmsVARIANT* buffer,
                           uint32_t period, const unsigned char* ref)
{
  char cell[64];
  char name[48];
  if (buffer->vt != DLMS_DATA_TYPE_ARRAY || buffer->Arr == NULL)
  {
    TraceSerial.printf("  Buffer: unexpected data type %d\r\n", (int)buffer->vt);
    return;
  }
  uint16_t rows = (uint16_t)buffer->Arr->size;
  TraceSerial.printf("  Rows read: %u\r\n", (unsigned)rows);
  if (rows == 0 || count == 0)
  {
    return;
  }
  uint32_t prevTs = 0;
  bool havePrev = false;
  dlmsVARIANT* row;
  bool table = rows > 1 && count <= PG_TABLE_MAX_COLS;
  if (!table)
  {
    for (uint16_t r = 0; r != rows; ++r)
    {
      if (va_getByIndex(buffer->Arr, r, &row) != 0 ||
          row->vt != DLMS_DATA_TYPE_STRUCTURE || row->Arr == NULL)
      {
        continue;
      }
      TraceSerial.printf("  -- Entry %u of %u --\r\n", (unsigned)(r + 1), (unsigned)rows);
      for (uint16_t c = 0; c != count; ++c)
      {
        pg_columnName(&cols[c], name, sizeof(name));
        pg_cellText(cols, c, row, period, ref, &prevTs, &havePrev, cell, sizeof(cell));
        TraceSerial.printf("    %-28s : %s %s\r\n", name, cell, pg_unit(&cols[c]));
      }
      int id = pg_eventId(cols, count, row);
      if (id >= 0)
      {
        TraceSerial.printf("    %-28s : %s\r\n", "Event", eventName(id));
      }
    }
    return;
  }
  //Column list, then one line per row. Column widths come from the first row.
  uint8_t* width = (uint8_t*)malloc(count);
  if (width == NULL)
  {
    return;
  }
  for (uint16_t c = 0; c != count; ++c)
  {
    char obis[24];
    obisToString(cols[c].e.ln, obis, sizeof(obis));
    pg_columnName(&cols[c], name, sizeof(name));
    TraceSerial.printf("    c%-3u %-28s %-20s %s\r\n", (unsigned)(c + 1), name, obis, pg_unit(&cols[c]));
    width[c] = 4;
  }
  if (va_getByIndex(buffer->Arr, 0, &row) == 0 && row->vt == DLMS_DATA_TYPE_STRUCTURE && row->Arr != NULL)
  {
    uint32_t ts = 0;
    bool have = false;
    for (uint16_t c = 0; c != count; ++c)
    {
      pg_cellText(cols, c, row, period, ref, &ts, &have, cell, sizeof(cell));
      size_t len = strlen(cell);
      if (len > width[c])
      {
        width[c] = (uint8_t)(len < 24 ? len : 24);
      }
    }
  }
  TraceSerial.print("  #    ");
  for (uint16_t c = 0; c != count; ++c)
  {
    char label[8];
    snprintf(label, sizeof(label), "c%u", (unsigned)(c + 1));
    TraceSerial.printf("%-*s ", width[c], label);
  }
  TraceSerial.print("\r\n");
  for (uint16_t r = 0; r != rows; ++r)
  {
    if (va_getByIndex(buffer->Arr, r, &row) != 0 ||
        row->vt != DLMS_DATA_TYPE_STRUCTURE || row->Arr == NULL)
    {
      continue;
    }
    TraceSerial.printf("  %-4u ", (unsigned)(r + 1));
    for (uint16_t c = 0; c != count; ++c)
    {
      pg_cellText(cols, c, row, period, ref, &prevTs, &havePrev, cell, sizeof(cell));
      TraceSerial.printf("%-*s ", width[c], cell);
    }
    int id = pg_eventId(cols, count, row);
    if (id >= 0)
    {
      TraceSerial.printf(" %s", eventName(id));
    }
    TraceSerial.print("\r\n");
  }
  free(width);
}

//Selective access by range (selector 1): restricting object is the clock
//column, from/to are date-times, empty selected_values = all columns.
static int pg_rangeSelector(gxByteBuffer* bb, const PgColumn* clock,
                            const unsigned char* from, const unsigned char* to)
{
  int ret;
  if ((ret = bb_setUInt8(bb, 1)) != 0 ||
      (ret = bb_setUInt8(bb, DLMS_DATA_TYPE_STRUCTURE)) != 0 ||
      (ret = bb_setUInt8(bb, 4)) != 0 ||
      (ret = bb_setUInt8(bb, DLMS_DATA_TYPE_STRUCTURE)) != 0 ||
      (ret = bb_setUInt8(bb, 4)) != 0 ||
      (ret = bb_setUInt8(bb, DLMS_DATA_TYPE_UINT16)) != 0 ||
      (ret = bb_setUInt16(bb, clock->e.classId)) != 0 ||
      (ret = bb_setUInt8(bb, DLMS_DATA_TYPE_OCTET_STRING)) != 0 ||
      (ret = bb_setUInt8(bb, 6)) != 0 ||
      (ret = bb_set(bb, clock->e.ln, 6)) != 0 ||
      (ret = bb_setUInt8(bb, DLMS_DATA_TYPE_INT8)) != 0 ||
      (ret = bb_setUInt8(bb, (unsigned char)clock->attr)) != 0 ||
      (ret = bb_setUInt8(bb, DLMS_DATA_TYPE_UINT16)) != 0 ||
      (ret = bb_setUInt16(bb, clock->dataIndex)) != 0 ||
      (ret = bb_setUInt8(bb, DLMS_DATA_TYPE_OCTET_STRING)) != 0 ||
      (ret = bb_setUInt8(bb, 12)) != 0 ||
      (ret = bb_set(bb, from, 12)) != 0 ||
      (ret = bb_setUInt8(bb, DLMS_DATA_TYPE_OCTET_STRING)) != 0 ||
      (ret = bb_setUInt8(bb, 12)) != 0 ||
      (ret = bb_set(bb, to, 12)) != 0 ||
      (ret = bb_setUInt8(bb, DLMS_DATA_TYPE_ARRAY)) != 0 ||
      (ret = bb_setUInt8(bb, 0)) != 0)
  {
    return ret;
  }
  return 0;
}

//Read a uint attribute (capture period, entries). 0 if it can't be read.
//Secure meters send the capture period as a big-endian octet-string
//("03 84" = 900 s).
static int pg_readUInt(const unsigned char* ln, unsigned char attr, uint32_t* out)
{
  dlmsVARIANT value;
  var_init(&value);
  int ret = readAttribute(DLMS_OBJECT_TYPE_PROFILE_GENERIC, ln, attr, NULL, &value);
  *out = 0;
  if (ret == 0 && isNumeric(value.vt))
  {
    *out = (uint32_t)var_toInteger(&value);
  }
  else if (ret == 0 && value.vt == DLMS_DATA_TYPE_OCTET_STRING && value.byteArr != NULL &&
           value.byteArr->size >= 1 && value.byteArr->size <= 4)
  {
    for (uint32_t pos = 0; pos != value.byteArr->size; ++pos)
    {
      *out = (*out << 8) | value.byteArr->data[pos];
    }
  }
  var_clear(&value);
  return ret;
}

//Column that holds the row time, -1 if none: the clock (0.0.1.0.0.255,
//not always column 1, e.g. Secure event logs), for billing first the
//billing date (0.0.0.1.2.255, HPL 1.0.0.1.2.255).
static int pg_timeColumn(const PgColumn* cols, uint16_t count, PgKind kind)
{
  static const unsigned char BILLING_DATE[2][6] = {{0, 0, 0, 1, 2, 255}, {1, 0, 0, 1, 2, 255}};
  if (kind == PG_BILLING)
  {
    for (uint16_t c = 0; c != count; ++c)
    {
      if (cols[c].attr == 2 &&
          (memcmp(cols[c].e.ln, BILLING_DATE[0], 6) == 0 || memcmp(cols[c].e.ln, BILLING_DATE[1], 6) == 0))
      {
        return c;
      }
    }
  }
  for (uint16_t c = 0; c != count; ++c)
  {
    if (cols[c].attr == 2 && memcmp(cols[c].e.ln, CLOCK_LN, 6) == 0)
    {
      return c;
    }
  }
  return -1;
}

static PgKind pg_kind(const unsigned char* ln)
{
  static const struct
  {
    unsigned char ln[6];
    PgKind kind;
  } KINDS[] =
  {
    {{1, 0, 94, 91, 0, 255}, PG_INSTANT},
    {{1, 0, 99, 1, 0, 255},  PG_BLOCK},
    {{1, 0, 99, 2, 0, 255},  PG_DAILY},
    {{1, 0, 98, 1, 0, 255},  PG_BILLING},
  };
  for (size_t pos = 0; pos != sizeof(KINDS) / sizeof(KINDS[0]); ++pos)
  {
    if (memcmp(ln, KINDS[pos].ln, 6) == 0)
    {
      return KINDS[pos].kind;
    }
  }
  if (ln[0] == 0 && ln[1] == 0 && ln[2] == 99 && ln[3] == 98 && ln[5] == 255)
  {
    return PG_EVENT;
  }
  return PG_OTHER;
}

//Is a profile of this kind read in a cycle with these flags?
static bool pg_wanted(PgKind kind, uint8_t flags)
{
  if (flags & CYCLE_FULL)
  {
    return true;
  }
  switch (kind)
  {
    case PG_INSTANT:
    case PG_BLOCK:
    case PG_BILLING:
    case PG_EVENT:
      return (flags & CYCLE_PROFILES) != 0;
    case PG_DAILY:
      return (flags & CYCLE_DAILY) != 0;
    default:
      return false;
  }
}

//Profiles whose rows are sent once (marker kept).
static bool pg_hasMarker(PgKind kind)
{
  return kind == PG_BLOCK || kind == PG_DAILY || kind == PG_BILLING || kind == PG_EVENT;
}

static void pg_markKey(const unsigned char* ln, char* key, size_t size)
{
  snprintf(key, size, "m%u_%u_%u_%u_%u", ln[0], ln[1], ln[2], ln[3], ln[4]);
}

//Meter local seconds -> "YYYY-MM-DD hh:mm:ss".
static void pg_tsText(uint32_t t, char* buff, size_t size)
{
  uint16_t y;
  uint8_t m, d;
  civilFromDays((int32_t)(t / 86400UL), &y, &m, &d);
  uint32_t s = t % 86400UL;
  snprintf(buff, size, "%04u-%02u-%02u %02u:%02u:%02u", (unsigned)y, (unsigned)m, (unsigned)d,
           (unsigned)(s / 3600), (unsigned)(s / 60 % 60), (unsigned)(s % 60));
}

//Timestamp of a row: column tc (pg_timeColumn) when it is a date-time. A clock
//column left empty by the meter follows from the previous row plus the
//capture period.
static bool pg_rowTime(const PgColumn* cols, int tc, dlmsVARIANT* row, uint32_t period,
                       uint32_t* prevTs, bool* havePrev, uint32_t* ts)
{
  dlmsVARIANT* v = NULL;
  if (tc < 0 || (uint16_t)tc >= row->Arr->size || va_getByIndex(row->Arr, tc, &v) != 0)
  {
    return false;
  }
  if (isDateTimeCell(v) && dtToSeconds(v->byteArr->data, ts))
  {
    *prevTs = *ts;
    *havePrev = true;
    return true;
  }
  if (cols[tc].e.classId == DLMS_OBJECT_TYPE_CLOCK && *havePrev && period != 0)
  {
    *prevTs += period;
    *ts = *prevTs;
    return true;
  }
  return false;
}

//Queue the rows to upload (see the header) and advance the marker.
//Returns the number of rows queued. A profile without rows to send is left
//out of the reading.
static uint16_t pg_collect(const AvEntry* p, PgKind kind, const PgColumn* cols, uint16_t count,
                           dlmsVARIANT* buffer, uint32_t period, uint32_t mark, uint32_t nowS)
{
  if (buffer->vt != DLMS_DATA_TYPE_ARRAY || buffer->Arr == NULL || count == 0 || buffer->Arr->size == 0)
  {
    return 0;
  }
  if (count > PG_UPLOAD_MAX_COLS)
  {
    TraceSerial.printf("  %u columns is too many to upload (limit %u)\r\n", (unsigned)count,
                       (unsigned)PG_UPLOAD_MAX_COLS);
    return 0;
  }
  uint16_t rows = (uint16_t)buffer->Arr->size;
  int tc = pg_timeColumn(cols, count, kind);
  uint32_t* times = (uint32_t*)malloc(sizeof(uint32_t) * (rows != 0 ? rows : 1));
  bool* hasTime = (bool*)malloc(sizeof(bool) * (rows != 0 ? rows : 1));
  if (times == NULL || hasTime == NULL)
  {
    free(times);
    free(hasTime);
    TraceSerial.print("  Out of memory, rows not queued\r\n");
    return 0;
  }
  //Pass 1: row times; the newest billing row is the current one.
  uint32_t prevTs = 0;
  bool havePrev = false;
  int32_t newest = -1;
  dlmsVARIANT* row;
  for (uint16_t r = 0; r != rows; ++r)
  {
    hasTime[r] = false;
    if (va_getByIndex(buffer->Arr, r, &row) == 0 && row->vt == DLMS_DATA_TYPE_STRUCTURE &&
        row->Arr != NULL)
    {
      hasTime[r] = pg_rowTime(cols, tc, row, period, &prevTs, &havePrev, &times[r]);
      if (hasTime[r] && (newest < 0 || times[r] > times[newest]))
      {
        newest = r;
      }
    }
  }
  //Pass 2: queue the selected rows.
  char obis[24], name[48], cell[64];
  obisToString(p->ln, obis, sizeof(obis));
  const char* pname = obisName(p->ln);
  rd_profileBegin(obis, *pname != 0 ? pname : "Profile");
  for (uint16_t c = 0; c != count; ++c)
  {
    obisToString(cols[c].e.ln, obis, sizeof(obis));
    pg_columnName(&cols[c], name, sizeof(name));
    rd_profileColumn(obis, name, pg_unit(&cols[c]));
  }
  uint16_t queued = 0;
  uint32_t newMark = mark;
  for (uint16_t r = 0; r != rows; ++r)
  {
    if (va_getByIndex(buffer->Arr, r, &row) != 0 || row->vt != DLMS_DATA_TYPE_STRUCTURE ||
        row->Arr == NULL)
    {
      continue;
    }
    bool send;
    switch (kind)
    {
      case PG_BLOCK:
      case PG_DAILY:
      case PG_EVENT:
        send = hasTime[r] && times[r] > mark;
        break;
      case PG_BILLING:
        send = (int32_t)r == newest || (hasTime[r] && times[r] > mark);
        break;
      default:
        send = true;
        break;
    }
    if (!send)
    {
      continue;
    }
    //The current billing row changes until the month closes: never marked.
    //A row stamped in the future (meter clock set back) is not marked either.
    if (hasTime[r] && times[r] > newMark && !(kind == PG_BILLING && (int32_t)r == newest) &&
        times[r] <= nowS + 86400UL)
    {
      newMark = times[r];
    }
    if (hasTime[r])
    {
      pg_tsText(times[r], cell, sizeof(cell));
      rd_profileRowBegin(cell);
    }
    else
    {
      rd_profileRowBegin(NULL);
    }
    for (uint16_t c = 0; c != count; ++c)
    {
      dlmsVARIANT* v = NULL;
      if (c >= row->Arr->size || va_getByIndex(row->Arr, c, &v) != 0)
      {
        v = NULL;
      }
      double number;
      const char* unit;
      if ((int)c == tc && hasTime[r] && cols[c].e.classId == DLMS_OBJECT_TYPE_CLOCK)
      {
        pg_tsText(times[r], cell, sizeof(cell));
        rd_profileCellText(cell);
      }
      else if (v == NULL || v->vt == DLMS_DATA_TYPE_NONE)
      {
        rd_profileCellText(NULL);
      }
      else if (formatValue(&cols[c].e, v, cell, sizeof(cell), &number, &unit))
      {
        rd_profileCellNumber(number);
      }
      else
      {
        rd_profileCellText(cell);
      }
    }
    int id = kind == PG_EVENT ? pg_eventId(cols, count, row) : -1;
    rd_profileRowEnd(id >= 0 ? eventName(id) : NULL);
    ++queued;
  }
  if (queued != 0)
  {
    rd_profileEnd();
  }
  else
  {
    rd_profileCancel();
  }
  if (pg_hasMarker(kind) && newMark != mark)
  {
    char key[16];
    pg_markKey(p->ln, key, sizeof(key));
    mk_advance(key, newMark);
  }
  free(times);
  free(hasTime);
  return queued;
}

//Read one profile, print it (table on full cycles, one line otherwise) and
//queue its new rows. Only link errors are returned.
static int pg_readProfile(const AvEntry* p, PgKind kind, const unsigned char* now, bool nowValid,
                          bool full)
{
  char obis[24];
  char from[24], to[24];
  PgColumn* cols;
  uint16_t count;
  uint32_t period = 0, inUse = 0, maxEntries = 0;
  obisToString(p->ln, obis, sizeof(obis));
  const char* name = obisName(p->ln);
  if (*name == 0)
  {
    name = "Profile";
  }
  if (full)
  {
    TraceSerial.printf("\r\n---------------- %s (%s) ----------------\r\n", name, obis);
  }
  else
  {
    TraceSerial.printf("  %-26s ", name);
  }
  int ret = pg_readColumns(p->ln, &cols, &count);
  if (ret != 0)
  {
    pg_printError("Capture objects", ret);
    return isLinkError(ret) ? ret : 0;
  }
  if ((ret = pg_readUInt(p->ln, 4, &period)) == 0 || !isLinkError(ret))
  {
    if ((ret = pg_readUInt(p->ln, 7, &inUse)) == 0 || !isLinkError(ret))
    {
      if ((ret = pg_readUInt(p->ln, 8, &maxEntries)) == 0 || !isLinkError(ret))
      {
        ret = pg_applyScalers(p->ln, cols, count);
      }
    }
  }
  if (isLinkError(ret))
  {
    free(cols);
    return ret;
  }
  if (full)
  {
    TraceSerial.printf("  Columns %u, capture period %lu s, entries %lu of %lu\r\n",
                       (unsigned)count, (unsigned long)period,
                       (unsigned long)inUse, (unsigned long)maxEntries);
  }
  char key[16];
  pg_markKey(p->ln, key, sizeof(key));
  uint32_t nowS = 0;
  bool haveNow = nowValid && dtToSeconds(now, &nowS);
  uint32_t mark = pg_hasMarker(kind) ? mk_get(key) : 0;
  if (mark != 0 && haveNow && mark > nowS + 86400UL)
  {
    //Newer than the meter clock: the clock was set back. Start over.
    mark = 0;
  }
  gxByteBuffer access;
  BYTE_BUFFER_INIT(&access);
  int tc = pg_timeColumn(cols, count, kind);
  bool byRange = period != 0 && tc >= 0 &&
                 cols[tc].e.classId == DLMS_OBJECT_TYPE_CLOCK && haveNow;
  if (byRange)
  {
    unsigned char start[12], end[12];
    uint32_t window = period * PG_WINDOW_PERIODS;
    if (window < PG_MIN_WINDOW_S)
    {
      window = PG_MIN_WINDOW_S;
    }
    uint32_t maxBack = period * PG_MAX_NEW_ROWS;
    if (maxBack > PG_MAX_BACK_S || maxBack / PG_MAX_NEW_ROWS != period)
    {
      maxBack = PG_MAX_BACK_S;
    }
    //From the newest row sent; a full read also shows the usual window.
    uint32_t fromS = mark != 0 ? mark + 1 : nowS - window;
    //After a one-time marker reset (mk_checkEpoch) an unmarked profile
    //reads back PG_RECOVER_BACK_S, still at most PG_MAX_NEW_ROWS periods.
    if (mark == 0 && pg_hasMarker(kind) && mk_recovering())
    {
      maxBack = period * PG_MAX_NEW_ROWS;
      if (maxBack > PG_RECOVER_BACK_S || maxBack / PG_MAX_NEW_ROWS != period)
      {
        maxBack = PG_RECOVER_BACK_S;
      }
      fromS = nowS - maxBack;
    }
    if (full && fromS > nowS - window)
    {
      fromS = nowS - window;
    }
    //Catch-up limit for marked profiles only: the instantaneous profile has
    //a 1 s capture period and keeps its usual window.
    if (pg_hasMarker(kind) && fromS < nowS - maxBack)
    {
      fromS = nowS - maxBack;
    }
    dtFromSeconds(fromS, now, start);
    dtFromSeconds(nowS + period, now, end);
    if (full)
    {
      dtText(start, from, sizeof(from));
      dtText(end, to, sizeof(to));
      TraceSerial.printf("  Reading range %s .. %s\r\n", from, to);
    }
    ret = pg_rangeSelector(&access, &cols[tc], start, end);
  }
  else if (inUse > PG_PLAIN_MAX_ROWS)
  {
    TraceSerial.printf("  Skipped: %lu entries is too many for a plain read (limit %u)\r\n",
                       (unsigned long)inUse, (unsigned)PG_PLAIN_MAX_ROWS);
    free(cols);
    return 0;
  }
  if (ret == 0)
  {
    dlmsVARIANT value;
    var_init(&value);
    uint32_t start = millis();
    ret = readAttribute(DLMS_OBJECT_TYPE_PROFILE_GENERIC, p->ln, 2,
                        byRange ? &access : NULL, &value);
    if (ret == 0)
    {
      uint32_t ms = millis() - start;
      if (full)
      {
        TraceSerial.printf("  Buffer read in %lu ms\r\n", (unsigned long)ms);
        pg_printBuffer(cols, count, &value, period, now);
      }
      uint16_t queued = pg_collect(p, kind, cols, count, &value, period, mark, nowS);
      unsigned rows = value.vt == DLMS_DATA_TYPE_ARRAY && value.Arr != NULL ? (unsigned)value.Arr->size : 0;
      if (full)
      {
        TraceSerial.printf("  Rows queued for upload: %u\r\n", (unsigned)queued);
      }
      else
      {
        TraceSerial.printf("%3u rows read, %3u queued (%lu ms)\r\n", rows, (unsigned)queued,
                           (unsigned long)ms);
      }
    }
    else
    {
      pg_printError("Buffer", ret);
    }
    var_clear(&value);
  }
  bb_clear(&access);
  free(cols);
  return isLinkError(ret) ? ret : 0;
}

//Read the meter clock (attribute 2 of 0.0.1.0.0.255) into now. valid = it is
//a date-time. Returns the read error (link errors matter).
int pg_readClock(unsigned char* now, bool* valid)
{
  dlmsVARIANT value;
  memset(now, 0, 12);
  var_init(&value);
  int ret = readAttribute(DLMS_OBJECT_TYPE_CLOCK, CLOCK_LN, 2, NULL, &value);
  *valid = ret == 0 && isDateTimeCell(&value);
  if (*valid)
  {
    memcpy(now, value.byteArr->data, 12);
  }
  var_clear(&value);
  return ret;
}

//Meter clock as meter local seconds. False if it is not a usable date.
bool pg_clockSeconds(const unsigned char* now, uint32_t* out)
{
  return dtToSeconds(now, out);
}

//Read the profile generic objects this cycle wants (flags, see the header).
//Scaler profiles are not read here; they are used to scale the others.
int pg_readCycle(uint8_t flags, const unsigned char* now, bool nowValid)
{
  bool full = (flags & CYCLE_FULL) != 0;
  if (!nowValid)
  {
    TraceSerial.print("\r\n  Meter clock not readable: block/daily load are read only if small.\r\n");
  }
  TraceSerial.print(full ? "\r\n====================== Profile generic ======================\r\n"
                         : "\r\n-------------------------- Profiles --------------------------\r\n");
  int ret = 0;
  for (uint16_t pos = 0; pos != g_avCount; ++pos)
  {
    const AvEntry* e = &g_av[pos];
    if (e->classId != DLMS_OBJECT_TYPE_PROFILE_GENERIC || pg_isScalerProfile(e->ln))
    {
      continue;
    }
    PgKind kind = pg_kind(e->ln);
    if (!pg_wanted(kind, flags))
    {
      continue;
    }
    if ((ret = pg_readProfile(e, kind, now, nowValid, full)) != 0)
    {
      rd_profileCancel();
      TraceSerial.print("  Meter stopped answering. Profiles aborted.\r\n");
      break;
    }
  }
  TraceSerial.print(full ? "=============================================================\r\n"
                         : "--------------------------------------------------------------\r\n");
  return ret;
}

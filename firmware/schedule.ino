// =============================================================================
//  schedule.ino  --  when to read what
//
//    CYCLE_VALUES    meter readings (register values)  every g_cfg.readS
//    CYCLE_PROFILES  instantaneous, block load,        every g_cfg.profileMin
//                    billing, event logs
//    CYCLE_DAILY     daily load profile                first cycle after midnight
//    CYCLE_FULL      everything, tables printed        boot and BLE "read"
//
//  Times come from the meter clock, read at the start of every cycle
//  (sched_syncClock). Intervals that divide a day are aligned to it, e.g.
//  30 min = hh:00 and hh:30, plus SCHED_DELAY_S so the meter has closed the
//  block first. Values and profiles due at the same time run in one meter
//  session. Until the clock has been read once, plain uptime timers are used.
//  CYCLE_* flags are in config.h (client.ino and profiles.ino use them too).
// =============================================================================
#include <esp_timer.h>

static bool s_synced = false;
static int64_t s_offsetS = 0;         // meter local seconds - uptime seconds
static int64_t s_nextReadS = 0;       // meter local seconds
static int64_t s_nextProfileS = 0;
static int64_t s_dailyDay = -1;       // day of the last daily read, -1 = none
static int64_t s_lastReadUpS = 0;     // uptime fallback while not synced
static int64_t s_lastProfileUpS = 0;

static int64_t sched_upS()
{
  return esp_timer_get_time() / 1000000LL;
}

static int64_t sched_nowS()
{
  return s_offsetS + sched_upS();
}

//First run time after now: the next day-aligned boundary plus the delay, or
//now + period when the period does not divide a day.
static int64_t sched_next(int64_t now, uint32_t periodS)
{
  if (periodS == 0)
  {
    periodS = 60;
  }
  if (86400UL % periodS != 0)
  {
    return now + periodS;
  }
  int64_t base = now - (int64_t)SCHED_DELAY_S;
  return (base / periodS + 1) * periodS + SCHED_DELAY_S;
}

//Day number of a run time; a cycle at 00:00:59 still counts as yesterday.
static int64_t sched_day(int64_t t)
{
  return (t - (int64_t)SCHED_DELAY_S) / 86400LL;
}

//The meter clock as read at the start of a cycle (meter local seconds).
void sched_syncClock(uint32_t meterS)
{
  bool first = !s_synced;
  s_offsetS = (int64_t)meterS - sched_upS();
  s_synced = true;
  int64_t now = sched_nowS();
  //First sync, or the meter clock was set back: plan from the new time.
  if (first || s_nextReadS - now > (int64_t)(g_cfg.readS + SCHED_DELAY_S) ||
      s_nextProfileS - now > (int64_t)(g_cfg.profileMin * 60UL + SCHED_DELAY_S))
  {
    s_nextReadS = sched_next(now, g_cfg.readS);
    s_nextProfileS = sched_next(now, g_cfg.profileMin * 60UL);
  }
}

//Settings changed: plan the next runs with the new intervals.
void sched_reset()
{
  if (s_synced)
  {
    int64_t now = sched_nowS();
    s_nextReadS = sched_next(now, g_cfg.readS);
    s_nextProfileS = sched_next(now, g_cfg.profileMin * 60UL);
  }
}

//What is due now (CYCLE_* flags), 0 = nothing.
uint8_t sched_due()
{
  uint8_t flags = 0;
  if (s_synced)
  {
    int64_t now = sched_nowS();
    if (now >= s_nextReadS)
    {
      flags |= CYCLE_VALUES;
    }
    if (now >= s_nextProfileS)
    {
      flags |= CYCLE_PROFILES;
    }
    //Daily load rides along with the first cycle of a new day. A failed
    //daily read is retried with the next cycle, never in a tight loop.
    if (flags != 0 && s_dailyDay >= 0 && sched_day(now) != s_dailyDay)
    {
      flags |= CYCLE_DAILY;
    }
  }
  else
  {
    int64_t up = sched_upS();
    if (up - s_lastReadUpS >= (int64_t)g_cfg.readS)
    {
      flags |= CYCLE_VALUES;
    }
    if (up - s_lastProfileUpS >= (int64_t)g_cfg.profileMin * 60)
    {
      flags |= CYCLE_PROFILES;
    }
  }
  return flags;
}

//A cycle with these flags has run. ok = the meter answered; the daily read
//only counts as done when it worked.
void sched_done(uint8_t flags, bool ok)
{
  int64_t up = sched_upS();
  if (flags & (CYCLE_VALUES | CYCLE_FULL))
  {
    s_lastReadUpS = up;
  }
  if (flags & (CYCLE_PROFILES | CYCLE_FULL))
  {
    s_lastProfileUpS = up;
  }
  if (!s_synced)
  {
    return;
  }
  int64_t now = sched_nowS();
  if (flags & (CYCLE_VALUES | CYCLE_FULL))
  {
    s_nextReadS = sched_next(now, g_cfg.readS);
  }
  if (flags & (CYCLE_PROFILES | CYCLE_FULL))
  {
    s_nextProfileS = sched_next(now, g_cfg.profileMin * 60UL);
  }
  int64_t day = sched_day(now);
  if (flags & (CYCLE_DAILY | CYCLE_FULL))
  {
    //Failed: "yesterday", so the next cycle tries again.
    s_dailyDay = ok ? day : day - 1;
  }
  else if (s_dailyDay < 0)
  {
    //Clock first read in a cycle without daily load: next one after midnight.
    s_dailyDay = day;
  }
}

//"next_read=hh:mm next_profile=hh:mm" (meter time) for GET_STATUS.
String sched_statusLine()
{
  if (!s_synced)
  {
    return "clock=not_read";
  }
  char line[64];
  int64_t r = s_nextReadS % 86400LL;
  int64_t p = s_nextProfileS % 86400LL;
  snprintf(line, sizeof(line), "next_read=%02d:%02d next_profile=%02d:%02d",
           (int)(r / 3600), (int)(r / 60 % 60), (int)(p / 3600), (int)(p / 60 % 60));
  return String(line);
}

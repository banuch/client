// =============================================================================
//  obis_names.h  --  OBIS code descriptions shown with the association view
//
//  Based on data_obis.ino of the dlms_client project, extended with the
//  IS-15959 single-phase codes. Codes not listed here are still shown,
//  just without a description.
// =============================================================================
#ifndef OBIS_NAMES_H
#define OBIS_NAMES_H

typedef struct
{
  const char* obis;
  const char* name;
} ObisName;

static const ObisName OBIS_NAMES[] =
{
  // ── Abstract / identification ───────────────────────────────────────────
  {"0.0.0.1.0.255",      "Billing Count"},
  {"0.0.0.1.1.255",      "Available Billing Periods"},
  {"0.0.0.1.2.255",      "Billing Date"},
  {"0.0.1.0.0.255",      "Clock"},
  {"0.0.40.0.0.255",     "Current Association"},
  {"0.0.40.0.1.255",     "Association PC"},
  {"0.0.40.0.2.255",     "Association MR"},
  {"0.0.40.0.3.255",     "Association US"},
  {"0.0.42.0.0.255",     "Logical Device Name"},
  {"0.0.22.0.0.255",     "HDLC Setup"},
  {"0.0.43.0.0.255",     "Security Setup"},
  {"0.0.43.1.0.255",     "Frame Counter"},
  {"0.0.10.0.1.255",     "Billing Script Table"},
  {"0.0.10.0.100.255",   "Tariff Script"},
  {"0.0.13.0.0.255",     "Activity Calendar"},
  {"0.0.15.0.0.255",     "Single Action Schedule"},
  {"0.0.17.0.0.255",     "Limiter"},
  {"0.0.25.9.0.255",     "Push Setup"},
  {"0.0.25.0.0.255",     "TCP/UDP Setup"},
  {"0.0.25.1.0.255",     "IPv4 Setup"},
  {"0.0.25.2.0.255",     "MAC Address Setup"},
  {"0.0.96.3.10.255",    "Disconnect Control"},

  // ── Meter identity ──────────────────────────────────────────────────────
  {"0.0.96.1.0.255",     "Meter Serial Number"},
  {"0.0.96.1.1.255",     "Manufacturer Name"},
  {"0.0.96.1.2.255",     "Device Type"},
  {"0.0.96.1.3.255",     "Hardware Version"},
  {"0.0.96.1.4.255",     "Year of Manufacture"},
  {"0.0.96.1.5.255",     "Firmware ID"},
  {"1.0.0.2.0.255",      "Firmware Version"},
  {"0.0.94.91.9.255",    "Meter Type"},
  {"0.0.94.91.11.255",   "Meter Category"},
  {"0.0.94.91.12.255",   "Current Rating"},

  // ── Counters / status ───────────────────────────────────────────────────
  {"0.0.96.2.0.255",     "Programming Count"},
  {"0.0.96.5.4.255",     "Status Register"},
  {"0.0.96.7.0.255",     "Power Failure Count"},
  {"0.0.94.91.0.255",    "Tamper Count"},
  {"0.0.94.91.8.255",    "Power-off Duration"},
  {"0.0.94.91.14.255",   "Power-on Duration"},

  // ── Event codes / logs ──────────────────────────────────────────────────
  {"0.0.96.11.0.255",    "Event Code: Voltage"},
  {"0.0.96.11.1.255",    "Event Code: Current"},
  {"0.0.96.11.2.255",    "Event Code: Power"},
  {"0.0.96.11.3.255",    "Event Code: Transaction"},
  {"0.0.96.11.4.255",    "Event Code: Other"},
  {"0.0.96.11.5.255",    "Event Code: Non-roll"},
  {"0.0.96.11.6.255",    "Event Code: Control"},
  {"0.0.99.98.0.255",    "Event Log: Voltage"},
  {"0.0.99.98.1.255",    "Event Log: Current"},
  {"0.0.99.98.2.255",    "Event Log: Power"},
  {"0.0.99.98.3.255",    "Event Log: Transaction"},
  {"0.0.99.98.4.255",    "Event Log: Other"},
  {"0.0.99.98.5.255",    "Event Log: Non-roll"},
  {"0.0.99.98.6.255",    "Event Log: Control"},

  // ── Configuration ───────────────────────────────────────────────────────
  {"1.0.0.4.2.255",      "CT Ratio"},
  {"1.0.0.4.3.255",      "PT Ratio"},
  {"1.0.0.8.0.255",      "Demand Integration Period"},
  {"1.0.0.8.4.255",      "Profile Capture Period"},
  {"1.0.0.8.5.255",      "Daily Profile Period"},

  // ── Instantaneous: single phase ─────────────────────────────────────────
  {"1.0.12.7.0.255",     "Voltage"},
  {"1.0.11.7.0.255",     "Phase Current"},
  {"1.0.91.7.0.255",     "Neutral Current"},

  // ── Instantaneous: three phase ──────────────────────────────────────────
  {"1.0.32.7.0.255",     "Voltage L1"},
  {"1.0.52.7.0.255",     "Voltage L2"},
  {"1.0.72.7.0.255",     "Voltage L3"},
  {"1.0.31.7.0.255",     "Current L1"},
  {"1.0.51.7.0.255",     "Current L2"},
  {"1.0.71.7.0.255",     "Current L3"},
  {"1.0.33.7.0.255",     "Power Factor L1"},
  {"1.0.53.7.0.255",     "Power Factor L2"},
  {"1.0.73.7.0.255",     "Power Factor L3"},
  {"1.0.21.7.0.255",     "Active Power L1"},
  {"1.0.41.7.0.255",     "Active Power L2"},
  {"1.0.61.7.0.255",     "Active Power L3"},
  {"1.0.36.7.0.255",     "Signed Active Power L1"},
  {"1.0.56.7.0.255",     "Signed Active Power L2"},
  {"1.0.76.7.0.255",     "Signed Active Power L3"},
  {"1.0.23.7.0.255",     "Reactive Power L1"},
  {"1.0.43.7.0.255",     "Reactive Power L2"},
  {"1.0.63.7.0.255",     "Reactive Power L3"},

  // ── Instantaneous: system ───────────────────────────────────────────────
  {"1.0.13.7.0.255",     "Power Factor"},
  {"1.0.14.7.0.255",     "Frequency"},
  {"1.0.1.7.0.255",      "Active Power"},
  {"1.0.2.7.0.255",      "Active Power Export"},
  {"1.0.3.7.0.255",      "Reactive Power"},
  {"1.0.9.7.0.255",      "Apparent Power"},

  // ── Energy ──────────────────────────────────────────────────────────────
  {"1.0.1.8.0.255",      "Active Energy Import"},
  {"1.0.2.8.0.255",      "Active Energy Export"},
  {"1.0.5.8.0.255",      "Reactive Energy Lag"},
  {"1.0.8.8.0.255",      "Reactive Energy Lead"},
  {"1.0.9.8.0.255",      "Apparent Energy Import"},
  {"1.0.10.8.0.255",     "Apparent Energy Export"},
  {"1.0.6.8.0.255",      "Reactive Energy Q2"},
  {"1.0.7.8.0.255",      "Reactive Energy Q3"},
  {"0.0.94.91.13.255",   "Billing Power-on Duration"},
  {"1.0.94.91.1.255",    "Reactive Energy High Voltage"},
  {"1.0.94.91.2.255",    "Reactive Energy Low Voltage"},
  {"1.0.1.8.1.255",      "kWh TZ1"},
  {"1.0.1.8.2.255",      "kWh TZ2"},
  {"1.0.1.8.3.255",      "kWh TZ3"},
  {"1.0.1.8.4.255",      "kWh TZ4"},
  {"1.0.1.8.5.255",      "kWh TZ5"},
  {"1.0.1.8.6.255",      "kWh TZ6"},
  {"1.0.1.8.7.255",      "kWh TZ7"},
  {"1.0.1.8.8.255",      "kWh TZ8"},
  {"1.0.9.8.1.255",      "kVAh TZ1"},
  {"1.0.9.8.2.255",      "kVAh TZ2"},
  {"1.0.9.8.3.255",      "kVAh TZ3"},
  {"1.0.9.8.4.255",      "kVAh TZ4"},
  {"1.0.9.8.5.255",      "kVAh TZ5"},
  {"1.0.9.8.6.255",      "kVAh TZ6"},
  {"1.0.9.8.7.255",      "kVAh TZ7"},
  {"1.0.9.8.8.255",      "kVAh TZ8"},

  // ── Maximum demand ──────────────────────────────────────────────────────
  {"1.0.1.6.0.255",      "MD kW"},
  {"1.0.2.6.0.255",      "MD kW Export"},
  {"1.0.9.6.0.255",      "MD kVA"},
  {"1.0.1.2.0.255",      "Cumulative MD kW"},
  {"1.0.9.2.0.255",      "Cumulative MD kVA"},
  {"1.0.13.0.0.255",     "Billing Avg Power Factor"},
  {"1.0.10.6.0.255",     "MD kVA Export"},
  {"1.0.10.2.0.255",     "Cumulative MD kVA Export"},
  {"1.0.10.6.1.255",     "MD kVA Export TZ1"},
  {"1.0.10.6.2.255",     "MD kVA Export TZ2"},
  {"1.0.10.6.3.255",     "MD kVA Export TZ3"},
  {"1.0.10.6.4.255",     "MD kVA Export TZ4"},
  {"1.0.10.6.5.255",     "MD kVA Export TZ5"},
  {"1.0.10.6.6.255",     "MD kVA Export TZ6"},
  {"1.0.10.6.7.255",     "MD kVA Export TZ7"},
  {"1.0.10.6.8.255",     "MD kVA Export TZ8"},
  {"1.0.1.6.1.255",      "MD kW TZ1"},
  {"1.0.1.6.2.255",      "MD kW TZ2"},
  {"1.0.1.6.3.255",      "MD kW TZ3"},
  {"1.0.1.6.4.255",      "MD kW TZ4"},
  {"1.0.9.6.1.255",      "MD kVA TZ1"},
  {"1.0.9.6.2.255",      "MD kVA TZ2"},
  {"1.0.9.6.3.255",      "MD kVA TZ3"},
  {"1.0.9.6.4.255",      "MD kVA TZ4"},
  {"1.0.1.6.5.255",      "MD kW TZ5"},
  {"1.0.1.6.6.255",      "MD kW TZ6"},
  {"1.0.1.6.7.255",      "MD kW TZ7"},
  {"1.0.1.6.8.255",      "MD kW TZ8"},
  {"1.0.9.6.5.255",      "MD kVA TZ5"},
  {"1.0.9.6.6.255",      "MD kVA TZ6"},
  {"1.0.9.6.7.255",      "MD kVA TZ7"},
  {"1.0.9.6.8.255",      "MD kVA TZ8"},

  // ── Block load survey columns ───────────────────────────────────────────
  {"1.0.12.27.0.255",    "Avg Voltage"},
  {"1.0.11.27.0.255",    "Avg Current"},
  {"1.0.32.27.0.255",    "Avg Voltage L1"},
  {"1.0.52.27.0.255",    "Avg Voltage L2"},
  {"1.0.72.27.0.255",    "Avg Voltage L3"},
  {"1.0.31.27.0.255",    "Avg Current L1"},
  {"1.0.51.27.0.255",    "Avg Current L2"},
  {"1.0.71.27.0.255",    "Avg Current L3"},
  {"1.0.1.29.0.255",     "Block kWh"},
  {"1.0.2.29.0.255",     "Block kWh Export"},
  {"1.0.5.29.0.255",     "Block kvarh Lag"},
  {"1.0.8.29.0.255",     "Block kvarh Lead"},
  {"1.0.6.29.0.255",     "Block kvarh Q2"},
  {"1.0.7.29.0.255",     "Block kvarh Q3"},
  {"1.0.9.29.0.255",     "Block kVAh"},
  {"1.0.10.29.0.255",    "Block kVAh Export"},
  {"1.0.13.27.0.255",    "Avg Power Factor"},
  {"1.0.14.27.0.255",    "Avg Frequency"},
  {"1.0.16.29.0.255",    "Block kWh Net"},

  // ── L&T / Schneider vendor objects (from the meter's parameter list) ─
  {"0.128.140.128.128.255", "Anomaly Data"},
  {"0.128.141.128.128.255", "Name Plate Details (L&T)"},
  {"0.128.150.128.128.255", "Meter Version (L&T)"},
  {"0.128.152.128.128.255", "Lead/UPF/Import-Export Flag"},
  {"0.128.153.128.128.255", "Reset Type"},
  {"0.128.164.128.128.255", "Firmware Upgrade Count"},
  {"0.128.165.128.128.255", "Firmware Upgrade Date/Time"},
  {"0.128.187.0.128.255",   "Running Tamper Events"},

  // ── Profiles ────────────────────────────────────────────────────────────
  {"1.0.94.91.0.255",    "Instantaneous Profile"},
  {"1.0.94.91.3.255",    "Scalers: Instantaneous"},
  {"1.0.94.91.4.255",    "Scalers: Block Load"},
  {"1.0.94.91.5.255",    "Scalers: Daily Load"},
  {"1.0.94.91.6.255",    "Scalers: Billing"},
  {"1.0.94.91.7.255",    "Scalers: Events"},
  {"1.0.98.1.0.255",     "Billing Profile"},
  {"1.0.99.1.0.255",     "Block Load Profile"},
  {"1.0.99.2.0.255",     "Daily Load Profile"},
  {"0.0.94.91.10.255",   "Name Plate Profile"},
};

static const size_t OBIS_NAMES_SIZE = sizeof(OBIS_NAMES) / sizeof(OBIS_NAMES[0]);

// Event identifiers from IS 15959 Part 1 (2011) Tables 32-38, its
// Amendment 2 (single phase, Tables 49-53) and Part 3 (2017) Tables 5-10. "Occ" = occurrence, "Res" = restoration.
typedef struct
{
  uint16_t id;
  const char* name;
} EventName;

static const EventName EVENT_NAMES[] =
{
  // Voltage related (0.0.96.11.0.255)
  {1,   "R voltage missing - Occ"},
  {2,   "R voltage missing - Res"},
  {3,   "Y voltage missing - Occ"},
  {4,   "Y voltage missing - Res"},
  {5,   "B voltage missing - Occ"},
  {6,   "B voltage missing - Res"},
  {7,   "Over voltage - Occ"},
  {8,   "Over voltage - Res"},
  {9,   "Low voltage - Occ"},
  {10,  "Low voltage - Res"},
  {11,  "Voltage unbalance - Occ"},
  {12,  "Voltage unbalance - Res"},
  // Current related (0.0.96.11.1.255)
  {51,  "R current reverse - Occ"},
  {52,  "R current reverse - Res"},
  {53,  "Y current reverse - Occ"},
  {54,  "Y current reverse - Res"},
  {55,  "B current reverse - Occ"},
  {56,  "B current reverse - Res"},
  {57,  "R CT open - Occ"},
  {58,  "R CT open - Res"},
  {59,  "Y CT open - Occ"},
  {60,  "Y CT open - Res"},
  {61,  "B CT open - Occ"},
  {62,  "B CT open - Res"},
  {63,  "Current unbalance - Occ"},
  {64,  "Current unbalance - Res"},
  {65,  "CT bypass - Occ"},
  {66,  "CT bypass - Res"},
  {67,  "Over current - Occ"},
  {68,  "Over current - Res"},
  {69,  "Earth loading - Occ"},
  {70,  "Earth loading - Res"},
  // Power related (0.0.96.11.2.255)
  {101, "Power failure - Occ"},
  {102, "Power failure - Res"},
  // Transaction related (0.0.96.11.3.255)
  {151, "RTC date/time set"},
  {152, "Demand integration period set"},
  {153, "Profile capture period set"},
  {154, "Billing date schedule set"},
  {155, "Activity calendar set"},
  {156, "RS485 device address set"},
  {157, "New firmware activated"},
  {161, "LLS secret (MR) changed"},
  {162, "HLS key (US) changed"},
  {163, "HLS key (FW) changed"},
  {164, "Global key changed"},
  {165, "ESWF changed"},
  {166, "MD reset"},
  {167, "Metering mode set"},
  {169, "Image activation schedule set"},
  {177, "Mode changed to forwarded only"},
  {178, "Mode changed to import-export"},
  // Others (0.0.96.11.4.255)
  {201, "Magnetic influence - Occ"},
  {202, "Magnetic influence - Res"},
  {203, "Neutral disturbance - Occ"},
  {204, "Neutral disturbance - Res"},
  {205, "Low PF - Occ"},
  {206, "Low PF - Res"},
  {207, "Single wire operation - Occ"},
  {208, "Single wire operation - Res"},
  {209, "Comm module removed - Occ"},
  {210, "Comm module removed - Res"},
  {215, "Overload - Occ"},
  {216, "Overload - Res"},
  // Non-rollover (0.0.96.11.5.255)
  {251, "Meter cover opened"},
  // Control (0.0.96.11.6.255)
  {301, "Load disconnected"},
  {302, "Load connected"},
};

static const size_t EVENT_NAMES_SIZE = sizeof(EVENT_NAMES) / sizeof(EVENT_NAMES[0]);

#endif // OBIS_NAMES_H

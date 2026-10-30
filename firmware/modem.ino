// =============================================================================
//  modem.ino  --  Quectel EC200U AT driver (TCP client only)
//
//  Ported from dlms_client server_send.ino / ota_update.ino with the field
//  fixes kept:
//    - PDP context must be activated (AT+QIACT=1) or QIOPEN silently times out
//    - QIOPEN success is the async "+QIOPEN: <id>,<err>" URC, not the leading OK
//    - one retry when that URC never arrives (err -999)
//    - quiet window between closing one socket and opening the next
//  New here: modem_tcpRead() parses the AT+QIRD reply byte-by-byte, so binary
//  firmware data (which can contain "\r\n", "OK", NULs...) is never mangled
//  by String-based searching. modem_ensure() (FW 2.0.9) checks the module
//  before each use and powers it back on with PWRKEY when it went off.
//  FW 2.0.12: SET apn=auto (the default) picks the APN from the SIM's
//  operator, see "APN" below.
// =============================================================================

#include <Preferences.h>

static uint32_t s_lastSocketCloseMs = 0;
static bool s_modemDown = false;   // set when the module reported a power-down or restart

// APN in use (see "APN" below).
struct ApnEntry { const char* name; const char* apn; };
static const ApnEntry APNS[] = APN_TABLE;
static String s_apnUsed;           // APN of the active PDP context
static String s_apnFrom = "-";     // "set", "saved", "operator", "fallback"
static String s_operator;          // APN_TABLE name the SIM / network reported
static String s_iccid;

// ── Low-level helpers ───────────────────────────────────────────────────────
// Drop leftover bytes. Among them, notices that the module switched off or
// restarted by itself (POWERED DOWN, under-voltage, a fresh RDY) mark it
// down: the next modem_ensure() brings it back.
static void modem_drain() {
    String s;
    while (MODEM.available()) s += (char)MODEM.read();
    if (s.indexOf("POWERED DOWN") != -1 || s.indexOf("UNDER_VOLTAGE") != -1 ||
        s.indexOf("vbatt\",-2") != -1 || s.startsWith("RDY") || s.indexOf("\nRDY") != -1) {
        s.trim();
        TraceSerial.printf("\r\n[MDM] Modem notice: %s\r\n", s.substring(0, 120).c_str());
        s_modemDown = true;
    }
}

// Send a command and collect the reply until OK / ERROR / timeout.
String modem_atCollect(const char* cmd, uint32_t timeoutMs) {
    modem_drain();
    MODEM_DEBUG.printf("[AT]>> %s\n", cmd);
    MODEM.println(cmd);
    String buf;
    uint32_t t = millis();
    while (millis() - t < timeoutMs) {
        while (MODEM.available()) buf += (char)MODEM.read();
        if (buf.indexOf("\r\nOK\r\n") != -1 || buf.endsWith("OK\r\n") ||
            buf.indexOf("ERROR") != -1) break;
        delay(2);
    }
    String shown = buf;
    shown.trim();
    if (shown.length()) MODEM_DEBUG.printf("[AT]<< %s\n", shown.c_str());
    return buf;
}

static bool modem_atOk(const char* cmd, uint32_t timeoutMs) {
    String r = modem_atCollect(cmd, timeoutMs);
    return r.indexOf("OK") != -1 && r.indexOf("ERROR") == -1;
}

// Read one line (terminated by '\n', '\r' stripped). Returns false on timeout.
static bool modem_readLine(String& line, uint32_t timeoutMs) {
    line = "";
    uint32_t t = millis();
    while (millis() - t < timeoutMs) {
        if (!MODEM.available()) { delay(1); continue; }
        char c = (char)MODEM.read();
        if (c == '\n') return true;
        if (c != '\r') line += c;
        if (line.length() > 256) return true;   // runaway line, hand it back
    }
    return false;
}

// ── Power / init ────────────────────────────────────────────────────────────
void modem_hwInit() {
    MODEM_DEBUG.println("[MDM] Hardware init");
    pinMode(MODEM_WAKE_PIN, OUTPUT);
    digitalWrite(MODEM_WAKE_PIN, LOW);  delay(200);
    digitalWrite(MODEM_WAKE_PIN, HIGH); delay(200);
    digitalWrite(MODEM_WAKE_PIN, LOW);  delay(500);
    MODEM.setRxBufferSize(MODEM_RX_BUFFER);
    MODEM.begin(MODEM_BAUD, SERIAL_8N1, MODEM_RX_PIN, MODEM_TX_PIN);
    delay(5000);   // EC200U boot time
}

static bool modem_ensurePdp() {
    String r = modem_atCollect("AT+QIACT?", 3000);
    int qi = r.indexOf("+QIACT: 1,");
    if (qi != -1 && qi + 10 < (int)r.length() && r[qi + 10] == '1') return true;
    modem_atCollect("AT+QIACT=1", 15000);
    r = modem_atCollect("AT+QIACT?", 3000);
    return r.indexOf("+QIACT: 1,1") != -1;
}

String modem_readImei() {
    String r = modem_atCollect("AT+GSN", 2000);
    String digits;
    for (size_t i = 0; i < r.length(); i++) {
        if (isDigit(r[i])) digits += r[i];
        else if (digits.length() >= 14) break;
        else digits = "";
    }
    return (digits.length() >= 14 && digits.length() <= 17) ? digits : String("");
}

bool modem_init() {
    MODEM_DEBUG.println("\n[MDM] --- AT init ---");
    bool alive = false;
    for (int i = 0; i < 10 && !alive; i++) {
        alive = modem_atOk("AT", 1000);
        if (!alive) delay(500);
    }
    if (!alive) {
        MODEM_DEBUG.println("[MDM] ERR: no response to AT");
        return false;
    }
    modem_atCollect("ATE0", 1000);
    modem_atCollect("AT+CMEE=2", 1000);
    modem_atCollect("AT+QSCLK=0", 1000);   // never sleep: the UART must answer at any time

    if (g_ota.imei.isEmpty()) g_ota.imei = modem_readImei();
    MODEM_DEBUG.printf("[MDM] IMEI: %s\n", g_ota.imei.isEmpty() ? "(unreadable)" : g_ota.imei.c_str());

    modem_atCollect("AT+CPIN?", 2000);
    modem_atCollect("AT+CFUN=1", 3000);
    modem_atCollect("AT+CTZU=1", 1000);     // keep the clock synced to the network (NITZ)
    modem_atCollect("AT+CSQ", 1000);

    bool ok = g_cfg.apn == APN_AUTO ? modem_autoApn() : modem_tryApn(g_cfg.apn) == APN_OK;
    if (ok && g_cfg.apn != APN_AUTO) {
        s_apnUsed = g_cfg.apn;
        s_apnFrom = "set";
    }
    if (ok) MODEM_DEBUG.printf("[MDM] Attached, PDP active, APN \"%s\"\n", s_apnUsed.c_str());
    return ok;
}

// ── APN ─────────────────────────────────────────────────────────────────────
// g_cfg.apn is an APN set by hand (always used) or APN_AUTO. Auto: the APN
// that last worked with this SIM (ICCID) first, then the one for the
// operator name the SIM / network reports (APN_TABLE), then the rest of the
// table, then an empty APN. The one that works is saved for this SIM, so a
// new SIM is detected again. Steps are printed on TraceSerial (uploaded).
#define MODEM_ATTACH_WAIT_MS 60000UL
#define MODEM_OPERATOR_WAIT_MS 30000UL

// Registration on LTE (CEREG) or 2G (CREG): 1 registered (home or roaming),
// 0 not (yet), -1 refused by the network ("denied", stat 3).
static int modem_regState() {
    int state = 0;
    const char* cmds[] = {"AT+CEREG?", "AT+CREG?"};
    for (const char* cmd : cmds) {
        String r = modem_atCollect(cmd, 2000);
        int i = r.indexOf("REG: ");
        int comma = i == -1 ? -1 : r.indexOf(',', i);
        if (comma == -1) continue;
        int stat = r.substring(comma + 1).toInt();
        if (stat == 1 || stat == 5) return 1;
        if (stat == 3) state = -1;
    }
    return state;
}

static String modem_readIccid() {
    String r = modem_atCollect("AT+QCCID", 2000);
    int i = r.indexOf("+QCCID:");
    if (i == -1) return "";
    String id;
    for (size_t k = i + 7; k < r.length() && id.length() < 22; k++) {
        if (isAlphaNumeric(r[k])) id += r[k];
        else if (id.length()) break;
    }
    return id;
}

// The APN_TABLE entry whose name is in the SIM provider name (AT+QSPN) or the
// network name (AT+COPS?), waiting up to MODEM_OPERATOR_WAIT_MS for
// registration. -1 if no name matches.
static int modem_operatorApn() {
    uint32_t t = millis();
    while (millis() - t < MODEM_OPERATOR_WAIT_MS) {
        if (modem_regState() == 1) break;
        delay(2000);
    }
    modem_atCollect("AT+COPS=3,0", 2000);   // long alphanumeric operator name
    String names[] = {modem_atCollect("AT+QSPN", 2000), modem_atCollect("AT+COPS?", 3000)};
    for (String& n : names) {
        n.toLowerCase();
        for (size_t e = 0; e < sizeof(APNS) / sizeof(APNS[0]); e++) {
            if (n.indexOf(APNS[e].name) != -1) {
                s_operator = APNS[e].name;
                return (int)e;
            }
        }
    }
    s_operator = "";
    return -1;
}

static bool modem_waitAttach() {
    modem_atCollect("AT+CGATT=1", 10000);
    uint32_t deadline = millis() + MODEM_ATTACH_WAIT_MS;
    while ((int32_t)(deadline - millis()) > 0) {
        if (modem_atCollect("AT+CGATT?", 2000).indexOf("+CGATT: 1") != -1) return true;
        delay(2000);
    }
    return false;
}

// Attach and activate the PDP context with this APN. A different APN is
// written with the radio off (CFUN=4), so the LTE attach really uses it.
static ApnResult modem_tryApn(const String& apn) {
    String ctx = modem_atCollect("AT+CGDCONT?", 2000);
    if (ctx.indexOf("+CGDCONT: 1,\"IP\",\"" + apn + "\"") == -1) {
        modem_atCollect("AT+QIDEACT=1", 10000);
        modem_atCollect("AT+CFUN=4", 15000);
        modem_atCollect(("AT+CGDCONT=1,\"IP\",\"" + apn + "\"").c_str(), 2000);
        modem_atCollect("AT+CFUN=1", 15000);
    }
    if (!modem_waitAttach()) {
        // No coverage: another APN will not help. Refused: it may.
        bool denied = modem_regState() == -1;
        MODEM_DEBUG.printf("[MDM] ERR: not attached to packet network (%s)\n", denied ? "denied" : "no network");
        return denied ? APN_REFUSED : APN_NO_NETWORK;
    }
    if (!modem_ensurePdp()) {
        MODEM_DEBUG.println("[MDM] ERR: PDP context activation failed");
        return APN_REFUSED;
    }
    s_apnUsed = apn;
    return APN_OK;
}

static bool modem_autoApn() {
    s_iccid = modem_readIccid();
    String saved, savedSim;
    {
        Preferences p;
        p.begin(NVS_NAMESPACE, true);
        saved = p.isKey(K_APN_OK) ? p.getString(K_APN_OK, "") : String("");
        savedSim = p.getString(K_APN_SIM, "");
        p.end();
    }
    bool savedValid = saved.length() && s_iccid.length() && savedSim == s_iccid;
    // Candidates in order, without repeats; "" (empty APN) last.
    const size_t n = sizeof(APNS) / sizeof(APNS[0]);
    String list[n + 3];
    const char* from[n + 3];
    size_t count = 0;
    auto add = [&](const String& apn, const char* src) {
        for (size_t i = 0; i < count; i++) if (list[i] == apn) return;
        list[count] = apn;
        from[count++] = src;
    };
    if (savedValid) add(saved, "saved");
    int op = modem_operatorApn();
    if (op >= 0) add(APNS[op].apn, "operator");
    for (size_t e = 0; e < n; e++) add(APNS[e].apn, "fallback");
    add("", "fallback");

    for (size_t i = 0; i < count; i++) {
        ApnResult r = modem_tryApn(list[i]);
        if (r == APN_OK) {
            s_apnFrom = from[i];
            if (s_iccid.length() && (!savedValid || saved != list[i])) {
                Preferences p;
                p.begin(NVS_NAMESPACE, false);
                p.putString(K_APN_OK, list[i]);
                p.putString(K_APN_SIM, s_iccid);
                p.end();
                TraceSerial.printf("\r\n[MDM] APN \"%s\" (%s%s%s) works with SIM ...%s, saved\r\n",
                                   list[i].c_str(), from[i], s_operator.length() ? ", operator " : "",
                                   s_operator.c_str(), s_iccid.substring(s_iccid.length() > 4 ? s_iccid.length() - 4 : 0).c_str());
            }
            return true;
        }
        TraceSerial.printf("\r\n[MDM] APN \"%s\" (%s) %s\r\n", list[i].c_str(), from[i],
                           r == APN_NO_NETWORK ? "not tried further: no network" : "refused, trying the next");
        if (r == APN_NO_NETWORK) break;
    }
    s_apnUsed = "";
    return false;
}

// For GET_STATUS: "apn=<setting> apn_use=<active> apn_from=<how> operator=<name> sim=...<last 4>".
String modem_apnStatusLine() {
    String sim = s_iccid.length() > 4 ? "..." + s_iccid.substring(s_iccid.length() - 4) : String("-");
    return "apn=" + (g_cfg.apn.length() ? g_cfg.apn : String("\"\"")) +
           " apn_use=" + (g_ota.modemReady ? (s_apnUsed.length() ? s_apnUsed : String("\"\"")) : String("-")) +
           " apn_from=" + s_apnFrom + " operator=" + (s_operator.length() ? s_operator : String("-")) +
           " sim=" + sim;
}

// ── Health check and recovery ───────────────────────────────────────────────
// A module that switched itself off (supply dip, under-voltage) never answers
// AT again; only PWRKEY brings it back. MODEM_WAKE_PIN drives PWRKEY through a
// transistor (HIGH = key pressed). A pulse turns an off module on but also a
// running one off, and no STATUS pin tells which: hence up to two pulses, and
// none while the module still answers AT (then only the network is down).
#define MODEM_PWRKEY_MS        800UL
#define MODEM_BOOT_WAIT_MS     20000UL
#define MODEM_RESTART_AFTER_MS (2UL * 3600UL * 1000UL)   // then restart the ESP32

static uint32_t s_modemFailSince = 0;   // millis() since the module stays silent, 0 = it answers

static bool modem_alive(int tries) {
    for (int i = 0; i < tries; i++) {
        if (modem_atOk("AT", 1000)) return true;
    }
    return false;
}

static void modem_pwrkeyPulse() {
    digitalWrite(MODEM_WAKE_PIN, HIGH);
    delay(MODEM_PWRKEY_MS);
    digitalWrite(MODEM_WAKE_PIN, LOW);
}

// After a pulse: true once the module answers AT, false after MODEM_BOOT_WAIT_MS.
static bool modem_waitBoot() {
    uint32_t t = millis();
    while (millis() - t < MODEM_BOOT_WAIT_MS) {
        if (modem_atOk("AT", 1000)) return true;
        delay(500);
    }
    return false;
}

// Make sure the modem is up before a TCP connection; sets g_ota.modemReady.
// Steps are printed on TraceSerial so they reach the server log once the
// link is back. Readings stay queued while it fails.
bool modem_ensure() {
    //s_modemDown is checked again: modem_alive() may just have read a RDY.
    if (g_ota.modemReady && !s_modemDown && modem_alive(3) && !s_modemDown) {
        s_modemFailSince = 0;
        return true;
    }
    if (g_ota.modemReady || s_modemDown) {
        TraceSerial.print("\r\n[MDM] Modem not answering, recovering\r\n");
    }
    s_modemDown = false;
    bool ok = modem_init();
    for (int pulse = 1; !ok && pulse <= 2 && !modem_alive(3); pulse++) {
        TraceSerial.printf("\r\n[MDM] No AT response: PWRKEY pulse %d\r\n", pulse);
        modem_pwrkeyPulse();
        if (modem_waitBoot()) {
            s_modemDown = false;   // its own RDY after the pulse
            ok = modem_init();
        }
    }
    g_ota.modemReady = ok;
    if (ok) {
        if (s_modemFailSince != 0) TraceSerial.print("\r\n[MDM] Modem recovered\r\n");
        s_modemFailSince = 0;
        return true;
    }
    //A restart loses the readings queued in RAM (profile rows are read
    //again): only for a module that stays silent, not for a network outage.
    if (modem_alive(1)) {
        s_modemFailSince = 0;
        TraceSerial.print("\r\n[MDM] Modem answers but the network is not ready, readings stay queued\r\n");
        return false;
    }
    if (s_modemFailSince == 0) {
        s_modemFailSince = millis() | 1;
    } else if (millis() - s_modemFailSince > MODEM_RESTART_AFTER_MS) {
        TraceSerial.print("\r\n[MDM] Modem silent for 2 h: restarting the ESP32\r\n");
        delay(200);
        ESP.restart();
    }
    TraceSerial.print("\r\n[MDM] Modem silent, readings stay queued\r\n");
    return false;
}

// ── Network clock (AT+CCLK?) ────────────────────────────────────────────────
// Reply: +CCLK: "yy/MM/dd,hh:mm:ss±zz"  (zz = network offset, quarter hours)
// Returns UTC epoch seconds, or 0 if the module has not synced yet.
//
// The EC200U reports hh:mm:ss ALREADY IN UTC; ±zz is the network's local
// offset, informational only. Field-confirmed twice: dlms_client (2026-08,
// modem 17:09:18 vs NTP UTC 17:10:54) and here (2026-10-20, modem 14:42:01
// vs UTC 14:42:33, "+22"). Subtracting zz made every signature 5.5 h stale
// (server: timestamp_out_of_window). If a different module/firmware ever
// reports local time instead, set MODEM_CCLK_IS_UTC to 0 in config.h.
static long modem_daysFromCivil(int y, int m, int d) {
    y -= m <= 2;
    const long era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = (unsigned)(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + (long)doe - 719468;
}

uint32_t modem_epochSeconds() {
    String r = modem_atCollect("AT+CCLK?", 2000);
    int qi = r.indexOf("+CCLK: \"");
    if (qi == -1) return 0;
    int yy, MM, dd, hh, mi, ss, tzq = 0;
    if (sscanf(r.c_str() + qi + 8, "%d/%d/%d,%d:%d:%d%d", &yy, &MM, &dd, &hh, &mi, &ss, &tzq) < 6) return 0;
    if (yy < 24 || yy > 99) return 0;   // power-on default (2002/1970) -> not synced
    long days = modem_daysFromCivil(2000 + yy, MM, dd);
    long clock = days * 86400L + hh * 3600L + mi * 60L + ss;
#if MODEM_CCLK_IS_UTC
    long utc = clock;
#else
    long utc = clock - (long)tzq * 15L * 60L;
#endif
    MODEM_DEBUG.printf("[MDM] clock %02d-%02d-%02d %02d:%02d:%02d tz=%+d -> epoch %ld (UTC)\n",
                        yy, MM, dd, hh, mi, ss, tzq, utc);
    return (uint32_t)utc;
}

// ── TCP ─────────────────────────────────────────────────────────────────────
// Waits for "+QIOPEN: <id>,<err>". Returns err (0 = connected) or -999 if
// the URC never arrived.
static int modem_waitQiopen(uint32_t timeoutMs) {
    String line;
    uint32_t t = millis();
    while (millis() - t < timeoutMs) {
        if (!modem_readLine(line, 500)) continue;
        if (line.startsWith("+QIOPEN:")) {
            MODEM_DEBUG.printf("[AT]<< %s\n", line.c_str());
            int comma = line.indexOf(',');
            return comma == -1 ? -998 : line.substring(comma + 1).toInt();
        }
        if (line.indexOf("ERROR") != -1) {
            MODEM_DEBUG.printf("[AT]<< %s\n", line.c_str());
            return -997;
        }
    }
    return -999;
}

bool modem_tcpOpen(const String& host, uint16_t port) {
    uint32_t since = millis() - s_lastSocketCloseMs;
    if (s_lastSocketCloseMs && since < MODEM_QUIET_WINDOW_MS) delay(MODEM_QUIET_WINDOW_MS - since);

    for (int attempt = 0; attempt < 2; attempt++) {
        char cmd[16];
        snprintf(cmd, sizeof(cmd), "AT+QICLOSE=%d", OTA_CONNECT_ID);
        modem_atCollect(cmd, 3000);           // ERROR on a cold socket is expected
        modem_ensurePdp();
        modem_drain();

        String open = "AT+QIOPEN=1," + String(OTA_CONNECT_ID) + ",\"TCP\",\"" + host + "\"," +
                      String(port) + ",0,0";  // local port 0, buffer access mode
        MODEM_DEBUG.printf("[AT]>> %s\n", open.c_str());
        MODEM.println(open);
        int err = modem_waitQiopen(30000);
        if (err == 0) {
            MODEM_DEBUG.printf("[MDM] TCP connected to %s:%u\n", host.c_str(), port);
            return true;
        }
        MODEM_DEBUG.printf("[MDM] QIOPEN failed (err=%d)\n", err);
        if (err != -999) break;               // real rejection: don't retry
        delay(500);
    }
    return false;
}

void modem_tcpClose() {
    char cmd[16];
    snprintf(cmd, sizeof(cmd), "AT+QICLOSE=%d", OTA_CONNECT_ID);
    modem_atCollect(cmd, 5000);
    s_lastSocketCloseMs = millis();
}

bool modem_tcpSend(const uint8_t* data, size_t len) {
    size_t off = 0;
    while (off < len) {
        size_t n = min((size_t)1460, len - off);
        modem_drain();
        char cmd[32];
        snprintf(cmd, sizeof(cmd), "AT+QISEND=%d,%u", OTA_CONNECT_ID, (unsigned)n);
        MODEM.println(cmd);
        // Wait for the '>' prompt.
        bool prompt = false;
        uint32_t t = millis();
        while (!prompt && millis() - t < 5000) {
            if (MODEM.available() && MODEM.read() == '>') prompt = true;
        }
        if (!prompt) {
            MODEM_DEBUG.println("[MDM] QISEND: no '>' prompt");
            return false;
        }
        MODEM.write(data + off, n);
        String line;
        bool ok = false;
        t = millis();
        while (millis() - t < 10000) {
            if (!modem_readLine(line, 500)) continue;
            if (line.indexOf("SEND OK") != -1) { ok = true; break; }
            if (line.indexOf("SEND FAIL") != -1 || line.indexOf("ERROR") != -1) break;
        }
        if (!ok) {
            MODEM_DEBUG.printf("[MDM] QISEND failed (%s)\n", line.c_str());
            return false;
        }
        off += n;
    }
    return true;
}

// Reads up to maxLen bytes already buffered in the modem for our socket.
// Returns >0 bytes read, 0 if nothing buffered right now, -1 on AT error.
// Sets peerClosed when the modem reports the server closed the connection
// (buffered data may still remain -- keep reading until 0).
int modem_tcpRead(uint8_t* out, int maxLen, bool& peerClosed) {
    // Leftovers from the previous exchange (trailing OK, URCs): scan them
    // for a close notice instead of silently dropping it.
    String stale;
    while (MODEM.available()) stale += (char)MODEM.read();
    if (stale.indexOf("+QIURC: \"closed\"") != -1) peerClosed = true;
    char cmd[32];
    snprintf(cmd, sizeof(cmd), "AT+QIRD=%d,%d", OTA_CONNECT_ID, maxLen);
    MODEM.println(cmd);

    String line;
    int dataLen = -1;
    uint32_t t = millis();
    while (millis() - t < 5000) {
        if (!modem_readLine(line, 500)) continue;
        if (line.indexOf("+QIURC: \"closed\"") != -1) { peerClosed = true; continue; }
        if (line.startsWith("+QIRD:")) { dataLen = line.substring(6).toInt(); break; }
        if (line.indexOf("ERROR") != -1) return -1;
    }
    if (dataLen < 0) return -1;
    if (dataLen > maxLen) dataLen = maxLen;

    int got = 0;
    t = millis();
    while (got < dataLen && millis() - t < 10000) {
        int avail = MODEM.available();
        if (avail <= 0) { delay(1); continue; }
        got += MODEM.readBytes(out + got, min(avail, dataLen - got));
        t = millis();
    }
    if (got < dataLen) {
        MODEM_DEBUG.printf("[MDM] QIRD short read %d/%d\n", got, dataLen);
        return -1;
    }
    // Consume the trailing "\r\nOK\r\n" (and note a close URC if it rides along).
    t = millis();
    while (millis() - t < 2000) {
        if (!modem_readLine(line, 300)) continue;
        if (line.indexOf("+QIURC: \"closed\"") != -1) peerClosed = true;
        if (line == "OK") break;
    }
    return got;
}

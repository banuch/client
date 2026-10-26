// =============================================================================
//  meter_password.ino  --  list of meter LLS passwords, find the one that works
//
//  The list comes from NVS (METER_PW ADD/DEL, commands.ino) or, until it is
//  changed there, from METER_PASSWORDS_DEFAULT (config.h). The password the
//  meter last accepted is saved (K_MPW_OK) and used first on every cycle.
//
//  When the meter rejects it (AARE refused, not a link error), mpw_search()
//  tries the other passwords once each, closing the link between tries.
//  Meters may lock the port after repeated wrong passwords, so a search runs
//  at most every MPW_SEARCH_GAP_S unless forced (METER_PW DETECT, BLE "read
//  now"). Passwords are never printed in full -- the trace is uploaded.
// =============================================================================
#include <Preferences.h>

static String   s_mpw[MPW_MAX];
static uint8_t  s_mpwCount = 0;
static int      s_mpwActive = 0;          // index used for the next AARQ
static bool     s_mpwMatched = false;     // s_mpwActive was accepted by the meter
static bool     s_mpwSearched = false;    // a search ran since boot
static uint32_t s_mpwSearchMs = 0;        // millis() of the last search
static bool     s_mpwForce = false;

// "H***o": first and last character, length hidden.
String mpw_mask(const String& pw) {
    if (pw.length() < 3) return "***";
    return String(pw[0]) + "***" + pw[pw.length() - 1];
}

static void mpw_apply(int i) {
    s_mpwActive = i;
    const String& pw = s_mpw[i];
    Client.SetPassword((const unsigned char*)pw.c_str(), (uint16_t)pw.length());
}

static void mpw_saveList() {
    Preferences p;
    p.begin(NVS_NAMESPACE, false);
    p.putUChar(K_MPW_COUNT, s_mpwCount);
    for (uint8_t i = 0; i < MPW_MAX; i++) {
        String k = String(K_MPW_PREFIX) + i;
        if (i < s_mpwCount) p.putString(k.c_str(), s_mpw[i]);
        else p.remove(k.c_str());
    }
    p.end();
}

static void mpw_saveMatch() {
    Preferences p;
    p.begin(NVS_NAMESPACE, false);
    if (s_mpwMatched) p.putString(K_MPW_OK, s_mpw[s_mpwActive]);
    else p.remove(K_MPW_OK);
    p.end();
}

static void mpw_loadDefaults() {
    static const char* const DEFAULTS[] = METER_PASSWORDS_DEFAULT;
    s_mpwCount = 0;
    for (size_t i = 0; i < sizeof(DEFAULTS) / sizeof(DEFAULTS[0]) && s_mpwCount < MPW_MAX; i++) {
        s_mpw[s_mpwCount++] = DEFAULTS[i];
    }
}

// Load the list and the saved match, and give the client the password to use.
void mpw_begin() {
    Preferences p;
    p.begin(NVS_NAMESPACE, true);
    uint8_t n = p.getUChar(K_MPW_COUNT, 0);
    String ok = p.getString(K_MPW_OK, "");
    if (n > 0 && n <= MPW_MAX) {
        s_mpwCount = 0;
        for (uint8_t i = 0; i < n; i++) {
            String pw = p.getString((String(K_MPW_PREFIX) + i).c_str(), "");
            if (pw.length()) s_mpw[s_mpwCount++] = pw;
        }
    }
    p.end();
    if (s_mpwCount == 0) mpw_loadDefaults();

    int use = 0;
    s_mpwMatched = false;
    for (uint8_t i = 0; ok.length() && i < s_mpwCount; i++) {
        if (s_mpw[i] == ok) { use = i; s_mpwMatched = true; break; }
    }
    mpw_apply(use);
    TraceLog.printf("[METER] %u password(s), using #%d %s%s\r\n", s_mpwCount, use + 1,
                    mpw_mask(s_mpw[use]).c_str(), s_mpwMatched ? " (accepted before)" : "");
}

// Errors from the AARE that mean the meter refused the association, as a
// wrong password does. Link errors (no meter, cable) never start a search.
bool mpw_isRejected(int ret) {
    return ret == DLMS_ERROR_CODE_AUTHENTICATION_FAILURE ||
           ret == DLMS_ERROR_CODE_AUTHENTICATION_REQUIRED ||
           ret == DLMS_ERROR_CODE_REJECTED_PERMAMENT ||
           ret == DLMS_ERROR_CODE_REJECTED_TRANSIENT ||
           ret == DLMS_ERROR_CODE_NO_REASON_GIVEN;
}

bool mpw_searchAllowed() {
    if (s_mpwCount < 2) return false;
    return s_mpwForce || !s_mpwSearched || millis() - s_mpwSearchMs >= MPW_SEARCH_GAP_S * 1000UL;
}

void mpw_forceSearch() { s_mpwForce = true; }

// Called after a successful association with the current password.
void mpw_accepted() {
    s_mpwForce = false;
    if (s_mpwMatched) return;
    s_mpwMatched = true;
    mpw_saveMatch();
    TraceLog.printf("[METER] password #%d %s accepted, saved\r\n", s_mpwActive + 1,
                    mpw_mask(s_mpw[s_mpwActive]).c_str());
}

// The current password was refused: try the others once each. On success the
// association is open and the password is saved. Otherwise the previous
// password stays selected and the last error is returned.
int mpw_search() {
    int start = s_mpwActive;
    int ret = DLMS_ERROR_CODE_AUTHENTICATION_FAILURE;
    s_mpwMatched = false;   // refused now; NVS keeps it in case that was transient
    s_mpwSearched = true;
    s_mpwSearchMs = millis();
    s_mpwForce = false;
    TraceLog.printf("[METER] password #%d refused, trying the other %u\r\n", start + 1, s_mpwCount - 1);
    for (int i = 0; i < s_mpwCount; i++) {
        if (i == start) continue;
        com_close();
        delay(RECONNECT_DELAY_MS);
        mpw_apply(i);
        TraceLog.printf("[METER] trying password #%d %s\r\n", i + 1, mpw_mask(s_mpw[i]).c_str());
        ret = com_initializeConnection();
        if (ret == DLMS_ERROR_CODE_OK) {
            mpw_accepted();
            return ret;
        }
        if (isLinkError(ret)) {
            TraceLog.printf("[METER] meter stopped answering (%d), search stopped\r\n", ret);
            break;
        }
    }
    mpw_apply(start);
    TraceLog.printf("[METER] no password matched; next search in %lu h unless METER_PW DETECT\r\n",
                    (unsigned long)(MPW_SEARCH_GAP_S / 3600UL));
    return ret;
}

// ── Commands (commands.ino) ─────────────────────────────────────────────────
void mpw_list(Print& out) {
    for (uint8_t i = 0; i < s_mpwCount; i++) {
        out.printf("%u. %s%s\n", i + 1, mpw_mask(s_mpw[i]).c_str(),
                   i == s_mpwActive ? (s_mpwMatched ? "  <- in use, accepted" : "  <- in use, not confirmed") : "");
    }
}

// Returns "" on success, else an error message.
String mpw_add(const String& pw) {
    if (pw.isEmpty() || pw.length() > MPW_LEN_MAX) return "password must be 1.." + String(MPW_LEN_MAX) + " characters";
    for (size_t i = 0; i < pw.length(); i++) {
        if (pw[i] < 0x21 || pw[i] > 0x7e) return "printable ASCII only, no spaces";
    }
    if (s_mpwCount >= MPW_MAX) return "list full (" + String(MPW_MAX) + "), delete one first";
    for (uint8_t i = 0; i < s_mpwCount; i++) {
        if (s_mpw[i] == pw) return "already in the list as #" + String(i + 1);
    }
    s_mpw[s_mpwCount++] = pw;
    mpw_saveList();
    return "";
}

String mpw_delete(long n) {
    if (n < 1 || n > s_mpwCount) return "no password #" + String(n);
    if (s_mpwCount == 1) return "the last password cannot be deleted (use METER_PW CLEAR for the defaults)";
    int idx = (int)n - 1;
    for (uint8_t i = idx; i + 1 < s_mpwCount; i++) s_mpw[i] = s_mpw[i + 1];
    s_mpwCount--;
    mpw_saveList();
    if (idx == s_mpwActive) {
        s_mpwMatched = false;
        mpw_saveMatch();
        mpw_apply(0);
    } else {
        mpw_apply(idx < s_mpwActive ? s_mpwActive - 1 : s_mpwActive);
    }
    return "";
}

// Back to METER_PASSWORDS_DEFAULT and no saved match.
void mpw_clear() {
    Preferences p;
    p.begin(NVS_NAMESPACE, false);
    p.remove(K_MPW_COUNT);
    for (uint8_t i = 0; i < MPW_MAX; i++) p.remove((String(K_MPW_PREFIX) + i).c_str());
    p.remove(K_MPW_OK);
    p.end();
    mpw_loadDefaults();
    s_mpwMatched = false;
    mpw_apply(0);
}

// Forget the match and walk the list from #1 on the next cycle.
void mpw_detect() {
    s_mpwMatched = false;
    mpw_saveMatch();
    mpw_apply(0);
    mpw_forceSearch();
}

String mpw_statusLine() {
    String s = "meter_pw=#" + String(s_mpwActive + 1) + "/" + String(s_mpwCount) +
               (s_mpwMatched ? " accepted" : " not confirmed");
    if (s_mpwForce) s += " search=next cycle";
    else if (s_mpwSearched && s_mpwCount > 1 && !mpw_searchAllowed()) {
        uint32_t leftS = MPW_SEARCH_GAP_S - (millis() - s_mpwSearchMs) / 1000UL;
        s += " next_search_in=" + String(leftS / 60UL) + "min";
    }
    return s;
}

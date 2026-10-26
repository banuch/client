#ifndef ARDUINO_IGNORE_H
#define ARDUINO_IGNORE_H

#ifdef __cplusplus
extern "C" {
#endif

// =============================================================================
//  ArduinoIgnore.h  --  Gurux DLMS compile-time object set configuration
//  mri_client (Universal MRI)
//
//  Identical to client reference — same object classes needed for multi-vendor.
// =============================================================================

#define GX_DLMS_MICROCONTROLLER
#define DLMS_USE_EPOCH_TIME

// ── Communication ─────────────────────────────────────────────────────────────
// #define DLMS_IGNORE_HDLC
// #define DLMS_IGNORE_WRAPPER
#define DLMS_IGNORE_PLC

// ── Client-only ───────────────────────────────────────────────────────────────
#define DLMS_IGNORE_SERVER
#define DLMS_IGNORE_NOTIFY

// ── Security ─────────────────────────────────────────────────────────────────
// #define DLMS_IGNORE_AES
// #define DLMS_IGNORE_HIGH_GMAC
#define DLMS_IGNORE_HIGH_SHA1
#define DLMS_IGNORE_HIGH_SHA256
#define DLMS_IGNORE_HIGH_MD5

// ── Required object classes ───────────────────────────────────────────────────
// Data (IC 1), Register (IC 3), Extended Register (IC 4),
// Demand Register (IC 5), Profile Generic (IC 7), Clock (IC 8),
// Association LN (IC 15) — all enabled (not #defined IGNORE)

// ── Disabled object classes ───────────────────────────────────────────────────
#define DLMS_IGNORE_REGISTER_ACTIVATION
#define DLMS_IGNORE_SCRIPT_TABLE
#define DLMS_IGNORE_SCHEDULE
#define DLMS_IGNORE_SPECIAL_DAYS_TABLE
#define DLMS_IGNORE_ASSOCIATION_SHORT_NAME
#define DLMS_IGNORE_SAP_ASSIGNMENT
#define DLMS_IGNORE_IMAGE_TRANSFER
#define DLMS_IGNORE_IEC_LOCAL_PORT_SETUP
#define DLMS_IGNORE_ACTIVITY_CALENDAR
#define DLMS_IGNORE_REGISTER_MONITOR
#define DLMS_IGNORE_ACTION_SCHEDULE
#define DLMS_IGNORE_IEC_HDLC_SETUP
#define DLMS_IGNORE_IEC_TWISTED_PAIR_SETUP
#define DLMS_IGNORE_MBUS_SLAVE_PORT_SETUP
#define DLMS_IGNORE_UTILITY_TABLES
#define DLMS_IGNORE_MODEM_CONFIGURATION
#define DLMS_IGNORE_AUTO_ANSWER
#define DLMS_IGNORE_AUTO_CONNECT
#define DLMS_IGNORE_TCP_UDP_SETUP
#define DLMS_IGNORE_IP4_SETUP
#define DLMS_IGNORE_IP6_SETUP
#define DLMS_IGNORE_MAC_ADDRESS_SETUP
#define DLMS_IGNORE_PPP_SETUP
#define DLMS_IGNORE_GPRS_SETUP
#define DLMS_IGNORE_SMTP_SETUP
#define DLMS_IGNORE_GSM_DIAGNOSTIC
#define DLMS_IGNORE_REGISTER_TABLE
#define DLMS_IGNORE_STATUS_MAPPING
#define DLMS_IGNORE_SECURITY_SETUP
#define DLMS_IGNORE_DISCONNECT_CONTROL
#define DLMS_IGNORE_LIMITER
#define DLMS_IGNORE_MBUS_CLIENT
#define DLMS_IGNORE_PUSH_SETUP
#define DLMS_IGNORE_PARAMETER_MONITOR
#define DLMS_IGNORE_WIRELESS_MODE_Q_CHANNEL
#define DLMS_IGNORE_MBUS_MASTER_PORT_SETUP
#define DLMS_IGNORE_ZIG_BEE_SAS_STARTUP
#define DLMS_IGNORE_ZIG_BEE_SAS_JOIN
#define DLMS_IGNORE_ZIG_BEE_SAS_APS_FRAGMENTATION
#define DLMS_IGNORE_ZIG_BEE_NETWORK_CONTROL
#define DLMS_IGNORE_DATA_PROTECTION
#define DLMS_IGNORE_ACCOUNT
#define DLMS_IGNORE_CREDIT
#define DLMS_IGNORE_CHARGE
#define DLMS_IGNORE_TOKEN_GATEWAY
#define DLMS_IGNORE_COMPACT_DATA
#define DLMS_IGNORE_LLC_SSCS_SETUP
#define DLMS_IGNORE_PRIME_NB_OFDM_PLC_PHYSICAL_LAYER_COUNTERS
#define DLMS_IGNORE_PRIME_NB_OFDM_PLC_MAC_SETUP
#define DLMS_IGNORE_PRIME_NB_OFDM_PLC_MAC_FUNCTIONAL_PARAMETERS
#define DLMS_IGNORE_PRIME_NB_OFDM_PLC_MAC_COUNTERS
#define DLMS_IGNORE_PRIME_NB_OFDM_PLC_MAC_NETWORK_ADMINISTRATION_DATA
#define DLMS_IGNORE_PRIME_NB_OFDM_PLC_APPLICATIONS_IDENTIFICATION
#define DLMS_IGNORE_ARBITRATOR
#define DLMS_IGNORE_SERIALIZER

// ── Data types ────────────────────────────────────────────────────────────────
#define DLMS_IGNORE_FLOAT64
// #define DLMS_IGNORE_FLOAT32

#ifdef __cplusplus
}
#endif

#endif // ARDUINO_IGNORE_H

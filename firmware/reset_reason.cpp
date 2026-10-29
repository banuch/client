#include <esp_system.h>
#include "reset_reason.h"

//Brown-out = supply voltage dip: the usual cause of field restarts.
const char* resetReasonText()
{
  switch (esp_reset_reason())
  {
    case ESP_RST_POWERON:   return "power on";
    case ESP_RST_EXT:       return "external reset pin";
    case ESP_RST_SW:        return "software restart (OTA, REBOOT or modem recovery)";
    case ESP_RST_PANIC:     return "crash (exception or panic)";
    case ESP_RST_INT_WDT:   return "interrupt watchdog";
    case ESP_RST_TASK_WDT:  return "task watchdog";
    case ESP_RST_WDT:       return "other watchdog";
    case ESP_RST_DEEPSLEEP: return "wake from deep sleep";
    case ESP_RST_BROWNOUT:  return "brown-out (supply voltage dip)";
    case ESP_RST_SDIO:      return "SDIO";
    default:                return "unknown";
  }
}

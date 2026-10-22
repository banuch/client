
//
// --------------------------------------------------------------------------
//  Gurux Ltd
//
//
//
//
// Version:         $Revision: 10346 $,
//                  $Date: 2018-10-29 16:08:18 +0200 (Mon, 29 Oct 2018) $
//                  $Author: gurux01 $
//
// Copyright (c) Gurux Ltd
//
//---------------------------------------------------------------------------
//
//  DESCRIPTION
//
// This file is a part of Gurux Device Framework.
//
// Gurux Device Framework is Open Source software; you can redistribute it
// and/or modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; version 2 of the License.
// Gurux Device Framework is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
// See the GNU General Public License for more details.
//
// More information of Gurux DLMS/COSEM Director: http://www.gurux.org/GXDLMSDirector
//
// This code is licensed under the GNU General Public License v2.
// Full text may be retrieved at http://www.gnu.org/licenses/gpl-2.0.txt
//---------------------------------------------------------------------------
#include "config.h"
#include <EEPROM.h>
#include <HardwareSerial.h>
#include <esp_ota_ops.h>
#include "GXDLMSClient.h"
#include "include/dlms.h"
#include "obis_names.h"
#include "ble_meter.h"
#include "trace_tee.h"

#if !defined(ARDUINO_ARCH_ESP32)
#error "This sketch is configured for ESP32-S3. Select an ESP32-S3 board."
#endif

// ── Meter UART pins (fixed hardware) ───────────────────────────────────────
#define RXD1_DEFAULT      5
#define TXD1_DEFAULT      4
#define DTR_PIN_DEFAULT   6

// MAX3232 inverts the signal: GPIO LOW -> RS-232 +V = DTR asserted (ON).
// Same as the working dlms_client: idle HIGH, driven LOW before connecting.
#define DTR_ACTIVE_LEVEL  LOW
#define DTR_WAKE_MS       100

// Meter settings (same defaults as the working dlms_client project).
#define METER_BAUD            9600
#define METER_CLIENT_ADDRESS  32   // 0x20 = HPL / IS-15959 meter reader (LLS)
#define METER_SERVER_LOGICAL  1
#define METER_SERVER_PHYSICAL 0    // 0 = not used. Some meters need e.g. 1, 16 or 256.
#define METER_AUTH            DLMS_AUTHENTICATION_LOW
#define METER_PASSWORD        "Hello"
#define METER_RX_BUFFER_SIZE  2048

// Time between meter readings (start to start). Default as in dlms_client.
// The first reading is done right after boot.
#define READ_INTERVAL_MS      (300UL * 1000UL)   // 300 s = 5 min

// 1 = print every sent/received HDLC frame in hex.
#define METER_TRACE_FRAMES    0

// Log upload, EC200U modem and OTA settings are in config.h.

// 1 = run a loopback test instead of talking to the meter.
//     Short RS-232 pins 2 and 3 on the meter-side connector before enabling.
#define METER_LOOPBACK_TEST   0

// One association view entry. Declared here so the Arduino-generated
// prototypes can use it.
typedef struct
{
  uint16_t classId;
  unsigned char version;
  unsigned char ln[6];
  signed char scaler;
  unsigned char unit;
  unsigned char scalerRead;
} AvEntry;

// One capture column of a profile generic (see profiles.ino). e holds the
// class, logical name and the scaler/unit used to format the cells.
typedef struct
{
  AvEntry e;
  signed char attr;
  uint16_t dataIndex;
} PgColumn;

// Emulated EEPROM size in flash (ESP32 has no real EEPROM).
#define EEPROM_SIZE_BYTES 4096

// Meter is connected to UART1 on the pins above.
HardwareSerial MeterSerial(1);
// Trace/debug output goes to USB (Serial) on ESP32-S3 and into the log
// bridge buffer (trace_tee.h).
#define TraceSerial TraceLog
//---------------------------------------------------------------------------
// Un-comment ignored objects from ArduinoIgnore.h to improve performance
// and memory usage.
//---------------------------------------------------------------------------

//Received data.
gxByteBuffer frameData;

//How long reply is waited from the meter.
const uint32_t WAIT_TIME = 10000;
//How many times message is try to resend to the meter.
const uint8_t RESEND_COUNT = 3;
//How many times the association (SNRM + AARQ) is tried per cycle.
const int CONNECT_RETRY = 3;
const uint32_t RECONNECT_DELAY_MS = 1500;


uint16_t EEPROM_SIZE()
{
  return EEPROM.length();
}

int EEPROM_READ(uint16_t index, unsigned char* value)
{
  *value = EEPROM.read(index);
  return 0;
}

int EEPROM_WRITE(uint16_t index, unsigned char value)
{
  EEPROM.write(index, value);
  return 0;
}

//ESP32 EEPROM is emulated in flash. Call this after all writes are done.
void EEPROM_COMMIT()
{
  EEPROM.commit();
}

//(Re)open the meter UART. Pins must be passed every time on ESP32.
void meter_begin(unsigned long baudRate, uint32_t config)
{
  MeterSerial.end();
  //Default 256 byte buffer is too small for long replies. Set before begin().
  MeterSerial.setRxBufferSize(METER_RX_BUFFER_SIZE);
  MeterSerial.begin(baudRate, config, RXD1_DEFAULT, TXD1_DEFAULT);
  MeterSerial.setTimeout(WAIT_TIME);
}

///////////////////////////////////////////////////////////////////////
// Write trace to the serial port.
//
// This can be used for debugging.
///////////////////////////////////////////////////////////////////////
void GXTRACE(const char* str, const char* data)
{
  //Send trace to the serial port.
  byte c;
  if (str != NULL)
  {
    TraceSerial.write("\r\n:");
    while ((c = pgm_read_byte(str++)) != 0)
    {
      TraceSerial.write(c);
    }
  }
  if (data != NULL)
  {
    TraceSerial.write(data);
  }
  if (str != NULL)
  {
    TraceSerial.write("\0");
  }
  delay(10);
}


///////////////////////////////////////////////////////////////////////
// Write trace to the serial port.
//
// This can be used for debugging.
///////////////////////////////////////////////////////////////////////
void GXTRACE_INT(const char* str, int32_t value)
{
  char data[16];
  snprintf(data, sizeof(data), " %ld", (long)value);
  GXTRACE(str, data);
}


///////////////////////////////////////////////////////////////////////
// Write trace to the serial port.
//
// This can be used for debugging.
///////////////////////////////////////////////////////////////////////
void GXTRACE_BB(const char* str, gxByteBuffer* value)
{
  int pos;
  char data[4];
  GXTRACE(str, NULL);
  for (pos = 0; pos < bb_size(value); ++pos)
  {
    sprintf(data, "%02X ", value->data[pos]);
    GXTRACE(NULL, data);
  }
  TraceSerial.write("\0");
}

uint32_t runTime = 0;

///////////////////////////////////////////////////////////////////////
//Returns the approximate processor time in ms.
///////////////////////////////////////////////////////////////////////
uint32_t time_elapsed(void)
{
  return millis();
}

///////////////////////////////////////////////////////////////////////
// Returns current time.
// Get current time.
// Because there is no clock, clock object keeps base time and uptime is added to that.
///////////////////////////////////////////////////////////////////////
void time_now(gxtime* value)
{
  time_addSeconds(value, time_elapsed() / 1000);
}

int com_readSerialPort(
  unsigned char eop)
{
  //Read reply data. Same logic as the working dlms_client (DLMSTransport::readUntil).
  uint32_t pos;
  int available;
  unsigned char eopFound = 0;
  uint32_t lastReadIndex = frameData.position;
  uint32_t start = millis();
  do
  {
    available = MeterSerial.available();
    if (available > 0)
    {
      if (frameData.size + available > frameData.capacity)
      {
        bb_capacity(&frameData, 20 + frameData.size + available);
      }
      size_t got = MeterSerial.readBytes((char*) (frameData.data + frameData.size), available);
      frameData.size += got;
      if (got == 0)
      {
        delay(10);
      }
      //Search eop.
      else if (frameData.size > 5)
      {
        for (pos = frameData.size - 1; pos > lastReadIndex; --pos)
        {
          if (frameData.data[pos] == eop)
          {
            eopFound = 1;
            break;
          }
        }
        lastReadIndex = frameData.size - 1;
      }
    }
    else
    {
      delay(10);
    }
    //If the meter doesn't reply in given time.
    if (!(millis() - start < WAIT_TIME))
    {
      GXTRACE_INT(GET_STR_FROM_EEPROM("Received bytes: \n"), frameData.size);
#if METER_TRACE_FRAMES
      if (frameData.size != 0)
      {
        GXTRACE_BB(GET_STR_FROM_EEPROM("RX (incomplete):"), &frameData);
      }
#endif
      return DLMS_ERROR_CODE_RECEIVE_FAILED;
    }
  } while (eopFound == 0);
  return DLMS_ERROR_CODE_OK;
}

// Read DLMS Data frame from the device.
int readDLMSPacket(
  gxByteBuffer* data,
  gxReplyData* reply)
{
  int resend = 0, ret = DLMS_ERROR_CODE_OK;
  if (data->size == 0)
  {
    return DLMS_ERROR_CODE_OK;
  }
  reply->complete = 0;
  frameData.size = 0;
  frameData.position = 0;
#if METER_TRACE_FRAMES
  GXTRACE_BB(GET_STR_FROM_EEPROM("TX:"), data);
#endif
  //Discard old bytes so they are not mixed with the reply.
  while (MeterSerial.available())
  {
    MeterSerial.read();
  }
  //Send data.
  if ((ret = MeterSerial.write(data->data, data->size)) != data->size)
  {
    //If failed to write all bytes.
    GXTRACE(GET_STR_FROM_EEPROM("Failed to write all data to the serial port.\n"), NULL);
  }
  //Hard deadline for the whole exchange. A stream of corrupted/echoed frames
  //would otherwise keep this loop running forever.
  uint32_t deadline = millis() + WAIT_TIME * (uint32_t)(RESEND_COUNT + 2);
  //Loop until packet is complete.
  do
  {
    if ((int32_t)(millis() - deadline) >= 0)
    {
      GXTRACE(GET_STR_FROM_EEPROM("Exchange deadline exceeded."), NULL);
      return DLMS_ERROR_CODE_RECEIVE_FAILED;
    }
    if ((ret = com_readSerialPort(0x7E)) != 0)
    {
      if (resend >= RESEND_COUNT)
      {
        return DLMS_ERROR_CODE_SEND_FAILED;
      }
      ++resend;
      GXTRACE_INT(GET_STR_FROM_EEPROM("Data send failed. Try to resend."), resend);
      frameData.size = 0;
      frameData.position = 0;
      while (MeterSerial.available())
      {
        MeterSerial.read();
      }
      if ((ret = MeterSerial.write(data->data, data->size)) != data->size)
      {
        //If failed to write all bytes.
        GXTRACE(GET_STR_FROM_EEPROM("Failed to write all data to the serial port.\n"), NULL);
      }
      continue;
    }
#if METER_TRACE_FRAMES
    GXTRACE_BB(GET_STR_FROM_EEPROM("RX:"), &frameData);
#endif
    ret = Client.GetData(&frameData, reply);
    if (ret != 0 && ret != DLMS_ERROR_CODE_FALSE)
    {
      break;
    }
  } while (reply->complete == 0);
  return ret;
}

int com_readDataBlock(
  message* messages,
  gxReplyData* reply)
{
  gxByteBuffer rr;
  int pos, ret = DLMS_ERROR_CODE_OK;
  //If there is no data to send.
  if (messages->size == 0)
  {
    return DLMS_ERROR_CODE_OK;
  }
  BYTE_BUFFER_INIT(&rr);
  //Send data.
  for (pos = 0; pos != messages->size; ++pos)
  {
    //Send data.
    if ((ret = readDLMSPacket(messages->data[pos], reply)) != DLMS_ERROR_CODE_OK)
    {
      return ret;
    }
    //Check is there errors or more data from server
    while (reply_isMoreData(reply))
    {
      if ((ret = Client.ReceiverReady(reply->moreData, &rr)) != DLMS_ERROR_CODE_OK)
      {
        bb_clear(&rr);
        return ret;
      }
      if ((ret = readDLMSPacket(&rr, reply)) != DLMS_ERROR_CODE_OK)
      {
        bb_clear(&rr);
        return ret;
      }
      bb_clear(&rr);
    }
  }
  return ret;
}

//Close connection to the meter.
int com_close()
{
  int ret = DLMS_ERROR_CODE_OK;
  gxReplyData reply;
  message msg;
  reply_init(&reply);
  mes_init(&msg);
  //Like the working dlms_client: send only DISC. Some meters never answer
  //the Release request, which would cost a full timeout on every close.
  if ((ret = Client.DisconnectRequest(&msg)) != 0 ||
      (ret = com_readDataBlock(&msg, &reply)) != 0)
  {
    //Show error but continue close.
  }
  reply_clear(&reply);
  mes_clear(&msg);
  return ret;
}

//Read Invocation counter (frame counter) from the meter and update it.
int com_updateInvocationCounter(const char* invocationCounter)
{
  int ret = DLMS_ERROR_CODE_OK;
  //Read frame counter if security is used.
  if (invocationCounter != NULL && Client.GetSecurity() != DLMS_SECURITY_NONE)
  {
    uint32_t ic = 0;
    message messages;
    gxReplyData reply;
    unsigned short add = Client.GetClientAddress();
    DLMS_AUTHENTICATION auth = Client.GetAuthentication();
    DLMS_SECURITY security = Client.GetSecurity();
    Client.SetClientAddress(16);
    Client.SetAuthentication(DLMS_AUTHENTICATION_NONE);
    Client.SetSecurity(DLMS_SECURITY_NONE);
    if ((ret = com_initializeConnection()) == DLMS_ERROR_CODE_OK)
    {
      gxData d;
      cosem_init(BASE(d), DLMS_OBJECT_TYPE_DATA, invocationCounter);
      if ((ret = com_read(BASE(d), 2)) == 0)
      {
        GXTRACE_INT(GET_STR_FROM_EEPROM("Invocation Counter:"), var_toInteger(&d.value));
        ic = 1 + var_toInteger(&d.value);
      }
      obj_clear(BASE(d));
    }
    //Close connection. It's OK if this fails.
    com_close();
    //Return original settings.
    Client.SetClientAddress(add);
    Client.SetAuthentication(auth);
    Client.SetSecurity(security);
    Client.SetInvocationCounter(ic);
  }
  return ret;
}

int com_initializeOpticalHead()
{
  int baudRate;
  if (Client.GetInterfaceType() == DLMS_INTERFACE_TYPE_HDLC_WITH_MODE_E)
  {
    // Optical probes work with 300 bps 7E1:
    meter_begin(300, SERIAL_7E1);
    static char DATA[6] = "/?!\r\n";
    //Send data.
    if (MeterSerial.write(DATA, sizeof(DATA)) != sizeof(DATA))
    {
      //If failed to write all bytes.
      GXTRACE(GET_STR_FROM_EEPROM("Failed to write all data to the serial port.\n"), NULL);
    }
    String data = MeterSerial.readStringUntil('\n');
    if (data.length() < 5 || data[0] != '/')
    {
      GXTRACE(GET_STR_FROM_EEPROM("Failed to to receive IEC reply from serial port.\n"), NULL);
      return DLMS_ERROR_CODE_SEND_FAILED;
    }
    //Get used baud rate.
    switch (data[4])
    {
      case '0':
        baudRate = 300;
        break;
      case '1':
        baudRate = 600;
        break;
      case '2':
        baudRate = 1200;
        break;
      case '3':
        baudRate = 2400;
        break;
      case '4':
        baudRate = 4800;
        break;
      case '5':
        baudRate = 9600;
        break;
      case '6':
        baudRate = 19200;
        break;
      default:
        return DLMS_ERROR_CODE_INVALID_PARAMETER;
    }
    //Send ACK
    unsigned char buff[6];
    buff[0] = 0x06;
    //Send Protocol control character
    buff[1] = '2';// "2" HDLC protocol procedure (Mode E)
    buff[2] = (unsigned char)data[4];
    buff[3] = '2';
    buff[4] = (char)0x0D;
    buff[5] = 0x0A;
    if (MeterSerial.write(buff, sizeof(buff)) != sizeof(buff))
    {
      //If failed to write all bytes.
      GXTRACE(GET_STR_FROM_EEPROM("Failed to write all data to the serial port.\n"), NULL);
    }
    MeterSerial.flush();
    //This sleep is in standard. Do not remove.
    delay(300);
    meter_begin(baudRate, SERIAL_8N1);
    MeterSerial.readBytes(buff, sizeof(buff));
    //Some meters need this sleep. Do not remove.
    delay(800);
  }
  return 0;
}

//Initialize connection to the meter.
int com_initializeConnection()
{
  int ret = DLMS_ERROR_CODE_OK;
  message messages;
  gxReplyData reply;
  mes_init(&messages);
  reply_init(&reply);

  //Assert DTR and give the meter port time to wake up. DTR stays asserted.
  digitalWrite(DTR_PIN_DEFAULT, DTR_ACTIVE_LEVEL);
  delay(DTR_WAKE_MS);

#ifndef DLMS_IGNORE_HDLC
  //Get meter's send and receive buffers size.
  if ((ret = com_initializeOpticalHead()) != 0 ||
      (ret = Client.SnrmRequest(&messages)) != 0 ||
      (ret = com_readDataBlock(&messages, &reply)) != 0 ||
      (ret = Client.ParseUAResponse(&reply.data)) != 0)
  {
    mes_clear(&messages);
    reply_clear(&reply);
    return ret;
  }
  mes_clear(&messages);
  reply_clear(&reply);
#endif //DLMS_IGNORE_HDLC

  if ((ret = Client.AarqRequest(&messages)) != 0 ||
      (ret = com_readDataBlock(&messages, &reply)) != 0 ||
      (ret = Client.ParseAAREResponse(&reply.data)) != 0)
  {
    mes_clear(&messages);
    reply_clear(&reply);
    if (ret == DLMS_ERROR_CODE_APPLICATION_CONTEXT_NAME_NOT_SUPPORTED)
    {
      return ret;
    }
    return ret;
  }
  mes_clear(&messages);
  reply_clear(&reply);
  // Get challenge Is HLS authentication is used.
  if (Client.GetAuthentication() > DLMS_AUTHENTICATION_LOW)
  {
    if ((ret = Client.GetApplicationAssociationRequest(&messages)) != 0 ||
        (ret = com_readDataBlock(&messages, &reply)) != 0 ||
        (ret = Client.ParseApplicationAssociationResponse(&reply.data)) != 0)
    {
      mes_clear(&messages);
      reply_clear(&reply);
      return ret;
    }
    mes_clear(&messages);
    reply_clear(&reply);
  }
  return DLMS_ERROR_CODE_OK;
}

//Get Association view.
int com_getAssociationView()
{
  int ret;
  message data;
  gxReplyData reply;
  mes_init(&data);
  reply_init(&reply);
  if ((ret = Client.GetObjectsRequest(&data)) != 0 ||
      (ret = com_readDataBlock(&data, &reply)) != 0 ||
      (ret = Client.ParseObjects(&reply.data)) != 0)
  {
  }
  //Parse object one at the time. This can be used if there is a limited amount of the memory available.
  /*
    //Value is not parsed for decrease the memory usage.
    reply.ignoreValue = 1;
    if ((ret = Client.GetObjectsRequest(&data)) == 0 &&
      (ret = com_readDataBlock(&data, &reply)) == 0)
    {
    uint16_t pos, count;
    if ((ret = Client.ParseObjectCount(&reply.data, &count)) != 0)
    {
      GXTRACE_INT("cl_parseObjectCount failed", ret);
    }
    gxObject obj;
    for (pos = 0; pos != count; ++pos)
    {
      memset(&obj, 0, sizeof(gxObject));
      if ((ret = Client.ParseNextObject(&reply.data, &obj)) != 0)
      {
        break;
      }
      //Only data and register objects are added to the association view.
      if (obj.objectType == DLMS_OBJECT_TYPE_DATA)
      {
        gxData* data = (gxData*) malloc(sizeof(gxData));
        INIT_OBJECT((*data), (DLMS_OBJECT_TYPE) obj.objectType, obj.logicalName);
        data->base.shortName = obj.shortName;
        oa_push(Client.GetObjects(), BASE((*data)));
      }
      else if (obj.objectType == DLMS_OBJECT_TYPE_REGISTER)
      {
        gxRegister* r = (gxRegister*) malloc(sizeof(gxRegister));
        INIT_OBJECT((*r), (DLMS_OBJECT_TYPE) obj.objectType, obj.logicalName);
        r->base.shortName = obj.shortName;
        oa_push(Client.GetObjects(), BASE((*r)));
      }
    }
    }
  */
  mes_clear(&data);
  reply_clear(&reply);
  return ret;
}

//Read object.
int com_read(
  gxObject* object,
  unsigned char attributeOrdinal)
{
  int ret;
  message data;
  gxReplyData reply;
  mes_init(&data);
  reply_init(&reply);
  if ((ret = Client.Read(object, attributeOrdinal, &data)) != 0 ||
      (ret = com_readDataBlock(&data, &reply)) != 0 ||
      (ret = Client.UpdateValue(object, attributeOrdinal, &reply.dataValue)) != 0)
  {
    //Missing objects are normal (e.g. L2/L3 on a single-phase meter).
    if (ret != DLMS_ERROR_CODE_UNDEFINED_OBJECT)
    {
      GXTRACE_INT(GET_STR_FROM_EEPROM("com_read failed."), ret);
    }
  }
  mes_clear(&data);
  reply_clear(&reply);
  return ret;
}

//Read an attribute and return the raw reply value without parsing it.
int com_readRaw(
  gxObject* object,
  unsigned char attributeOrdinal,
  gxByteBuffer* raw)
{
  int ret;
  message data;
  gxReplyData reply;
  mes_init(&data);
  reply_init(&reply);
  if ((ret = Client.Read(object, attributeOrdinal, &data)) == 0 &&
      (ret = com_readDataBlock(&data, &reply)) == 0)
  {
    if ((reply.dataValue.vt == DLMS_DATA_TYPE_OCTET_STRING ||
         reply.dataValue.vt == DLMS_DATA_TYPE_DATETIME) &&
        reply.dataValue.byteArr != NULL)
    {
      bb_set(raw, reply.dataValue.byteArr->data, reply.dataValue.byteArr->size);
    }
    else
    {
      ret = DLMS_ERROR_CODE_INVALID_PARAMETER;
    }
  }
  mes_clear(&data);
  reply_clear(&reply);
  return ret;
}

int com_write(
  gxObject* object,
  unsigned char attributeOrdinal)
{
  int ret;
  message data;
  gxReplyData reply;
  mes_init(&data);
  reply_init(&reply);
  if ((ret = Client.Write(object, attributeOrdinal, &data)) != 0 ||
      (ret = com_readDataBlock(&data, &reply)) != 0)
  {
    GXTRACE_INT(GET_STR_FROM_EEPROM("com_write failed."), ret);
  }
  mes_clear(&data);
  reply_clear(&reply);
  return ret;
}

int com_method(
  gxObject* object,
  unsigned char attributeOrdinal,
  dlmsVARIANT* params)
{
  int ret;
  message messages;
  gxReplyData reply;
  mes_init(&messages);
  reply_init(&reply);
  if ((ret = Client.Method(object, attributeOrdinal, params, &messages)) != 0 ||
      (ret = com_readDataBlock(&messages, &reply)) != 0)
  {
    GXTRACE_INT(GET_STR_FROM_EEPROM("com_method failed."), ret);
  }
  mes_clear(&messages);
  reply_clear(&reply);
  return ret;
}

//Read objects.
int com_readList(
  gxArray* list)
{
  int pos, ret = DLMS_ERROR_CODE_OK;
  gxByteBuffer bb, rr;
  message messages;
  gxReplyData reply;
  if (list->size != 0)
  {
    mes_init(&messages);
    if ((ret = Client.ReadList(list, &messages)) != 0)
    {
      GXTRACE_INT(GET_STR_FROM_EEPROM("com_readList failed."), ret);
    }
    else
    {
      reply_init(&reply);
      BYTE_BUFFER_INIT(&rr);
      BYTE_BUFFER_INIT(&bb);
      //Send data.
      for (pos = 0; pos != messages.size; ++pos)
      {
        //Send data.
        reply_clear(&reply);
        if ((ret = readDLMSPacket(messages.data[pos], &reply)) != DLMS_ERROR_CODE_OK)
        {
          break;
        }
        //Check is there errors or more data from server
        while (reply_isMoreData(&reply))
        {
          if ((ret = Client.ReceiverReady(reply.moreData, &rr)) != DLMS_ERROR_CODE_OK ||
              (ret = readDLMSPacket(&rr, &reply)) != DLMS_ERROR_CODE_OK)
          {
            break;
          }
          bb_clear(&rr);
        }
        bb_set2(&bb, &reply.data, reply.data.position, -1);
      }
      if (ret == 0)
      {
        ret = Client.UpdateValues(list, &bb);
      }
      bb_clear(&bb);
      bb_clear(&rr);
      reply_clear(&reply);
    }
    mes_clear(&messages);
  }
  return ret;
}

int com_readRowsByEntry(
  gxProfileGeneric* object,
  unsigned long index,
  unsigned long count)
{
  int ret;
  message data;
  gxReplyData reply;
  mes_init(&data);
  reply_init(&reply);
  if ((ret = Client.ReadRowsByEntry(object, index, count, &data)) != 0 ||
      (ret = com_readDataBlock(&data, &reply)) != 0 ||
      (ret = Client.UpdateValue((gxObject*)object, 2, &reply.dataValue)) != 0)
  {
    GXTRACE_INT(GET_STR_FROM_EEPROM("com_readRowsByEntry failed."), ret);
  }
  mes_clear(&data);
  reply_clear(&reply);
  return ret;
}

///////////////////////////////////////////////////////////////////////////////////
int com_readRowsByRange(
  gxProfileGeneric* object,
  gxtime* start,
  gxtime* end)
{
  int ret;
  message data;
  gxReplyData reply;
  mes_init(&data);
  reply_init(&reply);
  if ((ret = Client.ReadRowsByRange(object, start, end, &data)) != 0 ||
      (ret = com_readDataBlock(&data, &reply)) != 0 ||
      (ret = Client.UpdateValue((gxObject*)object, 2, &reply.dataValue)) != 0)
  {
    GXTRACE_INT(GET_STR_FROM_EEPROM("com_readRowsByRange failed."), ret);
  }
  mes_clear(&data);
  reply_clear(&reply);
  return ret;
}

///////////////////////////////////////////////////////////////////////////////////
//Read scalers and units. They are static so they are read only once.
int com_readScalerAndUnits()
{
  gxObject* obj;
  int ret, pos;
  objectArray objects;
  gxArray list;
  gxObject* object;
  DLMS_OBJECT_TYPE types[] = { DLMS_OBJECT_TYPE_EXTENDED_REGISTER, DLMS_OBJECT_TYPE_REGISTER, DLMS_OBJECT_TYPE_DEMAND_REGISTER };
  oa_init(&objects);
  //Find registers and demand registers and read them.
  ret = oa_getObjects2(Client.GetObjects(), types, 3, &objects);
  if (ret != DLMS_ERROR_CODE_OK)
  {
    return ret;
  }
  if ((Client.GetNegotiatedConformance() & DLMS_CONFORMANCE_MULTIPLE_REFERENCES) != 0)
  {
    arr_init(&list);
    //Try to read with list first. All meters do not support it.
    for (pos = 0; pos != Client.GetObjects()->size; ++pos)
    {
      ret = oa_getByIndex(Client.GetObjects(), pos, &obj);
      if (ret != DLMS_ERROR_CODE_OK)
      {
        oa_empty(&objects);
        arr_clear(&list);
        return ret;
      }
      if (obj->objectType == DLMS_OBJECT_TYPE_REGISTER ||
          obj->objectType == DLMS_OBJECT_TYPE_EXTENDED_REGISTER)
      {
        arr_push(&list, key_init(obj, (void*)3));
      }
      else if (obj->objectType == DLMS_OBJECT_TYPE_DEMAND_REGISTER)
      {
        arr_push(&list, key_init(obj, (void*)4));
      }
    }
    ret = com_readList(&list);
    arr_clear(&list);
  }
  //If read list failed read items one by one.
  if (ret != 0)
  {
    for (pos = 0; pos != objects.size; ++pos)
    {
      ret = oa_getByIndex(&objects, pos, &object);
      if (ret != DLMS_ERROR_CODE_OK)
      {
        oa_empty(&objects);
        return ret;
      }
      ret = com_read(object, object->objectType == DLMS_OBJECT_TYPE_DEMAND_REGISTER ? 4 : 3);
      if (ret != DLMS_ERROR_CODE_OK)
      {
        oa_empty(&objects);
        return ret;
      }
    }
  }
  //Do not clear objects list because it will free also objects from association view list.
  oa_empty(&objects);
  return ret;
}

///////////////////////////////////////////////////////////////////////////////////
//Read profile generic columns. They are static so they are read only once.
int com_readProfileGenericColumns()
{
  int ret, pos;
  objectArray objects;
  gxObject* object;
  oa_init(&objects);
  ret = oa_getObjects(Client.GetObjects(), DLMS_OBJECT_TYPE_PROFILE_GENERIC, &objects);
  if (ret != DLMS_ERROR_CODE_OK)
  {
    oa_empty(&objects);
    return ret;
  }
  for (pos = 0; pos != objects.size; ++pos)
  {
    ret = oa_getByIndex(&objects, pos, &object);
    if (ret != DLMS_ERROR_CODE_OK)
    {
      break;
    }
    ret = com_read(object, 3);
    if (ret != DLMS_ERROR_CODE_OK)
    {
      break;
    }
  }
  //Do not clear objects list because it will free also objects from association view list.
  oa_empty(&objects);
  return ret;
}

///////////////////////////////////////////////////////////////////////////////////
//Read profile generics rows.
int com_readProfileGenerics()
{
  gxtime startTime, endTime;
  int ret, pos;
  char str[50];
  char ln[25];
  char* data = NULL;
  gxByteBuffer ba;
  objectArray objects;
  gxProfileGeneric* pg;
  oa_init(&objects);
  ret = oa_getObjects(Client.GetObjects(), DLMS_OBJECT_TYPE_PROFILE_GENERIC, &objects);
  if (ret != DLMS_ERROR_CODE_OK)
  {
    //Do not clear objects list because it will free also objects from association view list.
    oa_empty(&objects);
    return ret;
  }
  BYTE_BUFFER_INIT(&ba);
  for (pos = 0; pos != objects.size; ++pos)
  {
    ret = oa_getByIndex(&objects, pos, (gxObject**)&pg);
    if (ret != DLMS_ERROR_CODE_OK)
    {
      //Do not clear objects list because it will free also objects from association view list.
      oa_empty(&objects);
      return ret;
    }
    //Read entries in use.
    ret = com_read((gxObject*)pg, 7);
    if (ret != DLMS_ERROR_CODE_OK)
    {
      printf("Failed to read object %s %s attribute index %d\r\n", str, ln, 7);
      //Do not clear objects list because it will free also objects from association view list.
      oa_empty(&objects);
      return ret;
    }
    //Read entries.
    ret = com_read((gxObject*)pg, 8);
    if (ret != DLMS_ERROR_CODE_OK)
    {
      printf("Failed to read object %s %s attribute index %d\r\n", str, ln, 8);
      //Do not clear objects list because it will free also objects from association view list.
      oa_empty(&objects);
      return ret;
    }
    printf("Entries: %ld/%ld\r\n", pg->entriesInUse, pg->profileEntries);
    //If there are no columns or rows.
    if (pg->entriesInUse == 0 || pg->captureObjects.size == 0)
    {
      continue;
    }
    //Read first row from Profile Generic.
    ret = com_readRowsByEntry(pg, 1, 1);
    //Read last day from Profile Generic.
    time_now(&startTime);
    endTime = startTime;
    time_clearTime(&startTime);
    ret = com_readRowsByRange(pg, &startTime, &endTime);
  }
  //Do not clear objects list because it will free also objects from association view list.
  oa_empty(&objects);
  return ret;
}

// This function reads ALL objects that meter have excluded profile generic objects.
// It will loop all object's attributes.
int com_readValues()
{
  gxByteBuffer attributes;
  unsigned char ch;
  gxObject* object;
  unsigned long index;
  int ret, pos;
  BYTE_BUFFER_INIT(&attributes);

  for (pos = 0; pos != Client.GetObjects()->size; ++pos)
  {
    ret = oa_getByIndex(Client.GetObjects(), pos, &object);
    if (ret != DLMS_ERROR_CODE_OK)
    {
      bb_clear(&attributes);
      return ret;
    }
    ///////////////////////////////////////////////////////////////////////////////////
    // Profile generics are read later because they are special cases.
    // (There might be so lots of data and we so not want waste time to read all the data.)
    if (object->objectType == DLMS_OBJECT_TYPE_PROFILE_GENERIC)
    {
      continue;
    }
    ret = obj_getAttributeIndexToRead(object, &attributes);
    if (ret != DLMS_ERROR_CODE_OK)
    {
      bb_clear(&attributes);
      return ret;
    }
    for (index = 0; index < attributes.size; ++index)
    {
      ret = bb_getUInt8ByIndex(&attributes, index, &ch);
      if (ret != DLMS_ERROR_CODE_OK)
      {
        bb_clear(&attributes);
        return ret;
      }
      ret = com_read(object, ch);
      if (ret != DLMS_ERROR_CODE_OK)
      {
        //Return error if not DLMS error.
        if (ret != DLMS_ERROR_CODE_READ_WRITE_DENIED)
        {
          bb_clear(&attributes);
          return ret;
        }
        ret = 0;
      }
    }
    bb_clear(&attributes);
  }
  bb_clear(&attributes);
  return ret;
}

///////////////////////////////////////////////////////////////////////////////////
// Association view (object list of the current association).
// Read once per boot. After that, every cycle reads the value of every
// Data, Register, Extended register, Demand register and Clock object in it.
///////////////////////////////////////////////////////////////////////////////////
static AvEntry* g_av = NULL;
static uint16_t g_avCount = 0;
static bool g_avLoaded = false;

static void obisToString(const unsigned char* ln, char* buff, size_t size)
{
  snprintf(buff, size, "%u.%u.%u.%u.%u.%u", ln[0], ln[1], ln[2], ln[3], ln[4], ln[5]);
}

//Description from obis_names.h, or "" if the code is not known.
static const char* obisName(const unsigned char* ln)
{
  char obis[24];
  obisToString(ln, obis, sizeof(obis));
  for (size_t pos = 0; pos != OBIS_NAMES_SIZE; ++pos)
  {
    if (strcmp(OBIS_NAMES[pos].obis, obis) == 0)
    {
      return OBIS_NAMES[pos].name;
    }
  }
  return "";
}

//Class names for all IC ids, also the ones excluded in ArduinoIgnore.h.
static const char* className(uint16_t classId)
{
  switch (classId)
  {
    case 1:  return "Data";
    case 3:  return "Register";
    case 4:  return "ExtRegister";
    case 5:  return "DemandRegister";
    case 6:  return "RegActivation";
    case 7:  return "ProfileGeneric";
    case 8:  return "Clock";
    case 9:  return "ScriptTable";
    case 10: return "Schedule";
    case 11: return "SpecialDays";
    case 12: return "AssociationSN";
    case 15: return "AssociationLN";
    case 17: return "SapAssignment";
    case 18: return "ImageTransfer";
    case 19: return "IecLocalPort";
    case 20: return "ActivityCalendar";
    case 21: return "RegisterMonitor";
    case 22: return "ActionSchedule";
    case 23: return "HdlcSetup";
    case 40: return "PushSetup";
    case 41: return "TcpUdpSetup";
    case 42: return "Ipv4Setup";
    case 43: return "MacAddrSetup";
    case 61: return "RegisterTable";
    case 63: return "StatusMapping";
    case 64: return "SecuritySetup";
    case 70: return "DisconnectCtrl";
    case 71: return "Limiter";
    default: return "Class";
  }
}

//True for the classes whose value is read every cycle.
static bool isValueClass(uint16_t classId)
{
  return classId == DLMS_OBJECT_TYPE_DATA ||
         classId == DLMS_OBJECT_TYPE_REGISTER ||
         classId == DLMS_OBJECT_TYPE_EXTENDED_REGISTER ||
         classId == DLMS_OBJECT_TYPE_DEMAND_REGISTER ||
         classId == DLMS_OBJECT_TYPE_CLOCK;
}

//True for the classes that have a scaler and unit.
static bool hasScaler(uint16_t classId)
{
  return classId == DLMS_OBJECT_TYPE_REGISTER ||
         classId == DLMS_OBJECT_TYPE_EXTENDED_REGISTER ||
         classId == DLMS_OBJECT_TYPE_DEMAND_REGISTER;
}

//Timeouts mean the meter stopped answering; no point in reading further.
static bool isLinkError(int ret)
{
  return ret == DLMS_ERROR_CODE_SEND_FAILED || ret == DLMS_ERROR_CODE_RECEIVE_FAILED;
}

//Parse the object list. Unlike Client.ParseObjects this keeps every object,
//also the classes that are excluded from this build in ArduinoIgnore.h.
static int av_parse(gxByteBuffer* data)
{
  int ret;
  unsigned char tag;
  uint16_t count;
  if ((ret = bb_getUInt8(data, &tag)) != 0)
  {
    return ret;
  }
  if (tag != DLMS_DATA_TYPE_ARRAY)
  {
    return DLMS_ERROR_CODE_INVALID_RESPONSE;
  }
  if (hlp_getObjectCount2(data, &count) != 0)
  {
    return DLMS_ERROR_CODE_OUTOFMEMORY;
  }
  free(g_av);
  g_avCount = 0;
  g_av = (AvEntry*)calloc(count != 0 ? count : 1, sizeof(AvEntry));
  if (g_av == NULL)
  {
    return DLMS_ERROR_CODE_OUTOFMEMORY;
  }
  dlmsVARIANT value;
  gxDataInfo info;
  dlmsVARIANT *classId, *version, *ln;
  var_init(&value);
  for (uint16_t pos = 0; pos != count; ++pos)
  {
    var_clear(&value);
    di_init(&info);
    if ((ret = dlms_getData(data, &info, &value)) != 0)
    {
      break;
    }
    //Item: structure { class_id, version, logical_name, access_rights }.
    if (value.vt != DLMS_DATA_TYPE_STRUCTURE || value.Arr == NULL || value.Arr->size < 3 ||
        va_getByIndex(value.Arr, 0, &classId) != 0 ||
        va_getByIndex(value.Arr, 1, &version) != 0 ||
        va_getByIndex(value.Arr, 2, &ln) != 0 ||
        ln->vt != DLMS_DATA_TYPE_OCTET_STRING || ln->byteArr == NULL || ln->byteArr->size != 6)
    {
      continue;
    }
    AvEntry* e = &g_av[g_avCount++];
    e->classId = (uint16_t)var_toInteger(classId);
    e->version = (unsigned char)var_toInteger(version);
    memcpy(e->ln, ln->byteArr->data, 6);
    e->scaler = 0;
    e->unit = 0;
    e->scalerRead = 0;
  }
  var_clear(&value);
  return ret;
}

//Read the association view from the meter.
static int av_read()
{
  int ret;
  message msg;
  gxReplyData reply;
  mes_init(&msg);
  reply_init(&reply);
  if ((ret = Client.GetObjectsRequest(&msg)) == 0 &&
      (ret = com_readDataBlock(&msg, &reply)) == 0)
  {
    ret = av_parse(&reply.data);
  }
  mes_clear(&msg);
  reply_clear(&reply);
  return ret;
}

//Read one attribute by class id and logical name and return the raw value.
//access is a selective access selector + parameters, or NULL for a plain read.
//No COSEM object of the right class is needed, so this works for any class.
static int readAttribute(uint16_t classId, const unsigned char* ln, unsigned char attributeOrdinal,
                         gxByteBuffer* access, dlmsVARIANT* value)
{
  int ret;
  message msg;
  gxReplyData reply;
  var_clear(value);
  mes_init(&msg);
  reply_init(&reply);
  if ((ret = Client.ReadSelective((DLMS_OBJECT_TYPE)classId, ln, attributeOrdinal, access, &msg)) == 0 &&
      (ret = com_readDataBlock(&msg, &reply)) == 0)
  {
    //An HDLC control frame (RR/RNR/DM/FRMR) completes the reply with no APDU.
    //Gurux returns OK for it, so report it instead of an empty value.
    if (reply.dataValue.vt == DLMS_DATA_TYPE_NONE && reply.data.size == 0)
    {
      ret = DLMS_ERROR_CODE_INVALID_RESPONSE;
    }
    else
    {
      //Move instead of copy: a profile buffer can be large.
      *value = reply.dataValue;
      reply.dataValue.vt = DLMS_DATA_TYPE_NONE;
    }
  }
  mes_clear(&msg);
  reply_clear(&reply);
  return ret;
}

static int av_readAttribute(const AvEntry* e, unsigned char attributeOrdinal, dlmsVARIANT* value)
{
  return readAttribute(e->classId, e->ln, attributeOrdinal, NULL, value);
}

//Read scaler and unit of all registers once. Value = raw * 10^scaler.
static int av_readScalers()
{
  int ret = 0;
  dlmsVARIANT value;
  dlmsVARIANT *scaler, *unit;
  var_init(&value);
  for (uint16_t pos = 0; pos != g_avCount; ++pos)
  {
    AvEntry* e = &g_av[pos];
    if (!hasScaler(e->classId))
    {
      continue;
    }
    var_clear(&value);
    //Demand register has scaler_unit in attribute 4, the others in 3.
    ret = av_readAttribute(e, e->classId == DLMS_OBJECT_TYPE_DEMAND_REGISTER ? 4 : 3, &value);
    if (ret == 0 && value.vt == DLMS_DATA_TYPE_STRUCTURE && value.Arr != NULL &&
        va_getByIndex(value.Arr, 0, &scaler) == 0 &&
        va_getByIndex(value.Arr, 1, &unit) == 0)
    {
      e->scaler = (signed char)var_toInteger(scaler);
      e->unit = (unsigned char)var_toInteger(unit);
      e->scalerRead = 1;
    }
    else if (isLinkError(ret))
    {
      break;
    }
    ret = 0;
  }
  var_clear(&value);
  return ret;
}

//Print the association view.
static void av_print()
{
  char obis[24];
  TraceSerial.printf("\r\n================ Association view: %u objects ================\r\n",
                     (unsigned)g_avCount);
  TraceSerial.printf("  %-4s %-4s %-17s %-22s %s\r\n", "#", "IC", "Class", "OBIS", "Description");
  for (uint16_t pos = 0; pos != g_avCount; ++pos)
  {
    const AvEntry* e = &g_av[pos];
    obisToString(e->ln, obis, sizeof(obis));
    TraceSerial.printf("  %-4u %-4u %-17s %-22s %s\r\n", (unsigned)(pos + 1),
                       (unsigned)e->classId, className(e->classId), obis, obisName(e->ln));
  }
  TraceSerial.print("==============================================================\r\n");
}

//Short unit symbol. Power and energy are shown in k-units.
static const char* unitSymbol(unsigned char unit, double* value)
{
  switch (unit)
  {
    case DLMS_UNIT_ACTIVE_POWER:    *value /= 1000; return "kW";
    case DLMS_UNIT_APPARENT_POWER:  *value /= 1000; return "kVA";
    case DLMS_UNIT_REACTIVE_POWER:  *value /= 1000; return "kvar";
    case DLMS_UNIT_ACTIVE_ENERGY:   *value /= 1000; return "kWh";
    case DLMS_UNIT_APPARENT_ENERGY: *value /= 1000; return "kVAh";
    case DLMS_UNIT_REACTIVE_ENERGY: *value /= 1000; return "kvarh";
    case DLMS_UNIT_CURRENT:         return "A";
    case DLMS_UNIT_VOLTAGE:         return "V";
    case DLMS_UNIT_FREQUENCY:       return "Hz";
    case DLMS_UNIT_SECOND:          return "s";
    case DLMS_UNIT_MINUTE:          return "min";
    case DLMS_UNIT_HOUR:            return "h";
    default:                        return "";
  }
}

static bool isNumeric(DLMS_DATA_TYPE vt)
{
  switch (vt)
  {
    case DLMS_DATA_TYPE_BOOLEAN:
    case DLMS_DATA_TYPE_INT8:
    case DLMS_DATA_TYPE_INT16:
    case DLMS_DATA_TYPE_INT32:
    case DLMS_DATA_TYPE_INT64:
    case DLMS_DATA_TYPE_UINT8:
    case DLMS_DATA_TYPE_UINT16:
    case DLMS_DATA_TYPE_UINT32:
    case DLMS_DATA_TYPE_UINT64:
    case DLMS_DATA_TYPE_ENUM:
    case DLMS_DATA_TYPE_FLOAT32:
    case DLMS_DATA_TYPE_FLOAT64:
      return true;
    default:
      return false;
  }
}

//Format a value: scaled number with unit, text, date-time or generic.
//For numbers the scaled value and unit symbol are also returned in number/unit.
static bool formatValue(const AvEntry* e, dlmsVARIANT* value, char* buff, size_t size,
                        double* number, const char** unit)
{
  if (isNumeric(value->vt))
  {
    double v = var_toDouble(value);
    const char* sym = "";
    if (e->scalerRead)
    {
      v *= pow(10, e->scaler);
      double raw = v;
      sym = unitSymbol(e->unit, &v);
      //Counters and codes (integer, scaler >= 0) are shown without decimals.
      //k-units (value divided by 1000) always keep them.
      bool whole = value->vt != DLMS_DATA_TYPE_FLOAT32 && value->vt != DLMS_DATA_TYPE_FLOAT64 &&
                   e->scaler >= 0 && v == raw && v == floor(v);
      snprintf(buff, size, whole ? "%.0f %s" : "%.3f %s", v, sym);
    }
    else
    {
      snprintf(buff, size, "%.0f", v);
    }
    *number = v;
    *unit = sym;
    return true;
  }
  gxByteBuffer* bb = NULL;
  if ((value->vt == DLMS_DATA_TYPE_OCTET_STRING || value->vt == DLMS_DATA_TYPE_DATETIME) &&
      value->byteArr != NULL)
  {
    bb = value->byteArr;
  }
  else if (value->vt == DLMS_DATA_TYPE_STRING && value->strVal != NULL)
  {
    bb = value->strVal;
  }
  if (bb != NULL)
  {
    bool printable = bb->size != 0;
    for (uint32_t i = 0; i != bb->size; ++i)
    {
      if (bb->data[i] < 0x20 || bb->data[i] > 0x7E)
      {
        printable = false;
        break;
      }
    }
    if (printable)
    {
      snprintf(buff, size, "%.*s", (int)bb->size, (const char*)bb->data);
      return false;
    }
    //12-byte DLMS date-time: yyyy mm dd dow hh mm ss hs dev(2) status.
    if (bb->size == 12)
    {
      //0xFF (0xFFFF for year) = "not specified", e.g. billing date patterns.
      const unsigned char* d = bb->data;
      unsigned year = (unsigned)((d[0] << 8) | d[1]);
      char y[6], f[5][4];
      const unsigned char fields[5] = {d[2], d[3], d[5], d[6], d[7]};
      snprintf(y, sizeof(y), year == 0xFFFF ? "****" : "%04u", year);
      for (int i = 0; i != 5; ++i)
      {
        snprintf(f[i], sizeof(f[i]), fields[i] >= 0xFD ? "**" : "%02u", fields[i]);
      }
      snprintf(buff, size, "%s-%s-%s %s:%s:%s", y, f[0], f[1], f[2], f[3], f[4]);
      return false;
    }
  }
  gxByteBuffer str;
  BYTE_BUFFER_INIT(&str);
  var_toString(value, &str);
  snprintf(buff, size, "%.*s", (int)str.size, str.data != NULL ? (const char*)str.data : "");
  bb_clear(&str);
  return false;
}

//Read and print the value of every value object in the association view.
//Every value that was read is also sent to the BLE client.
static int av_readValues()
{
  int ret = 0;
  char obis[24];
  char text[96];
  dlmsVARIANT value;
  var_init(&value);
  TraceSerial.print("\r\n---------------------- Meter readings ----------------------\r\n");
  for (uint16_t pos = 0; pos != g_avCount; ++pos)
  {
    const AvEntry* e = &g_av[pos];
    if (!isValueClass(e->classId))
    {
      continue;
    }
    var_clear(&value);
    obisToString(e->ln, obis, sizeof(obis));
    ret = av_readAttribute(e, 2, &value);
    if (ret == 0)
    {
      double number;
      const char* unit;
      if (formatValue(e, &value, text, sizeof(text), &number, &unit))
      {
        ble_readingAddNumber(obis, obisName(e->ln), number, unit);
        rd_addNumber(obis, obisName(e->ln), number, unit);
      }
      else
      {
        ble_readingAddText(obis, obisName(e->ln), text);
        rd_addText(obis, obisName(e->ln), text);
      }
    }
    else if (ret == DLMS_ERROR_CODE_READ_WRITE_DENIED)
    {
      snprintf(text, sizeof(text), "(no access)");
    }
    else if (ret == DLMS_ERROR_CODE_INVALID_RESPONSE)
    {
      snprintf(text, sizeof(text), "(empty reply)");
    }
    else
    {
      snprintf(text, sizeof(text), "(error %d)", ret);
    }
    TraceSerial.printf("  %-22s %-26s : %s\r\n", obis, obisName(e->ln), text);
    if (isLinkError(ret))
    {
      TraceSerial.print("  Meter stopped answering. Cycle aborted.\r\n");
      break;
    }
    ret = 0;
  }
  var_clear(&value);
  TraceSerial.print("------------------------------------------------------------\r\n");
  return ret;
}

//This function reads ALL objects that meter have. It will loop all object's attributes.
//readProfiles also reads every profile generic (profiles.ino), which is slow.
int com_readAllObjects(const char* invocationCounter, bool readProfiles)
{
  int ret;
  if (invocationCounter != NULL)
  {
    if ((ret = com_updateInvocationCounter(invocationCounter)) != 0)
    {
      return ret;
    }
  }
  //Initialize connection. Like the working dlms_client, retry a few times:
  //the first AARQ after power-up is sometimes rejected by the meter.
  for (int attempt = 1; attempt <= CONNECT_RETRY; ++attempt)
  {
    ret = com_initializeConnection();
    if (ret == DLMS_ERROR_CODE_OK)
    {
      break;
    }
    GXTRACE_INT(GET_STR_FROM_EEPROM("com_initializeConnection failed"), ret);
    if (attempt != CONNECT_RETRY)
    {
      com_close();
      delay(RECONNECT_DELAY_MS);
      GXTRACE_INT(GET_STR_FROM_EEPROM("Reconnect attempt"), attempt + 1);
    }
  }
  if (ret != DLMS_ERROR_CODE_OK)
  {
    return ret;
  }
  GXTRACE_INT(GET_STR_FROM_EEPROM("com_initializeConnection SUCCEEDED"), ret);
  //Association view is read once per boot.
  if (!g_avLoaded)
  {
    if ((ret = av_read()) != 0)
    {
      GXTRACE_INT(GET_STR_FROM_EEPROM("Association view read failed"), ret);
      return ret;
    }
    av_readScalers();
    av_print();
    g_avLoaded = true;
  }
  ret = av_readValues();
  if (readProfiles && !isLinkError(ret))
  {
    ret = pg_readAll();
  }
  return ret;
}

#if METER_LOOPBACK_TEST
//Sends a test string and checks that it comes back through the cable.
void meter_loopbackTest()
{
  static const char TEST[] = "LOOPBACK-123";
  char buff[sizeof(TEST)] = {0};
  while (MeterSerial.available())
  {
    MeterSerial.read();
  }
  MeterSerial.write((const uint8_t*)TEST, sizeof(TEST) - 1);
  MeterSerial.flush();
  size_t count = MeterSerial.readBytes(buff, sizeof(TEST) - 1);
  TraceSerial.printf("\r\nLoopback: sent %u, received %u: '%s' -> %s\r\n",
                     (unsigned)(sizeof(TEST) - 1), (unsigned)count, buff,
                     memcmp(buff, TEST, sizeof(TEST) - 1) == 0 ? "OK" : "FAILED");
}
#endif //METER_LOOPBACK_TEST

void setup() {
  //USB serial is used to send trace. The default 256 byte HWCDC TX buffer
  //drops lines when the association view table is printed in one burst.
  TraceSerial.setTxBufferSize(4096);
  TraceSerial.begin(115200);
  //Wait max 3 s for USB serial monitor so the board also runs standalone.
  uint32_t usbWait = millis();
  while (!TraceSerial && millis() - usbWait < 3000) {
    delay(10);
  }
  EEPROM.begin(EEPROM_SIZE_BYTES);

  //DTR pin: output, de-asserted until the first connection (dtr_wakeup).
  pinMode(DTR_PIN_DEFAULT, OUTPUT);
  digitalWrite(DTR_PIN_DEFAULT, !DTR_ACTIVE_LEVEL);

  GXTRACE(GET_STR_FROM_EEPROM("Start application"), NULL);
  BYTE_BUFFER_INIT(&frameData);
  //Set frame capacity.
  bb_capacity(&frameData, 128);
  uint16_t serverAddress = METER_SERVER_LOGICAL;
  if (METER_SERVER_PHYSICAL != 0)
  {
    serverAddress = GXDLMSClient::GetServerAddress(METER_SERVER_LOGICAL, METER_SERVER_PHYSICAL, 0);
  }
  static const char PASSWORD[] = METER_PASSWORD;
  Client.init(true, METER_CLIENT_ADDRESS, serverAddress, METER_AUTH,
              (const unsigned char*)PASSWORD, sizeof(PASSWORD) - 1, DLMS_INTERFACE_TYPE_HDLC);
  //Window 1 / max frame 1024. Works with all meters tested in dlms_client.
  Client.SetHDLCSettings(1024, 1024, 1, 1);

  //Use this for passwords with non-ASCII characters.
  //unsigned char password[] = {0, 0, 0, 0, 0, 0, 0, 0};  
  //Client.init(true, 16, 1, DLMS_AUTHENTICATION_LOW, password, sizeof(password), DLMS_INTERFACE_TYPE_HDLC);

  //Uncomment to enable secure connection and set the system title, block cipher key, or authentication key.
  /*
    Client.SetSecurity(DLMS_SECURITY_AUTHENTICATION_ENCRYPTION);
    //TODO: Change logical name of the frame counter if it's used to com_readAllObjects.
    gxByteBuffer bb;
    bb_init(&bb);
    bb_addHexString(&bb, "3132333435363738");
    Client.SetSystemTitle(&bb);
    bb_clear(&bb);
    bb_addHexString(&bb, "D0 D1 D2 D3 D4 D5 D6 D7D8 D9 DA DB DC DD DE DF");
    Client.SetAuthenticationKey(&bb);
    bb_clear(&bb);
    bb_addHexString(&bb, "00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F");
    Client.SetBlockCipherKey(&bb);
    bb_clear(&bb);
  */
  //Meter UART1: RX=GPIO5, TX=GPIO4.
  if (Client.GetInterfaceType() == DLMS_INTERFACE_TYPE_HDLC_WITH_MODE_E)
  {
    // Optical probes work with 300 bps 7E1:
    meter_begin(300, SERIAL_7E1);
  }
  else
  {
    meter_begin(METER_BAUD, SERIAL_8N1);
  }
  TraceSerial.printf("\r\nMeter UART1 RX=%d TX=%d DTR=%d (level %d), %d baud, client %d, server %u, auth %d\r\n",
                     RXD1_DEFAULT, TXD1_DEFAULT, DTR_PIN_DEFAULT, DTR_ACTIVE_LEVEL,
                     METER_BAUD, METER_CLIENT_ADDRESS, (unsigned)serverAddress, (int)METER_AUTH);
  //BLE link to the mobile app, plus the OTA command service on the same server.
  ble_begin(READ_INTERVAL_MS);
  otaBle_init();
  ble_startAdvertising();

  //EC200U, shared by the log upload and OTA. If an update was just applied,
  //tell the OTA server whether the new image booted.
  const esp_partition_t* run = esp_ota_get_running_partition();
  TraceSerial.printf("\r\nFirmware %s (partition %s)\r\n", FW_VERSION, run ? run->label : "?");
  cfg_load();
  modem_hwInit();
  g_ota.modemReady = modem_init();
  if (g_ota.modemReady)
  {
    ota_reportBootResult();
  }
  lb_begin();
  //First OTA check after the boot read and its log upload.
  g_ota.nextCheckMs = millis() + BOOT_CHECK_DELAY_MS;
  TraceSerial.print("Type HELP for OTA commands.\r\n");
}

void loop() {
  int ret;
#if METER_LOOPBACK_TEST
  meter_loopbackTest();
  delay(2000);
  return;
#endif
  static bool firstRun = true;
  cmd_pollSerial();
  ble_poll();
  otaBle_poll();
  //Read on boot, on the auto-read interval, or when the app asks for it.
  bool bleRequest = ble_takeReadRequest();
  if (firstRun || bleRequest || millis() - runTime >= ble_readIntervalMs())
  {
    //Profiles are read on boot and when the app asks, not on the auto-read
    //interval: block load, billing and events take a while at 9600 baud.
    bool readProfiles = firstRun || bleRequest;
    firstRun = false;
    runTime = millis();
    GXTRACE(GET_STR_FROM_EEPROM("Start reading"), NULL);
    ble_readingBegin();
    rd_begin();
    //TODO: Change logical name of the frame counter if it's used.
    ret = com_readAllObjects("0.0.43.1.0.255", readProfiles);
    com_close();
    ble_readingEnd(ret);
    rd_end(ret);
    //Meter UART is idle now: send this cycle's readings and trace to the
    //data server.
    lb_upload();
  }
  //OTA runs between read cycles, never during one. A download blocks the
  //loop (meter reads and BLE wait) and reboots into the new image on success.
  if (!g_ota.busy && ota_isDue())
  {
    ota_run();
  }
}

#ifdef DLMS_DEBUG
//Print detailed information to the serial port.
void svr_trace(const char* str, const char* data)
{
  GXTRACE(str, data);
}
#endif //DLMS_DEBUG

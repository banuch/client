// =============================================================================
//  trace_tee.h  --  Trace output to USB serial plus a log ring buffer
//
//  All trace output goes through TraceLog. Every byte is written to the USB
//  serial port and, while capture is on, kept in a ring buffer in PSRAM.
//  log_bridge.ino uploads the buffer to the log server after each read
//  cycle. When the buffer is full the oldest text is dropped and counted.
// =============================================================================
#ifndef TRACE_TEE_H
#define TRACE_TEE_H

#include <Arduino.h>

// Ring buffer size. A boot read with all profiles prints about 100 KB.
#define TRACE_LOG_SIZE (256UL * 1024UL)

class TraceTee : public Print
{
  public:
    void begin(unsigned long baud);
    void setTxBufferSize(size_t size)
    {
      Serial.setTxBufferSize(size);
    }
    operator bool()
    {
      return (bool)Serial;
    }
    size_t write(uint8_t c) override;
    size_t write(const uint8_t* data, size_t size) override;
    using Print::write;

    // Capture is turned off while the log itself is uploaded.
    void setCapture(bool on)
    {
      capture_ = on;
    }
    size_t pending() const
    {
      return used_;
    }
    uint32_t dropped() const
    {
      return dropped_;
    }
    void clearDropped()
    {
      dropped_ = 0;
    }
    // Copy pending bytes starting offset bytes after the oldest one.
    size_t peek(size_t offset, uint8_t* out, size_t size) const;
    // Remove the oldest count bytes once they are uploaded.
    void consume(size_t count);

  private:
    void store(const uint8_t* data, size_t size);
    uint8_t* buf_ = NULL;
    size_t cap_ = 0;
    size_t head_ = 0;
    size_t used_ = 0;
    uint32_t dropped_ = 0;
    bool capture_ = true;
};

extern TraceTee TraceLog;

#endif // TRACE_TEE_H

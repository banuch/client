#include "trace_tee.h"

TraceTee TraceLog;

void TraceTee::begin(unsigned long baud)
{
  Serial.begin(baud);
  if (buf_ == NULL)
  {
    //PSRAM first. Without PSRAM a small internal buffer still works.
    buf_ = (uint8_t*)ps_malloc(TRACE_LOG_SIZE);
    cap_ = TRACE_LOG_SIZE;
    if (buf_ == NULL)
    {
      cap_ = 16 * 1024;
      buf_ = (uint8_t*)malloc(cap_);
      if (buf_ == NULL)
      {
        cap_ = 0;
      }
    }
  }
}

size_t TraceTee::write(uint8_t c)
{
  return write(&c, 1);
}

size_t TraceTee::write(const uint8_t* data, size_t size)
{
  if (capture_ && cap_ != 0)
  {
    store(data, size);
  }
  return Serial.write(data, size);
}

void TraceTee::store(const uint8_t* data, size_t size)
{
  if (size >= cap_)
  {
    //Only the newest cap_ bytes fit.
    dropped_ += used_ + (size - cap_);
    memcpy(buf_, data + (size - cap_), cap_);
    head_ = 0;
    used_ = cap_;
    return;
  }
  if (used_ + size > cap_)
  {
    size_t drop = used_ + size - cap_;
    used_ -= drop;
    dropped_ += drop;
  }
  size_t first = cap_ - head_;
  if (first > size)
  {
    first = size;
  }
  memcpy(buf_ + head_, data, first);
  memcpy(buf_, data + first, size - first);
  head_ = (head_ + size) % cap_;
  used_ += size;
}

size_t TraceTee::peek(size_t offset, uint8_t* out, size_t size) const
{
  if (offset >= used_)
  {
    return 0;
  }
  if (size > used_ - offset)
  {
    size = used_ - offset;
  }
  size_t start = (head_ + cap_ - used_ + offset) % cap_;
  size_t first = cap_ - start;
  if (first > size)
  {
    first = size;
  }
  memcpy(out, buf_ + start, first);
  memcpy(out + first, buf_, size - first);
  return size;
}

void TraceTee::consume(size_t count)
{
  used_ -= count < used_ ? count : used_;
}

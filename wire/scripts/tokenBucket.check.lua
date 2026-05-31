local now = tonumber(ARGV[1])
if now == 0 then
  local t = redis.call('TIME')
  now = t[1] * 1000 + math.floor(t[2] / 1000)
end
local capacity = tonumber(ARGV[2])
local refill_per_sec = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local refill_per_ms = refill_per_sec / 1000
local h = redis.call('HMGET', KEYS[1], 't', 'l')
local tokens = tonumber(h[1])
local last = tonumber(h[2])
if tokens == nil then tokens = capacity end
if last == nil then last = now end
local elapsed = now - last
if elapsed < 0 then elapsed = 0 end
tokens = tokens + elapsed * refill_per_ms
if tokens > capacity then tokens = capacity end
local ttl = math.ceil(capacity / refill_per_ms)
if ttl < 1 then ttl = 1 end
if tokens >= cost then
  local new_tokens = tokens - cost
  local remaining = math.floor(new_tokens)
  if remaining < 0 then remaining = 0 end
  redis.call('HSET', KEYS[1], 't', string.format('%.17g', new_tokens), 'l', string.format('%.17g', now))
  redis.call('PEXPIRE', KEYS[1], ttl)
  return {1, capacity, remaining, now + math.ceil((capacity - new_tokens) / refill_per_ms), 0}
end
local remaining = math.floor(tokens)
if remaining < 0 then remaining = 0 end
return {0, capacity, remaining, now + math.ceil((capacity - tokens) / refill_per_ms), math.ceil((cost - tokens) / refill_per_ms)}
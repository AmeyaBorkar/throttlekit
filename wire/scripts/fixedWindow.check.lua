local now = tonumber(ARGV[1])
if now == 0 then
  local t = redis.call('TIME')
  now = t[1] * 1000 + math.floor(t[2] / 1000)
end
local limit = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local window_start = math.floor(now / window) * window
local reset_at = window_start + window
local h = redis.call('HMGET', KEYS[1], 's', 'c')
local start = tonumber(h[1])
local count = tonumber(h[2])
if start == nil or start ~= window_start then count = 0 end
if count + cost <= limit then
  local new_count = count + cost
  redis.call('HSET', KEYS[1], 's', window_start, 'c', new_count)
  local px = math.ceil(reset_at - now)
  if px < 1 then px = 1 end
  redis.call('PEXPIRE', KEYS[1], px)
  return {1, limit, limit - new_count, reset_at, 0}
end
local remaining = limit - count
if remaining < 0 then remaining = 0 end
return {0, limit, remaining, reset_at, math.ceil(reset_at - now)}
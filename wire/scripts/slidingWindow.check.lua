local now = tonumber(ARGV[1])
if now == 0 then
  local t = redis.call('TIME')
  now = t[1] * 1000 + math.floor(t[2] / 1000)
end
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local S = tonumber(ARGV[5])
local key = KEYS[1]
local w = windowMs / S
local c = math.floor(now / w)
local elapsed = now - c * w
if elapsed < 0 then elapsed = 0 end
local weight = (w - elapsed) / w
if weight < 0 then weight = 0 end
if weight > 1 then weight = 1 end
local slots = S + 1
local function getCount(idx)
  local v = redis.call('HGET', key, idx % slots)
  if not v then return 0 end
  local sep = string.find(v, ':')
  if tonumber(string.sub(v, 1, sep - 1)) ~= idx then return 0 end
  return tonumber(string.sub(v, sep + 1))
end
local full = 0
for j = c - S + 1, c do full = full + getCount(j) end
local oldest = getCount(c - S)
local estimate = full + oldest * weight
local projected = estimate + cost
local resetAt = math.ceil((c + 1) * w + windowMs)
if projected <= limit then
  local cur = getCount(c)
  redis.call('HSET', key, c % slots, c .. ':' .. (cur + cost))
  redis.call('PEXPIRE', key, math.ceil(windowMs + w))
  local remaining = math.floor(limit - projected)
  if remaining < 0 then remaining = 0 end
  return {1, limit, remaining, resetAt, 0}
end
local D = projected - limit
local retry
if oldest > 0 and D <= oldest * weight then
  retry = math.ceil(D * w / oldest)
else
  retry = math.ceil((c + 1) * w - now)
end
if retry < 1 then retry = 1 end
local remaining = math.floor(limit - estimate)
if remaining < 0 then remaining = 0 end
return {0, limit, remaining, resetAt, retry}
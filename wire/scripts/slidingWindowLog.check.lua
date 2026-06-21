local now = tonumber(ARGV[1])
if now == 0 then
  local t = redis.call('TIME')
  now = t[1] * 1000 + math.floor(t[2] / 1000)
end
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
-- A log stores one stamp per unit, so a fractional cost is charged as whole units (ceil) — matching the
-- JS path. Charging the raw fractional cost would ZADD floor(cost) members (and 0 for cost < 1), diverging
-- from JS and over-admitting.
local units = math.ceil(cost)
local key = KEYS[1]
local windowStart = now - windowMs
redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
local count = redis.call('ZCARD', key)
if count + units <= limit then
  for i = 1, units do
    redis.call('ZADD', key, now, now .. '-' .. (count + i))
  end
  local px = math.ceil(windowMs)
  if px < 1 then px = 1 end
  redis.call('PEXPIRE', key, px)
  local first = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldest = now
  if first[2] then oldest = tonumber(first[2]) end
  local remaining = limit - (count + units)
  if remaining < 0 then remaining = 0 end
  return {1, limit, remaining, math.ceil(oldest + windowMs), 0}
end
local retry
if count == 0 then
  retry = windowMs
else
  local kMin = count + units - limit
  if kMin < 1 then kMin = 1 end
  if kMin > count then kMin = count end
  local ref = redis.call('ZRANGE', key, kMin - 1, kMin - 1, 'WITHSCORES')
  local refScore = now
  if ref[2] then refScore = tonumber(ref[2]) end
  retry = math.ceil(refScore + windowMs - now)
  if retry < 1 then retry = 1 end
end
local firstD = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local oldestD = now
if firstD[2] then oldestD = tonumber(firstD[2]) end
local remaining = limit - count
if remaining < 0 then remaining = 0 end
return {0, limit, remaining, math.ceil(oldestD + windowMs), retry}
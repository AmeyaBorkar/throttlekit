local now = tonumber(ARGV[1])
if now == 0 then
  local t = redis.call('TIME')
  now = t[1] * 1000 + math.floor(t[2] / 1000)
end
local period = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local burst = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])
local T = period / limit
local tau = T * burst
local inc = T * cost
local tat = tonumber(redis.call('GET', KEYS[1]) or now)
if tat < now then tat = now end
local new_tat = tat + inc
local allow_at = new_tat - tau
if now < allow_at then
  local remaining = math.floor((tau - (tat - now)) / T)
  if remaining < 0 then remaining = 0 end
  return {0, burst, remaining, math.ceil(tat), math.ceil(allow_at - now)}
end
local remaining = math.floor((tau - (new_tat - now)) / T)
if remaining < 0 then remaining = 0 end
local px = math.ceil(new_tat - now)
if px < 1 then px = 1 end
redis.call('SET', KEYS[1], string.format('%.17g', new_tat), 'PX', px)
return {1, burst, remaining, math.ceil(new_tat), 0}
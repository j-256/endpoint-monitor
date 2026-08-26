function targetHash(target) {
  let hash = 0x811c9dc5
  for (let index = 0; index < target.id.length; index += 1) {
    hash ^= target.id.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function scheduledMinute(value) {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("Schedule time must be a timestamp")
  }
  return Math.floor(milliseconds / 60000)
}

export function probeSchedule(targets, intervalMinutes, scheduledAt, maximumPerRun) {
  if (!Array.isArray(targets)
    || !Number.isInteger(intervalMinutes)
    || intervalMinutes < 1
    || !Number.isInteger(maximumPerRun)
    || maximumPerRun < 1) {
    throw new TypeError("Probe schedule input is invalid")
  }
  const ordered = [...targets].sort((left, right) => (
    targetHash(left) - targetHash(right)
      || left.id.localeCompare(right.id)
  ))
  const minute = scheduledMinute(scheduledAt)
  const shardIndex = ((minute % intervalMinutes) + intervalMinutes) % intervalMinutes
  const due = ordered.filter((_target, index) => index % intervalMinutes === shardIndex)
  const maximumShardSize = Math.ceil(ordered.length / intervalMinutes)
  if (maximumShardSize > maximumPerRun) {
    throw new RangeError(
      `Probe schedule requires ${maximumShardSize} targets in one run but the maximum is ${maximumPerRun}`,
    )
  }
  return Object.freeze({
    due: Object.freeze(due),
    intervalMinutes,
    maximumShardSize,
    shardIndex,
    targetCount: ordered.length,
  })
}

export function intervalIsDue(scheduledAt, intervalMinutes, offset = 0) {
  if (!Number.isInteger(intervalMinutes)
    || intervalMinutes < 1
    || !Number.isInteger(offset)) {
    throw new TypeError("Interval schedule input is invalid")
  }
  const minute = scheduledMinute(scheduledAt)
  return ((minute - offset) % intervalMinutes + intervalMinutes) % intervalMinutes === 0
}

import assert from "node:assert/strict"
import test from "node:test"

import {
  intervalIsDue,
  probeSchedule,
} from "../src/schedule.mjs"

const START = "2026-08-26T03:00:00.000Z"

function targets(count) {
  return Array.from({ length: count }, (_value, index) => ({
    id: `target-${String(index).padStart(2, "0")}`,
  }))
}

test("probe schedule covers every target once per interval", () => {
  const configured = targets(17)
  const seen = []
  for (let minute = 0; minute < 5; minute += 1) {
    const scheduledAt = new Date(Date.parse(START) + minute * 60000).toISOString()
    const schedule = probeSchedule(configured, 5, scheduledAt, 10)
    assert.ok(schedule.due.length <= 4)
    seen.push(...schedule.due.map((target) => target.id))
  }
  assert.deepEqual([...seen].sort(), configured.map((target) => target.id).sort())
})

test("probe schedule is stable regardless of input order", () => {
  const configured = targets(12)
  const forward = probeSchedule(configured, 5, START, 10)
  const reversed = probeSchedule([...configured].reverse(), 5, START, 10)
  assert.deepEqual(
    forward.due.map((target) => target.id),
    reversed.due.map((target) => target.id),
  )
})

test("probe schedule refuses an over-capacity target set", () => {
  assert.throws(
    () => probeSchedule(targets(51), 5, START, 10),
    /requires 11 targets/,
  )
})

test("interval schedule handles offsets and negative timestamps", () => {
  assert.equal(intervalIsDue(START, 5), true)
  assert.equal(intervalIsDue("2026-08-26T03:01:00.000Z", 5), false)
  assert.equal(intervalIsDue("2026-08-26T03:01:00.000Z", 5, 1), true)
  assert.equal(intervalIsDue("1969-12-31T23:59:00.000Z", 5, 4), true)
})

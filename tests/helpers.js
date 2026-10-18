import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createBrain } from '../src/brain.js'

/**
 * A brain backed by a fresh temp directory, with an injectable clock for
 * deterministic decay tests.
 * @param {{ config?: object, start?: number }=} options
 * @returns {{ brain: import('../src/brain.js').Brain, dir: string, advance: (ms: number) => number, now: () => number }}
 */
export function createBrainAt(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosyne-test-'))
  let now = options.start ?? Date.UTC(2026, 0, 1)
  const clock = () => now
  const brain = createBrain({
    memoryFile: path.join(dir, 'brain.json'),
    config: options.config ?? {},
    clock,
  })
  return {
    brain,
    dir,
    now: () => now,
    advance: (ms) => {
      now += ms
      return now
    },
  }
}

/**
 * Advance a brain's clock by whole days.
 * @param {{ advance: (ms: number) => number }} clock
 * @param {number} days
 */
export function advanceDays(clock, days) {
  clock.advance(days * 86_400_000)
}

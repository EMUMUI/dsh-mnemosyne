/**
 * The Loader hands `apply` a `null` config for a patch row that carries no
 * `config:` key. That used to crash the whole plugin at mount time
 * (`Cannot read properties of null (reading 'profile')`), so the row silently
 * failed to activate. These tests mount the real entry with the shapes the
 * Loader actually produces.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, normalizeConfig, profileOf, resolveMemoryFile } from '../index.js'

/** A minimal fake Cordis context: enough surface for `apply` to mount and dispose. */
function fakeContext(baseUrl) {
  const effects = []
  const injections = []
  return {
    baseUrl,
    effects,
    injections,
    effect(fn) {
      effects.push(fn())
      return () => {}
    },
    on() {},
    inject(_deps, callback) {
      injections.push(callback)
      return () => {}
    },
  }
}

/** Mount, exercise the cheap code paths, then dispose so nothing leaks. */
function mount(config) {
  const dir = mkdtempSync(join(tmpdir(), 'mn-apply-'))
  const ctx = fakeContext(`file:///${dir.replace(/\\/g, '/')}/profiles/desktop/#mnemosyne`)
  try {
    // Cordis mounts a plugin for its side effects and owns cleanup through
    // `ctx.effect`; `apply` itself returns nothing.
    apply(ctx, config)
    assert.ok(ctx.effects.length > 0, 'apply must register at least one effect')
    assert.ok(ctx.injections.length > 0, 'apply must request the tools and prompt services')
    return { ctx, dir }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

/** Run the registered effect disposers, newest first, ignoring teardown errors. */
function release(ctx, dir) {
  for (const dispose of ctx.effects.reverse()) {
    try {
      if (typeof dispose === 'function') dispose()
    } catch {
      // teardown of a half-built fake context is not what this test asserts
    }
  }
  rmSync(dir, { recursive: true, force: true })
}

test('apply: a null config (the Loader\'s shape for an empty row) mounts', () => {
  const { ctx, dir } = mount(null)
  assert.ok(true)
  release(ctx, dir)
})

test('apply: undefined, empty and populated configs all mount', () => {
  for (const config of [undefined, {}, { halfLifeDays: 30 }]) {
    const { ctx, dir } = mount(config)
    release(ctx, dir)
  }
})

test('config: null normalises to the defaults', () => {
  const config = normalizeConfig(null)
  assert.equal(config.autoLearn, true)
  assert.equal(config.halfLifeDays, 21)
  assert.equal(config.privacyMode, 'excerpt')
})

test('profile: read from the Loader base URL', () => {
  assert.equal(profileOf({ baseUrl: 'file:///C:/Users/x/.dsh/profiles/desktop/#mnemosyne' }), 'desktop')
  assert.equal(profileOf({ baseUrl: 'file:///C:/Users/x/.dsh/profiles/web/#mnemosyne' }), 'web')
  assert.equal(profileOf({}), process.env.DSH_PROFILE ?? '')
})

test('memory file: defaults under the profile name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mn-path-'))
  try {
    const config = normalizeConfig({ baseDir: dir })
    assert.equal(resolveMemoryFile(config, { profile: 'desktop' }), join(dir, 'desktop.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

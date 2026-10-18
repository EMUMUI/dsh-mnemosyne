/**
 * Verify the bundle metadata without a YAML parser: the patch must insert a row
 * naming this package, and package.json must point at both files.
 */
import fs from 'node:fs'

const text = fs.readFileSync('cordis.patch.yml', 'utf8')
if (!/^- insert:/m.test(text)) throw new Error('cordis.patch.yml must start a list with "- insert:"')
if (!/^ {4}- id: mnemosyne$/m.test(text)) throw new Error('the patch must insert the mnemosyne row')
if (!/^ {6}name: '?dsh-mnemosyne'?$/m.test(text)) throw new Error('the row must name the package')
if (/\t/.test(text)) throw new Error('YAML must not contain tab characters')

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
if (pkg.name !== 'dsh-mnemosyne') throw new Error(`unexpected package name ${pkg.name}`)
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('package.json must declare dsh.bundle.patch')
for (const entry of [pkg.main, pkg.dsh?.bundle?.patch]) {
  if (typeof entry !== 'string' || !fs.existsSync(entry)) throw new Error(`missing entry point: ${entry}`)
}

const mod = await import(new URL('../index.js', import.meta.url).href)
for (const name of ['apply', 'name', 'inject']) {
  if (!(name in mod)) throw new Error(`index.js must export ${name}`)
}
if (typeof mod.apply !== 'function') throw new Error('apply must be a function')
console.log('bundle metadata ok')

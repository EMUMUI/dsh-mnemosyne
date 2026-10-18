/**
 * Write serialisation for one brain file, shared by every Brain instance in
 * this process that points at it.
 *
 * Atomic rename already prevents a torn file, but two writers racing on the
 * same path could still let an older snapshot land last and erase newer
 * memories. The writer gives each path exactly one owner: a later instance
 * takes over from the earlier one (hot reload), and afterwards the earlier
 * instance's saves are refused instead of silently overwriting the owner's.
 */

/** path → current owner writer */
const owners = new Map()

export class BrainWriter {
  /**
   * @param {{ store: { filePath?: string, save: (options?: object) => boolean } }} brain
   */
  constructor(brain) {
    this.brain = brain
    this.filePath = brain.store.filePath ?? ''
    if (this.filePath !== '') owners.set(this.filePath, this)
  }

  /** Whether this writer still owns its file. */
  get isOwner() {
    return this.filePath === '' || owners.get(this.filePath) === this
  }

  /**
   * Persist the brain if this writer owns the file.
   * @returns {boolean} whether a write happened.
   */
  save() {
    if (!this.isOwner) return false
    return this.brain.store.save()
  }

  /** Give up ownership (plugin disposal). A newer owner is left alone. */
  release() {
    if (this.filePath !== '' && owners.get(this.filePath) === this) owners.delete(this.filePath)
  }
}

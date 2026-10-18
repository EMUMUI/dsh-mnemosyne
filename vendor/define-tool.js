/**
 * Minimal, faithful port of the subset of `defineTool` from
 * `@deepseek-ai/dsh-tools` that Mnemosyne needs.
 *
 * The real helper lives in the DSH runtime, which is not published on npm and
 * is not resolvable from an out-of-tree profile package. Rather than depending
 * on it (which would break the `file:`/tarball install path), we build the same
 * `ToolDefinition` shape here: an implicit open parameter object compiled to
 * raw JSON Schema plus the canonical `output` projection. The registry accepts
 * raw definitions just as it accepts `defineTool` output, so behaviour is
 * identical; this file keeps the ergonomics (typed args in editors, `required`
 * annotation, soft-failing presenters).
 *
 * Registered definitions are never mutated afterwards, held frozen, and their
 * `execute` receives arguments already validated by the registry itself.
 */

/** Compile an author property spec into a JSON Schema node. */
function compileNode(spec, path) {
  const { required, description, enum: allowed, const: constant, ...rest } = spec
  const node = { ...rest }
  if (description !== undefined) node.description = description
  if (allowed !== undefined) node.enum = allowed
  if (constant !== undefined) node.const = constant
  switch (node.type) {
    case 'json':
      delete node.type // annotation-only schema: any lossless JSON value
      if (node.properties !== undefined) delete node.properties
      break
    case 'object':
      node.properties = Object.fromEntries(
        Object.entries(node.properties ?? {}).map(([key, child]) => [key, compileNode(child, `${path}.${key}`)]),
      )
      node.additionalProperties ??= true
      break
    case 'array':
      if (node.items !== undefined) node.items = compileNode(node.items, `${path}[]`)
      break
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
      break
    default:
      if (Array.isArray(node.oneOf)) {
        node.oneOf = node.oneOf.map((branch, index) => compileNode(branch, `${path}.oneOf[${index}]`))
      }
  }
  if (node.properties === undefined) delete node.properties
  if (node.items === undefined) delete node.items
  return node
}

/**
 * Compile an implicit parameter map (each `required: true` marks a required key).
 * @param {Record<string, object>} parameters
 * @returns {object} raw JSON Schema with an object root
 */
export function compileParameters(parameters) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(parameters)) {
    properties[key] = compileNode(spec, `parameters.${key}`)
    if (spec.required === true) required.push(key)
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}

/**
 * Define a tool the way `defineTool` does: validated arguments in, canonical
 * value out, `output.render` for the model, `presentationMeta` for replayable
 * UI metadata.
 * @param {object} options
 * @returns {object} a registry-ready ToolDefinition
 */
export function defineTool(options) {
  if (typeof options?.name !== 'string' || options.name === '') throw new TypeError('defineTool: name is required')
  if (typeof options.description !== 'string') throw new TypeError(`defineTool(${options.name}): description is required`)
  if (typeof options.execute !== 'function') throw new TypeError(`defineTool(${options.name}): execute is required`)
  const output = options.output
  if (output === undefined || typeof output.render !== 'function') {
    throw new TypeError(`defineTool(${options.name}): output.render is required`)
  }
  const parameters = compileParameters(options.parameters ?? {})
  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: compileNode(output.schema ?? { type: 'json' }, 'output.schema'),
      render: (args, value) => output.render(args, value),
      ...(typeof output.presentationMeta === 'function'
        ? { presentationMeta: (args, value) => output.presentationMeta(args, value) }
        : {}),
    },
    async execute(args, exec) {
      return options.execute(args, exec)
    },
  }
  if (typeof options.isConcurrencySafe === 'function') {
    tool.isConcurrencySafe = args => options.isConcurrencySafe(args)
  }
  return Object.freeze(tool)
}

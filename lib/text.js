/**
 * Extract the user's own words from a model-facing message: text blocks only,
 * skipping reasoning and tool blocks.
 * @param {object} message
 * @returns {string}
 */
export function userText(message) {
  const parts = message?.content
  if (!Array.isArray(parts)) return ''
  return parts
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}

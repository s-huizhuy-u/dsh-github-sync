/**
 * One error type for every failure this plugin reports to the model.
 *
 * The harness turns a thrown value into a tool failure, so the `code` is the
 * machine-readable half and `message` is the sentence the model reads. Keeping
 * a single type means the tool wrapper never has to guess how to describe an
 * unexpected failure.
 */
export class GitHubSyncError extends Error {
  /**
   * @param {string} code - stable SCREAMING_CASE identifier for this failure.
   * @param {string} message - one actionable sentence for the model.
   * @param {object} [options] - optional narrowing details.
   * @param {number} [options.status] - HTTP status when a GitHub call caused it.
   * @param {string} [options.nextStep] - what the user should do next.
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'GitHubSyncError'
    this.code = code
    if (options.status !== undefined) this.status = options.status
    if (options.nextStep !== undefined) this.nextStep = options.nextStep
  }
}

/**
 * Reduce any thrown value to a `{ code, message, nextStep }` triple.
 *
 * Unknown values are reported as a generic failure rather than leaking a stack
 * trace into the transcript.
 * @param {unknown} error - whatever was thrown.
 * @returns {{ code: string, message: string, nextStep: string }} safe description.
 */
export function describeError(error) {
  if (error instanceof GitHubSyncError) {
    return { code: error.code, message: error.message, nextStep: error.nextStep ?? '' }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'FAILED', message, nextStep: '' }
}

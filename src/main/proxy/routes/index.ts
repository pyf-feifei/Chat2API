/**
 * Proxy Service Module - Route Index
 * Export all routes
 */

import chatRouter from './chat'
import modelsRouter from './models'
import completionsRouter from './completions'
import geminiRouter from './gemini'
import responsesRouter from './responses'
import anthropicRouter from './anthropic'

export {
  chatRouter,
  modelsRouter,
  completionsRouter,
  geminiRouter,
  responsesRouter,
  anthropicRouter,
}

const allRoutes = [
  chatRouter,
  modelsRouter,
  completionsRouter,
  geminiRouter,
  responsesRouter,
  anthropicRouter,
]
export default allRoutes

export default function longOutputIntent(ctx, config = {}) {
  const maxTokens = Number(config.maxTokens)
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error('long-output-intent-plugin: maxTokens must be a positive safe integer')
  }
  ctx.on('agent/request', async (_payload, next) => {
    const request = await next()
    return request.maxTokens === maxTokens ? request : { ...request, maxTokens }
  })
}

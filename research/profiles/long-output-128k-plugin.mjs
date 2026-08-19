export default function explicitOutputIntent(ctx) {
  ctx.on('agent/request', async (_payload, next) => {
    const request = await next()
    return request.maxTokens === 131072 ? request : { ...request, maxTokens: 131072 }
  })
}

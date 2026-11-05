export function onRequest(ctx) {
  console.log("[skillspector] Handling request for:", ctx.model);
  return {
    metadata: {
      skillspector: {
        model: ctx.model,
        timestamp: new Date().toISOString()
      }
    }
  };
}

export default {
  hooks: { onRequest }
};
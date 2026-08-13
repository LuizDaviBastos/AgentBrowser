export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Bah Browser API',
    version: '0.1.0',
  },
  paths: {
    '/health': {
      get: {
        responses: { '200': { description: 'ok' } },
      },
    },
    '/jobs': {
      get: { responses: { '200': { description: 'job list' } } },
      post: { responses: { '201': { description: 'job created' } } },
    },
    '/jobs/{id}': {
      get: { responses: { '200': { description: 'final job output or full record with ?view=record' } } },
      put: { responses: { '200': { description: 'job updated' } } },
      delete: { responses: { '200': { description: 'job deleted' } } },
    },
    '/jobs/{id}/run': {
      post: { responses: { '200': { description: 'run job and wait for final output' } } },
    },
    '/jobs/{id}/cancel': {
      post: { responses: { '200': { description: 'job canceled' } } },
    },
    '/jobs/{id}/retry': {
      post: { responses: { '200': { description: 'job retried' } } },
    },
    '/jobs/{id}/wait': {
      post: { responses: { '200': { description: 'job completed' } } },
    },
  },
};

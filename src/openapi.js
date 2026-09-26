// OpenAPI 3.1 spec for the 402 Index API — served at GET /api/v1/openapi.json

export const openapiSpec = {
  openapi: '3.1.0',
  info: {
    title: '402 Index API',
    description: 'Public API for the 402 Index — a protocol-agnostic directory of paid APIs (L402, x402, MPP) for AI agents.',
    version: '1.0.0',
    contact: { email: 'hello@402index.io' },
  },
  servers: [
    { url: 'https://402index.io', description: 'Production' },
  ],
  paths: {
    '/api/v1/services': {
      get: {
        summary: 'Search and filter paid API services',
        operationId: 'listServices',
        tags: ['Services'],
        parameters: [
          { name: 'protocol', in: 'query', schema: { type: 'string', enum: ['L402', 'x402', 'MPP'] }, description: 'Filter by payment protocol' },
          { name: 'category', in: 'query', schema: { type: 'string' }, description: 'Filter by category (prefix match — "crypto" matches "crypto/nft")' },
          { name: 'health', in: 'query', schema: { type: 'string', enum: ['healthy', 'degraded', 'down', 'unknown'] }, description: 'Filter by health status' },
          { name: 'source', in: 'query', schema: { type: 'string', enum: ['bazaar', 'satring', 'l402apps', 'sponge', 'payai', 'l402directory', 'mpp', 'discovery', 'self-registered'] }, description: 'Filter by data source' },
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Hybrid semantic + LIKE search. When q is present and no explicit sort is specified, results are re-ranked using a 5-tier composite: (A) exact name match, (B) LIKE name, (C) LIKE description, (D) cosine similarity from embeddings, (E) default order. Semantic search requires embeddings to be backfilled. Falls back to LIKE-only if the embedding service is unavailable.' },
          { name: 'featured', in: 'query', schema: { type: 'boolean' }, description: 'Only return featured services' },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['name', 'price', 'latency', 'uptime', 'reliability'] }, description: 'Sort field' },
          { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] }, description: 'Sort order' },
          { name: 'payment_valid', in: 'query', schema: { type: 'boolean' }, description: 'Only x402 services with verified payment requirements' },
          { name: 'verified', in: 'query', schema: { type: 'boolean' }, description: 'Only payment-verified services (x402: valid payment headers, L402/MPP: healthy). Domain-verified services ranked first. Recommended for agents making payment decisions.' },
          { name: 'l402_format', in: 'query', schema: { type: 'string', enum: ['v2_tlv', 'v1_binary', 'v0_text', 'json', 'unknown'] }, description: 'Filter L402 endpoints by macaroon token format' },
          { name: 'lnget_compatible', in: 'query', schema: { type: 'boolean' }, description: 'Filter L402 endpoints by lnget client compatibility' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 }, description: 'Results per page' },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 }, description: 'Pagination offset' },
        ],
        responses: {
          '200': {
            description: 'Paginated list of services',
            headers: {
              'X-402index-Search-Degraded': {
                description: 'Present when semantic search was attempted but failed. Indicates the reason the response was served from LIKE-only fallback.',
                schema: { type: 'string', enum: ['no-api-key', 'embed-timeout', 'embed-error', 'circuit-open', 'vec-deadline', 'js-fallback-too-large'] },
              },
              'X-402index-Semantic-Cap': {
                description: "'true' when semantic neighbors were truncated at the top-K boundary. Consumers should treat pagination beyond this window as unreliable. Always present on every /api/v1/services response.",
                schema: { type: 'string', enum: ['true', 'false'] },
              },
            },
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                services: { type: 'array', items: { $ref: '#/components/schemas/Service' } },
                total: { type: 'integer' },
                limit: { type: 'integer' },
                offset: { type: 'integer' },
              },
            } } },
          },
          '402': {
            description: 'L402 payment required (rate limit exceeded). The WWW-Authenticate header contains a Lightning invoice.',
            headers: {
              'WWW-Authenticate': { schema: { type: 'string' }, description: 'L402 macaroon="<macaroon>", invoice="<bolt11>"' },
            },
          },
        },
      },
    },

    '/api/v1/services/{id}': {
      get: {
        summary: 'Get full details for a single service',
        operationId: 'getService',
        tags: ['Services'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Service ID' },
        ],
        responses: {
          '200': {
            description: 'Service with health check history',
            content: { 'application/json': { schema: {
              allOf: [
                { $ref: '#/components/schemas/Service' },
                { type: 'object', properties: {
                  health_checks: { type: 'array', items: { $ref: '#/components/schemas/HealthCheck' } },
                  related_services: { type: 'array', items: { type: 'object', properties: {
                    id: { type: 'string' },
                    protocol: { type: 'string', enum: ['L402', 'x402', 'MPP'] },
                    health_status: { type: ['string', 'null'] },
                    price_sats: { type: ['integer', 'null'] },
                    price_usd: { type: ['number', 'null'] },
                    payment_asset: { type: ['string', 'null'] },
                    payment_network: { type: ['string', 'null'] },
                    reliability_score: { type: ['number', 'null'] },
                    uptime_30d: { type: ['number', 'null'] },
                    latency_p50_ms: { type: ['integer', 'null'] },
                  } }, description: 'Other protocol listings for the same URL (same endpoint, different payment protocol)' },
                } },
              ],
            } } },
          },
          '404': { description: 'Service not found' },
        },
      },
      patch: {
        summary: 'Edit a listing by verified domain owner',
        operationId: 'editService',
        tags: ['Domain Verification'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Service ID' },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['domain', 'verification_token'],
            properties: {
              domain: { type: 'string', description: 'Verified domain' },
              verification_token: { type: 'string', description: 'Token from domain claim (ongoing credential)' },
              name: { type: 'string' },
              description: { type: 'string' },
              category: { type: 'string' },
              price_usd: { type: 'number' },
              price_sats: { type: 'integer' },
              payment_asset: { type: 'string' },
              payment_network: { type: 'string' },
            },
          } } },
        },
        responses: {
          '200': {
            description: 'Service updated',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Service' } } },
          },
          '400': { description: 'Missing domain/token, no valid fields, or field exceeds max length' },
          '403': { description: 'Invalid token, unverified domain, or domain mismatch' },
          '404': { description: 'Service not found' },
        },
      },
      delete: {
        summary: 'Soft-delete a listing by verified domain owner',
        operationId: 'deleteService',
        tags: ['Domain Verification'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Service ID' },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['domain', 'verification_token'],
            properties: {
              domain: { type: 'string', description: 'Verified domain' },
              verification_token: { type: 'string', description: 'Token from domain claim (ongoing credential)' },
            },
          } } },
        },
        responses: {
          '200': {
            description: 'Service soft-deleted (or already deleted)',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                id: { type: 'integer' },
              },
            } } },
          },
          '400': { description: 'Missing domain or verification_token' },
          '403': { description: 'Invalid token, unverified domain, or domain mismatch' },
          '404': { description: 'Service not found' },
        },
      },
    },

    '/api/v1/services/bulk-delete': {
      post: {
        summary: 'Bulk soft-delete listings by verified domain owner',
        operationId: 'bulkDeleteServices',
        tags: ['Domain Verification'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['ids', 'domain', 'verification_token'],
            properties: {
              ids: { type: 'array', items: { type: 'integer' }, maxItems: 25, description: 'Service IDs to delete (max 25)' },
              domain: { type: 'string', description: 'Verified domain' },
              verification_token: { type: 'string', description: 'Token from domain claim' },
            },
          } } },
        },
        responses: {
          '200': {
            description: 'Bulk delete results',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                deleted: { type: 'array', items: { type: 'integer' }, description: 'IDs successfully deleted' },
                skipped: { type: 'array', items: { type: 'integer' }, description: 'IDs skipped (wrong domain, not found, already deleted)' },
                reasons: { type: 'object', additionalProperties: { type: 'string' }, description: 'Reason each skipped ID was skipped' },
              },
            } } },
          },
          '400': { description: 'Missing fields, ids not an array, empty ids, or exceeds 25 limit' },
          '403': { description: 'Invalid token or unverified domain' },
        },
      },
    },

    '/api/v1/health': {
      get: {
        summary: 'System health and sync status',
        operationId: 'getHealth',
        tags: ['System'],
        responses: {
          '200': {
            description: 'Health status with endpoint counts, protocol breakdown, and sync timestamps',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                status: { type: 'string', enum: ['ok'] },
                total_endpoints: { type: 'integer' },
                distinct_services: { type: 'integer' },
                distinct_providers: { type: 'integer' },
                by_protocol: { type: 'object', additionalProperties: {
                  type: 'object',
                  properties: {
                    endpoints: { type: 'integer' },
                    services: { type: 'integer' },
                    providers: { type: 'integer' },
                  },
                } },
                by_health: { type: 'object', additionalProperties: { type: 'integer' } },
                by_source: { type: 'object', additionalProperties: { type: 'integer' } },
                last_bazaar_sync: { type: ['string', 'null'] },
                last_satring_sync: { type: ['string', 'null'] },
                last_l402apps_sync: { type: ['string', 'null'] },
                last_mpp_sync: { type: ['string', 'null'] },
                last_health_check_run: { type: ['string', 'null'] },
              },
            } } },
          },
        },
      },
    },

    '/api/v1/categories': {
      get: {
        summary: 'List all categories with per-protocol endpoint counts',
        operationId: 'listCategories',
        tags: ['Discovery'],
        responses: {
          '200': {
            description: 'Category tree with L402/x402/MPP breakdown',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                categories: { type: 'object', additionalProperties: { $ref: '#/components/schemas/Category' } },
              },
            } } },
          },
        },
      },
    },

    '/api/v1/export.csv': {
      get: {
        summary: 'Export full directory as CSV (L402 payment required)',
        operationId: 'exportCsv',
        tags: ['Services'],
        responses: {
          '200': {
            description: 'CSV file download',
            content: { 'text/csv': { schema: { type: 'string' } } },
          },
          '402': {
            description: 'L402 payment required (500 sats). Pay the Lightning invoice to download.',
            headers: {
              'WWW-Authenticate': { schema: { type: 'string' }, description: 'L402 macaroon="<macaroon>", invoice="<bolt11>"' },
            },
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                error: { type: 'string' },
                invoice: { type: 'string' },
                macaroon: { type: 'string' },
                price_sats: { type: 'integer' },
              },
            } } },
          },
        },
      },
    },

    '/api/v1/stats/snapshots': {
      get: {
        summary: 'Historical daily snapshots of directory statistics',
        operationId: 'getSnapshots',
        tags: ['System'],
        parameters: [
          { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 }, description: 'Number of days of history' },
        ],
        responses: {
          '200': {
            description: 'Array of daily snapshots',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                snapshots: { type: 'array', items: { $ref: '#/components/schemas/DailySnapshot' } },
                count: { type: 'integer' },
              },
            } } },
          },
        },
      },
    },

    '/api/v1/register': {
      post: {
        summary: 'Register a paid API endpoint (L402, x402, or MPP)',
        operationId: 'registerService',
        tags: ['Registration'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['url', 'name', 'protocol'],
            properties: {
              url: { type: 'string', description: 'The endpoint URL to register' },
              name: { type: 'string', description: 'Display name for the service' },
              protocol: { type: 'string', enum: ['L402', 'x402', 'MPP'], description: 'Payment protocol (case-insensitive)' },
              description: { type: 'string' },
              category: { type: 'string' },
              contact_email: { type: 'string', format: 'email' },
              http_method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], default: 'GET' },
              probe_body: { type: 'string', description: 'JSON body for health check probes' },
              price_sats: { type: 'integer' },
              price_usd: { type: 'number' },
              payment_asset: { type: 'string' },
              payment_network: { type: 'string' },
              provider: { type: 'string' },
            },
          } } },
        },
        responses: {
          '201': {
            description: 'Service registered (pending review)',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                service: { $ref: '#/components/schemas/Service' },
                also_registered: { type: 'array', items: { $ref: '#/components/schemas/Service' }, description: 'Additional protocol listings auto-created when dual-protocol support is detected' },
                verification: { type: 'object', properties: {
                  protocol: { type: 'string', enum: ['L402', 'x402', 'MPP'] },
                  httpStatus: { type: 'integer' },
                  scheme: { type: 'string', description: 'L402 only' },
                  hasMacaroon: { type: 'boolean', description: 'L402 only' },
                  hasInvoice: { type: 'boolean', description: 'L402 only' },
                  accepts: { type: 'array', description: 'x402 only — payment requirements' },
                  assetKnown: { type: 'boolean', description: 'x402 only' },
                  version: { type: 'integer', description: 'x402 only (1 or 2)' },
                  method: { type: 'string', description: 'MPP only — payment method (e.g. tempo, stripe)' },
                  intent: { type: 'string', description: 'MPP only — payment intent' },
                  id: { type: 'string', description: 'MPP only — challenge ID' },
                  realm: { type: 'string', description: 'MPP only — realm' },
                } },
              },
            } } },
          },
          '400': { description: 'Missing required fields or invalid input' },
          '422': {
            description: 'Verification failed — endpoint did not return a valid protocol challenge',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                error: { type: 'string' },
                detail: { type: 'string' },
                probe: { type: 'object', properties: {
                  httpStatus: { type: 'integer', description: 'HTTP status code received from the endpoint' },
                  headersPresent: { type: 'object', properties: {
                    'WWW-Authenticate': { type: 'boolean' },
                    'PAYMENT-REQUIRED': { type: 'boolean' },
                  }, description: 'Which payment-related headers were present' },
                  bodySnippet: { type: ['string', 'null'], description: 'First bytes of response body' },
                  detectedProtocols: { type: 'array', items: { type: 'object', properties: {
                    protocol: { type: 'string' },
                    valid: { type: 'boolean' },
                  } }, description: 'All protocols detected regardless of which was requested' },
                } },
                suggestedProtocol: { type: 'string', description: 'Present only when a different protocol was detected than what was requested' },
              },
            } } },
          },
          '429': { description: 'Rate limited (10 registrations per hour per IP)' },
        },
      },
    },

    '/api/v1/opportunities': {
      get: {
        summary: 'Ecosystem gap analysis',
        operationId: 'listOpportunities',
        tags: ['Discovery'],
        responses: {
          '200': {
            description: 'Identified gaps in protocol and category coverage',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                opportunities: { type: 'array', items: { $ref: '#/components/schemas/Opportunity' } },
                total: { type: 'integer' },
              },
            } } },
          },
        },
      },
    },

    '/feed.xml': {
      get: {
        summary: 'RSS 2.0 feed of indexed services',
        operationId: 'getRssFeed',
        tags: ['Distribution'],
        parameters: [
          { name: 'protocol', in: 'query', schema: { type: 'string', enum: ['L402', 'x402', 'MPP'] }, description: 'Filter by protocol' },
          { name: 'health', in: 'query', schema: { type: 'string', enum: ['healthy', 'degraded', 'down'] }, description: 'Filter by health status' },
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['new'] }, description: '"new" for services added in the last 7 days' },
        ],
        responses: {
          '200': {
            description: 'RSS/XML feed with l402:service namespace extensions',
            content: { 'application/rss+xml': { schema: { type: 'string' } } },
          },
        },
      },
    },

    '/api/v1/webhooks': {
      post: {
        summary: 'Register a webhook for real-time notifications',
        operationId: 'createWebhook',
        tags: ['Webhooks'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['url', 'secret'],
            properties: {
              url: { type: 'string', description: 'HTTPS callback URL' },
              secret: { type: 'string', description: 'Shared secret for HMAC-SHA256 signing (min 16 chars)' },
              events: { type: 'string', description: 'Comma-separated: service.new, service.health_changed, service.down' },
              protocol_filter: { type: 'string', enum: ['L402', 'x402', 'MPP'] },
            },
          } } },
        },
        responses: {
          '201': {
            description: 'Webhook registered',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                secret: { type: 'string' },
              },
            } } },
          },
        },
      },
    },

    '/api/v1/webhooks/{id}': {
      get: {
        summary: 'Check webhook status',
        operationId: 'getWebhook',
        tags: ['Webhooks'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'X-Webhook-Secret', in: 'header', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Webhook details' },
          '401': { description: 'Missing or invalid X-Webhook-Secret' },
          '404': { description: 'Webhook not found' },
        },
      },
      delete: {
        summary: 'Delete a webhook',
        operationId: 'deleteWebhook',
        tags: ['Webhooks'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'X-Webhook-Secret', in: 'header', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Webhook deleted' },
          '401': { description: 'Missing or invalid X-Webhook-Secret' },
          '404': { description: 'Webhook not found' },
        },
      },
    },

    '/api/v1/claim': {
      post: {
        summary: 'Initiate a domain claim for provider listing edits',
        operationId: 'claimDomain',
        tags: ['Domain Verification'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['domain'],
            properties: {
              domain: { type: 'string', description: 'Hostname to claim (e.g. "api.example.com"). No protocol, path, or port.' },
              contact_email: { type: 'string', format: 'email', description: 'Optional contact email for the provider' },
            },
          } } },
        },
        responses: {
          '201': {
            description: 'New domain claim created',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                domain: { type: 'string' },
                verification_token: { type: 'string', description: '64-char hex token (256 bits of entropy)' },
                verification_url: { type: 'string', description: 'URL where the token file must be placed' },
                instructions: { type: 'string' },
              },
            } } },
          },
          '200': { description: 'Existing pending claim updated with new token' },
          '400': { description: 'Invalid domain format' },
          '409': { description: 'Domain already verified by another provider' },
          '429': { description: 'Rate limited (10 claims per hour per IP)' },
        },
      },
    },

    '/api/v1/claim/revoke': {
      post: {
        summary: 'Revoke a verified domain claim',
        operationId: 'revokeDomainClaim',
        tags: ['Domain Verification'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['domain', 'verification_token'],
            properties: {
              domain: { type: 'string', description: 'Verified domain to revoke' },
              verification_token: { type: 'string', description: 'Current token (proves ownership)' },
            },
          } } },
        },
        responses: {
          '200': {
            description: 'Claim revoked',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                domain: { type: 'string' },
                status: { type: 'string', enum: ['revoked'] },
                message: { type: 'string' },
              },
            } } },
          },
          '400': { description: 'Missing domain or verification_token' },
          '403': { description: 'Invalid token or no verified claim for this domain' },
          '404': { description: 'No claim found for this domain' },
        },
      },
    },

    '/api/v1/admin/domains/{domain}/reset': {
      post: {
        summary: 'Reset a domain verification token (admin only)',
        operationId: 'adminResetDomain',
        tags: ['Admin'],
        parameters: [
          { name: 'domain', in: 'path', required: true, schema: { type: 'string' }, description: 'Domain to reset (e.g. api.example.com)' },
        ],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Domain reset. Returns new token, hash, and instructions.',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                reset: { type: 'boolean' },
                domain: { type: 'string' },
                new_status: { type: 'string', enum: ['pending'] },
                expires_at: { type: 'string', description: 'New 72-hour expiry (SQLite datetime format)' },
                verification_token: { type: 'string', description: '64-char hex token (256 bits)' },
                verification_hash: { type: 'string', description: 'SHA-256 of the token (place at .well-known)' },
                verification_url: { type: 'string' },
                instructions: { type: 'string' },
              },
            } } },
          },
          '401': { description: 'Missing or invalid admin authorization' },
          '404': { description: 'No claim found for this domain' },
        },
      },
    },

    '/api/v1/claim/verify': {
      post: {
        summary: 'Verify a pending domain claim',
        operationId: 'verifyDomainClaim',
        tags: ['Domain Verification'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['domain'],
            properties: {
              domain: { type: 'string', description: 'Domain to verify' },
            },
          } } },
        },
        responses: {
          '200': {
            description: 'Domain verified successfully',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                domain: { type: 'string' },
                status: { type: 'string', enum: ['verified'] },
                services_count: { type: 'integer', description: 'Number of services under this domain' },
              },
            } } },
          },
          '400': { description: 'Invalid domain format' },
          '404': { description: 'No pending claim found for this domain' },
          '409': { description: 'Domain already verified' },
          '410': { description: 'Claim expired (72-hour window). Initiate a new claim.' },
          '422': { description: 'Verification failed (token mismatch, redirect, unreachable, SSRF blocked, or response too large)' },
        },
      },
    },

  },

  components: {
    schemas: {
      Service: {
        type: 'object',
        required: ['id', 'name', 'url', 'protocol'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: ['string', 'null'] },
          url: { type: 'string', format: 'uri' },
          protocol: { type: 'string', enum: ['L402', 'x402', 'MPP'] },
          price_sats: { type: ['integer', 'null'] },
          price_usd: { type: ['number', 'null'] },
          payment_asset: { type: ['string', 'null'] },
          payment_network: { type: ['string', 'null'] },
          category: { type: ['string', 'null'] },
          provider: { type: ['string', 'null'] },
          source: { type: 'string' },
          featured: { type: ['integer', 'null'] },
          health_status: { type: ['string', 'null'], enum: ['healthy', 'degraded', 'down', 'unknown', null] },
          uptime_30d: { type: ['number', 'null'] },
          latency_p50_ms: { type: ['integer', 'null'] },
          last_checked: { type: ['string', 'null'], format: 'date-time' },
          registered_at: { type: ['string', 'null'], format: 'date-time' },
          http_method: { type: ['string', 'null'] },
          reliability_score: { type: ['number', 'null'] },
          x402_payment_valid: { type: ['integer', 'null'] },
          domain_verified: { type: ['integer', 'null'], enum: [0, 1, null], description: 'Provider proved domain ownership via .well-known DNS challenge' },
          x402_facilitator_reachable: { type: ['integer', 'null'] },
          x402_asset_known: { type: ['integer', 'null'] },
          l402_format: { type: ['string', 'null'], enum: ['v2_tlv', 'v1_binary', 'v0_text', 'json', 'unknown', null], description: 'L402 macaroon token format. See github.com/lightninglabs/L402/blob/master/macaroon-spec.md' },
          lnget_compatible: { type: ['integer', 'null'], enum: [1, 0, null], description: 'Whether this endpoint works with Lightning Labs lnget client (1=yes, 0=no, null=not L402)' },
          related_protocols: { type: 'array', items: { type: 'string' }, description: 'Other payment protocols this URL is also registered under (e.g. if an L402 service also has an x402 listing)' },
        },
      },
      HealthCheck: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          checked_at: { type: 'string', format: 'date-time' },
          status: { type: 'string' },
          response_time_ms: { type: ['integer', 'null'] },
          http_status: { type: ['integer', 'null'] },
          error_message: { type: ['string', 'null'] },
        },
      },
      DailySnapshot: {
        type: 'object',
        properties: {
          snapshot_date: { type: 'string', format: 'date' },
          total_endpoints: { type: 'integer' },
          healthy_endpoints: { type: 'integer' },
          degraded_endpoints: { type: 'integer' },
          down_endpoints: { type: 'integer' },
          l402_count: { type: 'integer' },
          x402_count: { type: 'integer' },
          mpp_count: { type: 'integer' },
          avg_latency_ms: { type: ['number', 'null'] },
          avg_uptime: { type: ['number', 'null'] },
        },
      },
      Category: {
        type: 'object',
        properties: {
          L402: { type: 'integer' },
          x402: { type: 'integer' },
          MPP: { type: 'integer' },
          total: { type: 'integer' },
          subcategories: { type: 'object', additionalProperties: {
            type: 'object',
            properties: {
              L402: { type: 'integer' },
              x402: { type: 'integer' },
              MPP: { type: 'integer' },
              total: { type: 'integer' },
            },
          } },
        },
      },
      Opportunity: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          category: { type: ['string', 'null'] },
          protocol: { type: ['string', 'null'] },
          message: { type: 'string' },
          severity: { type: 'string' },
        },
      },
    },
  },
}

// Generate markdown documentation from the OpenAPI spec
export function generateMarkdownDocs(spec) {
  const lines = []
  lines.push(`# ${spec.info.title}`)
  lines.push('')
  lines.push(spec.info.description)
  lines.push('')
  lines.push(`Base URL: ${spec.servers[0].url}`)
  lines.push('')

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      lines.push('---')
      lines.push('')
      lines.push(`## ${method.toUpperCase()} ${path}`)
      lines.push('')
      lines.push(op.summary || '')
      lines.push('')

      // Parameters
      if (op.parameters?.length) {
        lines.push('**Parameters:**')
        lines.push('')
        lines.push('| Name | In | Type | Required | Description |')
        lines.push('|------|----|------|----------|-------------|')
        for (const p of op.parameters) {
          const type = p.schema?.enum ? `enum: ${p.schema.enum.join(', ')}` : (p.schema?.type || 'string')
          lines.push(`| ${p.name} | ${p.in} | ${type} | ${p.required ? 'Yes' : 'No'} | ${p.description || ''} |`)
        }
        lines.push('')
      }

      // Request body
      if (op.requestBody) {
        const schema = op.requestBody.content?.['application/json']?.schema
        if (schema?.properties) {
          lines.push('**Request Body:**')
          lines.push('')
          lines.push('| Name | Type | Required | Description |')
          lines.push('|------|------|----------|-------------|')
          const required = schema.required || []
          for (const [name, prop] of Object.entries(schema.properties)) {
            const type = prop.enum ? `enum: ${prop.enum.join(', ')}` : (prop.type || 'string')
            lines.push(`| ${name} | ${type} | ${required.includes(name) ? 'Yes' : 'No'} | ${prop.description || ''} |`)
          }
          lines.push('')
        }
      }

      // Responses
      lines.push('**Responses:**')
      lines.push('')
      for (const [code, resp] of Object.entries(op.responses)) {
        lines.push(`- **${code}**: ${resp.description}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

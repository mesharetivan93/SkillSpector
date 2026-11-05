/**
 * FreeLLMAPI plugin for OmniRoute.
 *
 * OmniRoute runs disk-installed plugins in a child Node process (see
 * src/lib/plugins/loader.ts in the omniroute package). That host imports this
 * file, takes `default` as the hook table and calls `default[hook](payload)`
 * with exactly ONE argument:
 *
 *   onRequest                 payload = ctx -> { metadata?, body?, blocked? } | void
 *   onResponse                payload = { ctx, response }; result is ignored
 *   onActivate / onDeactivate payload = { name, version, manifest }
 *
 * Two constraints shape this file:
 *  - No `import ... from 'omniroute/...'`. The child cannot resolve that
 *    package from ~/.omniroute/plugins, so such an import kills the plugin.
 *  - Blocking hooks get a 10s budget and the host kills the child on timeout
 *    without respawning it. onRequest therefore never waits on the network:
 *    it reads cached health and refreshes it in the background.
 *
 * The child also gets a filtered environment (no API keys), which is why the
 * probe targets the unauthenticated /readyz endpoint and nothing under /v1.
 */

const PLUGIN_NAME = 'freellmapi';

export const DEFAULTS = Object.freeze({
  baseUrl: 'http://localhost:3001',
  /** Unauthenticated readiness probe: 2xx only while at least one upstream is serviceable. */
  readyPath: '/readyz',
  ttlMs: 15_000,
  timeoutMs: 3_000,
});

/** Models that FreeLLMAPI serves through its fusion / free-pool entry points. */
export const FREE_ROUTING_PATTERNS = Object.freeze([
  /^fusion$/i,
  /^openrouter\/fusion$/i,
  /^openrouter\/free$/i,
  /^auto\/best-free$/i,
  /^auto\/best-merge$/i,
]);

export function shouldRouteToFreeLLM(model) {
  return typeof model === 'string' && FREE_ROUTING_PATTERNS.some((rx) => rx.test(model));
}

const STATE_TEXT = Object.freeze({
  up: 'available',
  degraded: 'reachable but not ready',
  down: 'unreachable',
  unknown: 'status unknown',
});

export function hintFor(state, matched) {
  if (!matched) return `FreeLLMAPI ${STATE_TEXT[state]}; model not matched`;
  if (state === 'up') return 'Route to FreeLLMAPI upstream for free synthesis';
  return `Model matches the free-routing patterns but FreeLLMAPI is ${STATE_TEXT[state]}`;
}

/**
 * Cached readiness probe with stale-while-revalidate semantics.
 *
 * `poll()` never waits: it returns the last snapshot and, when that is older
 * than `ttlMs`, starts one background refresh (concurrent callers share it).
 * `refresh()` awaits a fresh probe. Neither ever rejects.
 *
 * States: 'unknown' (not probed yet), 'up' (2xx), 'degraded' (answered with a
 * non-2xx status, e.g. 503 when no upstream is serviceable), 'down' (no answer).
 */
export function createHealthMonitor({
  url,
  ttlMs = DEFAULTS.ttlMs,
  timeoutMs = DEFAULTS.timeoutMs,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  onTransition = () => {},
} = {}) {
  let snapshot = { state: 'unknown', checkedAt: 0 };
  let inflight = null;

  async function probe() {
    let next;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      let body;
      try {
        body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
      } catch {
        body = null;
      }
      // /readyz returns 200 even when status is "unavailable" (no upstreams).
      // FreeLLMAPI uses "ok" (not "available") as the ready status.
      // Treat non-2xx or body.status not in accepted values as degraded.
      const READY_STATUS = new Set(['available', 'ok']);
      if (!res.ok || (body && !READY_STATUS.has(body.status))) {
        next = { state: 'degraded', checkedAt: now(), httpStatus: res.status };
      } else {
        next = { state: 'up', checkedAt: now(), httpStatus: res.status };
      }
      try {
        await res.body?.cancel();
      } catch {
        // Releasing the socket is best-effort.
      }
    } catch (err) {
      next = {
        state: 'down',
        checkedAt: now(),
        reason: err?.name === 'TimeoutError' ? 'timeout' : 'unreachable',
      };
    }
    const prev = snapshot;
    snapshot = next;
    if (prev.state !== next.state) {
      try {
        onTransition(prev, next);
      } catch {
        // A logging failure must not break health tracking.
      }
    }
    return snapshot;
  }

  function refresh() {
    inflight ??= probe().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function poll() {
    if (now() - snapshot.checkedAt >= ttlMs) refresh().catch(() => {});
    return snapshot;
  }

  return { peek: () => snapshot, poll, refresh };
}

const consoleLog = {
  info: (msg) => console.log(`[${PLUGIN_NAME}] ${msg}`),
  warn: (msg) => console.error(`[${PLUGIN_NAME}] ${msg}`),
};

/**
 * Build the hook table. The default export uses real dependencies; tests inject
 * `fetchImpl`, `now` and `log`.
 */
export function createPlugin({ config = {}, fetchImpl, now, log = consoleLog } = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const readyUrl = cfg.baseUrl + cfg.readyPath;
  const stats = { requests: 0, matched: 0, responses: 0, failures: 0 };

  const monitor = createHealthMonitor({
    url: readyUrl,
    ttlMs: cfg.ttlMs,
    timeoutMs: cfg.timeoutMs,
    fetchImpl,
    now,
    onTransition: (prev, next) => {
      const detail = next.httpStatus ? ` (HTTP ${next.httpStatus})` : next.reason ? ` (${next.reason})` : '';
      log[next.state === 'up' ? 'info' : 'warn'](
        `FreeLLMAPI ${prev.state} -> ${next.state} at ${cfg.baseUrl}${detail}`
      );
    },
  });

  function onRequest(ctx) {
    const model = typeof ctx?.model === 'string' ? ctx.model : null;
    const { state } = monitor.poll();
    const matched = shouldRouteToFreeLLM(model);
    stats.requests++;
    if (matched) stats.matched++;
    return {
      metadata: {
        freellmapi: {
          state,
          healthy: state === 'up',
          routed: matched && state === 'up',
          model,
          hint: hintFor(state, matched),
        },
      },
    };
  }

  function onResponse(payload) {
    // OmniRoute runs this fire-and-forget, so it only tallies outcomes.
    const status = (payload?.response ?? payload?.ctx?.response)?.status;
    stats.responses++;
    if (typeof status === 'number' && status >= 400) stats.failures++;
  }

  async function onActivate(info) {
    log.info(`Activated v${info?.version ?? '?'}; probing ${readyUrl}`);
    await monitor.refresh();
  }

  function onDeactivate() {
    const { requests, matched, responses, failures } = stats;
    log.info(
      `Deactivated (requests=${requests}, free-routed=${matched}, responses=${responses}, failures=${failures})`
    );
  }

  return {
    hooks: { name: PLUGIN_NAME, onRequest, onResponse, onActivate, onDeactivate },
    monitor,
    stats,
  };
}

export default createPlugin().hooks;

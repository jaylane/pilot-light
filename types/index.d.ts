export type RateLimit = { kind: string; percentUsed: number }

export type Snap = {
  /** `$.clock.now()` of the request that last read the cache; 0 before the first. */
  lastResponseAt: number
  /** Start of the latest main-loop request of the running turn; 0 between turns. */
  lastRequestAt: number
  /** Cache lifetime read from API usage; null until detected (config applies). */
  ttlMs: number | null
  /** Prompt tokens the next request re-sends. */
  contextTokens: number
  window: number
  rateLimits: RateLimit[]
  costUsd: number
  model: string
  isWorking: boolean
  /** A keep-alive fork is in flight. */
  pinging: boolean
  /** The band has been drawn 'cold' for the current anchor. */
  cold: boolean
  /** Keep-alive pings sent since the person last prompted. */
  keepAlives: number
  /** What those pings cost, and what the latest one cost. */
  pingUsd: number
  lastPingUsd: number
  /** A ping failed this stretch; no more are tried until the person prompts. */
  pingFailed: boolean
  /** A cold-cache notification went out since the person last prompted. */
  warned: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'cache-keeper': { snap: Shaped<Snap> }
  }
}

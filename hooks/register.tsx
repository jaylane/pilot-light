import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { Snap } from '../types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const WARN_LEAD_MS = 5 * MINUTE
const PING_LEAD_MS = 20_000

type Config = { configuredTtl: number; keepAlive: boolean }

const INITIAL: Snap = {
  lastResponseAt: 0,
  lastRequestAt: 0,
  ttlMs: null,
  contextTokens: 0,
  window: 0,
  rateLimits: [],
  costUsd: 0,
  model: '',
  isWorking: false,
  pinging: false,
  cold: false,
  keepAlives: 0,
  pingUsd: 0,
  lastPingUsd: 0,
  pingFailed: false,
  warned: false,
  savedUsd: 0,
}
// The shape tag versions the stored value: bump it whenever Snap gains a field,
// or a reload reads the previous version's snapshot and arithmetic on its
// missing fields lands null in the store.
const snap = atom({ plugin: 'pilot-light', key: 'snap' } as const, INITIAL, { shape: 'v3' })

// What a fresh stretch of pings starts from; also what a person's prompt restores.
const RESTED = { pinging: false, keepAlives: 0, pingUsd: 0, lastPingUsd: 0, pingFailed: false, warned: false }

// $/MTok per model id fragment: [fragment, input, cache read, output]. First
// match wins, so the longer ids come first. A cache write is 1.25x input on
// the 5-minute TTL and 2x on the 1-hour TTL. Unknown models price as Opus
// 5.5, the engine's own default tier.
const PRICES: readonly (readonly [string, number, number, number])[] = [
  ['fable-5-1', 10, 0.25, 50],
  ['mythos-5-1', 10, 0.25, 50],
  ['fable-5', 10, 1, 50],
  ['mythos-5', 10, 1, 50],
  ['opus-5-5', 4, 0.2, 20],
  ['opus-5', 5, 0.5, 25],
  ['opus-4', 5, 0.5, 25],
  ['sonnet-5', 2, 0.2, 10],
  ['sonnet-4', 3, 0.3, 15],
  ['haiku-5', 0.1, 0.01, 0.5],
  ['haiku-4', 1, 0.1, 5],
]
const priceOf = (model: string) => PRICES.find(([id]) => model.includes(id)) ?? PRICES[4]!
const writeMultOf = (ttl: number) => (ttl >= HOUR ? 2 : 1.25)
const coldUsdOf = (s: Snap, ttl: number) => (s.contextTokens * priceOf(s.model)[1] * writeMultOf(ttl)) / 1e6
const usdOf = (u: ModelUsage, model: string, ttl: number) => {
  const [, input, cacheRead, output] = priceOf(model)
  return (
    (u.input_tokens * input +
      u.cache_read_input_tokens * cacheRead +
      u.cache_creation_input_tokens * input * writeMultOf(ttl) +
      u.output_tokens * output) /
    1e6
  )
}

const PING_PROMPT = 'Reply with exactly: ok.'

const HANDOFF_PROMPT =
  'Write a handoff brief for a fresh session that has none of this context. ' +
  'Markdown, under 400 words, with these sections: Goal; Current state (done and in progress); ' +
  'Key decisions and why; Files touched (paths); Open questions and blockers; Next steps. ' +
  'Write it so the next agent can continue without asking. Output the brief only.'

const fmtK = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`
const fmtUsd = (n: number) => (n > 0 && n < 0.005 ? '<$0.01' : `$${n.toFixed(2)}`)
const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = `${s % 60}`.padStart(2, '0')
  return h ? `${h}:${`${m}`.padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
const ttlOf = (s: Snap, cfg: Config) => s.ttlMs ?? cfg.configuredTtl
const warnLeadOf = (ttl: number) => Math.min(WARN_LEAD_MS, ttl / 2)

async function measure($: EngineInterface) {
  const u = await $.session.usage()
  const model = await $.session.model()
  const savedUsd = Number(await $.store.get('savedUsd')) || 0
  await update($, snap, s => ({
    ...s,
    model,
    savedUsd,
    contextTokens: u.context.tokens ?? s.contextTokens,
    window: u.context.window,
    rateLimits: u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed })),
    costUsd: u.cost?.usd ?? s.costUsd,
  }))
}

// The API reports which TTL it wrote under usage.cache_creation; the engine
// keeps that only in the transcript file, so the last assistant line is the
// one ground truth for the window this session actually runs on.
async function detectTtl($: EngineInterface, transcriptPath: string) {
  const { stdout } = await $.process.run(['tail', '-c', '1000000', transcriptPath])
  const last = stdout.match(/"cache_creation":\{[^}]*\}/g)?.at(-1)
  if (!last) return
  const count = (key: string) => Number(last.match(new RegExp(`"${key}":(\\d+)`))?.[1] ?? 0)
  const h1 = count('ephemeral_1h_input_tokens')
  const m5 = count('ephemeral_5m_input_tokens')
  if (!h1 && !m5) return
  await update($, snap, s => ({ ...s, ttlMs: h1 ? HOUR : 5 * MINUTE }))
}

// A fork re-sends the main thread's last request plus one user message, so
// the API reads the cached prefix and restarts its timer: no turn, nothing in
// the transcript. Pinging stops once a stretch has cost as much as the cold
// re-send it is avoiding, since from there re-caching is the cheaper path.
async function ping($: EngineInterface, s: Snap, ttl: number) {
  const cold = coldUsdOf(s, ttl)
  if (s.pingUsd + s.lastPingUsd > cold) return
  // Each model has its own cache: after /model the old entry is nothing to keep.
  if ((await $.session.model()) !== s.model) {
    await update($, snap, x => ({ ...x, lastResponseAt: 0 }))
    return
  }
  // Claim the flag in the write that reads it, so two ticks overlapping a
  // slow host round trip fork once.
  let claimed = false
  await update($, snap, x => {
    claimed = !x.pinging
    return claimed ? { ...x, pinging: true } : x
  })
  if (!claimed) return
  const startedAt = await $.clock.now()
  let reply
  try {
    reply = await $.model.fork({ prompt: PING_PROMPT })
  } catch (error) {
    await update($, snap, x => ({ ...x, pinging: false, pingFailed: true }))
    $.ui.log(`pilot-light: keep-alive ping refused (${String(error)}); no more until you prompt`)
    return
  }
  const served = reply.isAnswered || reply.reason === 'empty-reply'
  const usd = 'usage' in reply ? usdOf(reply.usage, s.model, ttl) : 0
  // A prompt or /clear that landed meanwhile already reset the stretch
  // (pinging false): this ping belonged to the old one and is dropped.
  await update($, snap, x =>
    x.pinging
      ? {
          ...x,
          pinging: false,
          pingFailed: !served,
          keepAlives: served ? x.keepAlives + 1 : x.keepAlives,
          pingUsd: x.pingUsd + usd,
          lastPingUsd: served ? usd : x.lastPingUsd,
          lastResponseAt: served ? Math.max(x.lastResponseAt, startedAt) : x.lastResponseAt,
          cold: served ? false : x.cold,
        }
      : x,
  )
  $.ui.log(
    served
      ? `pilot-light: keep-alive ping ${s.keepAlives + 1} cost ${fmtUsd(usd)}, ${fmtUsd(s.pingUsd + usd)} of ${fmtUsd(cold)} this stretch`
      : `pilot-light: keep-alive ping failed (${reply.isAnswered ? 'unknown' : reply.reason}); no more until you prompt`,
  )
}

async function tick($: EngineInterface, cfg: Config) {
  const s = await read($, snap)
  if (!s.lastResponseAt || s.isWorking || s.pinging) return
  const ttl = ttlOf(s, cfg)
  const remaining = s.lastResponseAt + ttl - (await $.clock.now())
  if (remaining <= 0) {
    // The state write redraws the band once (its render reads snap), whatever
    // the clock did meanwhile; then the band rests until the next request.
    if (!s.cold) await update($, snap, x => ({ ...x, cold: true }))
    return
  }
  $.ui.invalidate('ui.render')
  if (!s.warned && remaining <= warnLeadOf(ttl)) {
    await update($, snap, x => ({ ...x, warned: true }))
    const text = `Prompt cache goes cold in ${fmtClock(remaining)}. Send a message to keep it warm.`
    $.ui.toast(text)
    void $.ui.notify(text, { title: 'Pilot Light' }).catch(() => undefined)
  }
  if (cfg.keepAlive && !s.pingFailed && remaining <= PING_LEAD_MS) await ping($, s, ttl)
}

async function handoff($: EngineInterface) {
  $.ui.toast('Writing handoff brief...')
  const reply = await $.model.fork({ prompt: HANDOFF_PROMPT })
  if (!reply.isAnswered) {
    $.ui.toast(`Handoff skipped: ${reply.reason}`)
    return
  }
  const brief = reply.text.trim()
  const draft = (await $.prompt.read()).text.trim()
  const home = (await $.env.get('HOME')) ?? (await $.session.cwd())
  const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
  const path = `${home}/.claude/pilot-light/handoff-${stamp}.md`
  await $.fs.write(path, `${brief}\n`)
  await $.command.run({ command: 'clear' })
  const text =
    `Continue from this handoff brief (saved at ${path}):\n\n${brief}` +
    (draft ? `\n\n## Pending draft\n\n${draft}` : '')
  const filled = await $.prompt.fill({ text })
  $.ui.toast(filled.isFilled ? `Handoff brief pasted into the prompt; saved at ${path}` : `Prompt box refused the paste; brief saved at ${path}`)
}

export const register: Register = (on, options) => {
  const cfg: Config = {
    configuredTtl: (Number(options.cacheWindowMinutes) || 60) * MINUTE,
    keepAlive: options.keepAlive !== false,
  }

  on('session.start', async ($, e, next) => {
    await measure($)
    // A reload mid-fork drops the continuation that would have cleared the flag.
    await update($, snap, s => ({ ...s, pinging: false }))
    if (e.isInteractive) {
      $.clock.every(1000, () => void tick($, cfg).catch(error => $.ui.log(`pilot-light: tick failed: ${String(error)}`)))
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, snap, s => ({
      ...s,
      contextTokens: e.context.tokens ?? s.contextTokens,
      window: e.context.window,
      rateLimits: e.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed })),
      costUsd: e.cost?.usd ?? s.costUsd,
    }))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, snap, s => ({ ...s, isWorking: true, lastRequestAt: 0 }))
    return next(e)
  })

  // The cache TTL runs from the start of the request that read it, not from
  // the end of the response, so the countdown anchors on the last request.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      await update($, snap, s => ({ ...s, lastRequestAt: at }))
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const now = await $.clock.now()
    const u = e.usage
    await update($, snap, s => ({
      ...s,
      isWorking: false,
      cold: u ? false : s.cold,
      lastResponseAt: u ? s.lastRequestAt || now : s.lastResponseAt,
      model: u?.model ?? s.model,
    }))
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    if (e.agent_id === undefined) void detectTtl($, e.transcript_path).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    // Only the person's own Enter re-arms the pings: a /loop, a task
    // notification or a peer message arriving while they are away must not.
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      // Coming back to a cache the pings kept warm: the cold re-send that
      // did not happen, less what the pings cost, is what the stretch saved.
      const s = await read($, snap)
      const ttl = ttlOf(s, cfg)
      const warm = s.lastResponseAt > 0 && s.lastResponseAt + ttl > (await $.clock.now())
      const saved = s.keepAlives && warm ? Math.max(0, coldUsdOf(s, ttl) - s.pingUsd) : 0
      const savedUsd = s.savedUsd + saved
      if (saved) await $.store.set('savedUsd', savedUsd)
      await update($, snap, x => ({ ...x, ...RESTED, savedUsd }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, snap, s => ({ ...s, ...RESTED, lastResponseAt: 0, contextTokens: 0, costUsd: 0 }))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const s = await read($, snap)
    const { Box, Button, Text } = $.ui.resolve(e)

    const ttl = ttlOf(s, cfg)
    const remaining = s.lastResponseAt ? s.lastResponseAt + ttl - (await $.clock.now()) : null
    const ttlTag = s.ttlMs === null ? `${Math.round(ttl / MINUTE)}m?` : ttl >= HOUR ? '1h' : '5m'
    const state = s.isWorking
      ? 'working'
      : remaining === null
        ? 'no cache yet'
        : remaining <= 0
          ? 'cold'
          : fmtClock(remaining)
    const cold = coldUsdOf(s, ttl)
    const pings = s.keepAlives ? ` · 🔁 ${s.keepAlives} ${fmtUsd(s.pingUsd)}/${fmtUsd(cold)}` : ''
    const failed = s.pingFailed ? ' · ping failed' : ''
    const tone =
      remaining === null || s.isWorking || remaining > warnLeadOf(ttl)
        ? {}
        : remaining <= 0
          ? { dimColor: true }
          : { color: 'yellow' }

    const warm = (s.contextTokens * priceOf(s.model)[2]) / 1e6
    const pct = s.window ? ` (${Math.round((100 * s.contextTokens) / s.window)}%)` : ''
    const limit = (kind: string, label: string) => {
      const r = s.rateLimits.find(r => r.kind === kind)
      return r ? `${label} ${Math.round(r.percentUsed)}%` : `${label} n/a`
    }

    return (
      <Box flexWrap="wrap" gap={2}>
        <Text {...tone}>{remaining !== null && remaining <= 0 ? '🧊' : '🔥'} {state} /{ttlTag}{pings}{failed}</Text>
        <Text dimColor>🧠 {fmtK(s.contextTokens)}/{fmtK(s.window)}{pct}</Text>
        <Text dimColor>📊 {limit('five_hour', '5h')} · {limit('seven_day', '7d')}</Text>
        <Text dimColor>💰 {fmtUsd(s.costUsd)}</Text>
        <Text dimColor>🧊 next {fmtUsd(cold)} (warm {fmtUsd(warm)})</Text>
        <Text dimColor>💸 saved {fmtUsd(s.savedUsd)}</Text>
        <Button key="handoff" label="Handoff & Clear" onPress={() => handoff($)} />
      </Box>
    )
  })
}

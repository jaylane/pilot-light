import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'pilot-light'
const MINUTE = 60_000

const BAND = {
  plugin: PLUGIN,
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 200,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const USAGE = {
  startedAt: 0,
  context: { tokens: 200_000, window: 1_000_000, percent: 20 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 23.5 },
    { kind: 'seven_day', percentUsed: 41 },
  ],
  cost: { usd: 12.34 },
}

const MODEL = 'claude-fable-5-1'

const TURN_USAGE = {
  model: MODEL,
  input_tokens: 2,
  output_tokens: 1_000,
  cache_read_input_tokens: 180_000,
  cache_creation_input_tokens: 19_000,
}

// A ping reads the 200k prefix and says 'ok': 200k * $0.25 + 300 * $50 per MTok = $0.065.
const PING_USAGE = { input_tokens: 20, output_tokens: 300, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 0 }
// One that answers at length: $0.05 + 20k * $50 per MTok = $1.05, so two fit under a $2.50 cold re-send and a third does not.
const COSTLY_PING_USAGE = { ...PING_USAGE, output_tokens: 20_000 }

type ForkReply =
  | { isAnswered: true; text: string; usage: typeof PING_USAGE }
  | { isAnswered: false; reason: 'api-error'; status: number; error: 'rate_limit'; usage: typeof PING_USAGE }
type Calls = { notify: string[]; submit: string[]; fork: string[]; fill: string[]; run: string[]; write: string[]; argv: string[][] }
type World = { transcriptTail?: string; draft?: string; fork?: ForkReply; beforeFork?: () => Promise<void>; store?: Map<string, unknown> }

const BRIEF = { isAnswered: true as const, text: '# Brief\n\nGoal: ship it.', usage: PING_USAGE }

// The engine beneath the plugin: every call it makes answered from memory.
const world = (on: On, calls: Calls, { transcriptTail = '', draft = '', fork = BRIEF, beforeFork, store }: World = {}) => {
  if (store) {
    // A store the test holds, so it can write mid-session as another session would.
    on('store.get', ($, e) => ({ value: store.get(e.key) }))
    on('store.set', ($, e) => {
      store.set(e.key, e.value)
      return { value: undefined }
    })
  } else {
    mock.store(on)
  }
  on('session.usage', () => ({ value: USAGE }))
  on('session.model', () => ({ value: MODEL }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.notify', ($, e) => {
    calls.notify.push(e.text)
    return { value: { isSent: true as const, channel: 'terminal_bell' as const } }
  })
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'plugin') calls.submit.push(e.text)
    return { text: e.text }
  })
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('prompt.fill', ($, e) => {
    calls.fill.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('command.run', ($, e) => {
    calls.run.push(e.command)
    return { text: '' }
  })
  on('fs.write', ($, e) => {
    calls.write.push(e.path)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    calls.argv.push([...e.argv])
    return { value: { exitCode: 0, stdout: transcriptTail, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('env.get', () => ({ value: '/home/tester' }))
  on('model.fork', async ($, e) => {
    calls.fork.push(e.prompt)
    await beforeFork?.()
    return { value: fork }
  })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: TURN_USAGE }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}))
}

const calls = (): Calls => ({ notify: [], submit: [], fork: [], fill: [], run: [], write: [], argv: [] })

const respond = async ($: Engine) => {
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })
}

const FIVE_MINUTE_TAIL = '{"message":{"usage":{"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":19972}}}}\n'

const detectFiveMinutes = async ($: Engine, clock: { settle: () => Promise<void> }) => {
  await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/s.jsonl' })
  await clock.settle()
}

test('band shows the countdown, context, limits and costs on every surface', async ($, on) => {
  const c = calls()
  world(on, c)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await respond($)
  await clock.advance(90_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /🔥 58:30 \/60m\?/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /🧠 200k\/1\.0M \(20%\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /📊 5h 24% · 7d 41%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /💰 \$12\.34/ })).toBeDefined()
    // 200k tokens on Fable 5.1 under an (unverified) 1-hour window: cold = 200k * $10 * 2 / 1M; warm = 200k * $0.25 / 1M
    expect(await ui.find({ type: 'Text', text: /🧊 next \$4\.00 \(warm \$0\.05\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'handoff' })).toBeDefined()
    await ui.unmount()
  }

  // API billing reports no windows: the segment is hidden rather than drawn as n/a.
  await $.session.measure({ context: USAGE.context, rateLimits: [], cost: USAGE.cost, changed: ['rateLimits'] })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /📊/ })).toBeUndefined()
  await ui.unmount()
})

// Hours of mock clock at one tick a second: slow on a CI runner.
test('warns once five minutes out, then pings by forking the cached transcript, never as a prompt', { timeoutMs: 60_000 }, async ($, on) => {
  const c = calls()
  world(on, c, { fork: { ...BRIEF, usage: PING_USAGE } })
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await respond($)

  await clock.advance(54 * MINUTE)
  expect(c.notify).toHaveLength(0)
  await clock.advance(MINUTE + 1_000)
  expect(c.notify).toHaveLength(1)
  expect(c.fork).toHaveLength(0)

  // 20 s before cold the fork goes out, and the countdown restarts from the ping's start.
  await clock.advance(4 * MINUTE + 59_000)
  expect(c.fork).toEqual(['Reply with exactly: ok.'])
  expect(c.submit).toHaveLength(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /🔥 59:40 \/60m\? · 🔁 1 \$0\.07\/\$4\.00/ })).toBeDefined()
  await ui.unmount()

  // Second stretch: no second notification, one more ping.
  await clock.advance(60 * MINUTE)
  expect(c.notify).toHaveLength(1)
  expect(c.fork).toHaveLength(2)

  // Coming back while the pinged cache is warm credits the avoided cold re-send ($4.00) less the pings ($0.13).
  await $.prompt.submit({ text: 'back', wait: false, origin: { kind: 'composer' } })
  await respond($)
  const back = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await back.find({ type: 'Text', text: /💸 saved \$3\.87/ })).toBeDefined()
  await back.unmount()
  // A later stretch (one ping, $0.07) adds its own credit: $3.87 + $3.93.
  await clock.advance(61 * MINUTE)
  await $.prompt.submit({ text: 'again', wait: false, origin: { kind: 'composer' } })
  await respond($)
  const later = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await later.find({ type: 'Text', text: /💸 saved \$7\.80/ })).toBeDefined()
  await later.unmount()
})

// Hours of mock clock at one tick a second: slow on a CI runner.
test('pings stop once a stretch has cost as much as a cold re-send, and the person re-arms them', { timeoutMs: 60_000 }, async ($, on) => {
  const c = calls()
  world(on, c, { transcriptTail: FIVE_MINUTE_TAIL, fork: { ...BRIEF, usage: COSTLY_PING_USAGE } })
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await respond($)
  await detectFiveMinutes($, clock)

  // Cold re-send of 200k on a 5m window is 200k * $10 * 1.25 / 1M = $2.50; each ping is $1.05.
  await clock.advance(5 * MINUTE)
  expect(c.fork).toHaveLength(1)
  await clock.advance(5 * MINUTE)
  expect(c.fork).toHaveLength(2)
  await clock.advance(10 * MINUTE)
  expect(c.fork).toHaveLength(2)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /🧊 cold \/5m · 🔁 2 \$2\.10\/\$2\.50/ })).toBeDefined()
  await ui.unmount()

  // Automation prompts do not re-arm; the person's own Enter does.
  for (const kind of ['scheduled-trigger', 'task-notification'] as const) {
    await $.prompt.submit({ text: 'tick', wait: false, origin: { kind } })
    await respond($)
    await clock.advance(10 * MINUTE)
    expect(c.fork).toHaveLength(2)
  }
  await $.prompt.submit({ text: 'back', wait: false, origin: { kind: 'composer' } })
  await respond($)
  // The cache was cold when the person came back, so the capped stretch saved nothing.
  const back = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await back.find({ type: 'Text', text: /💸 saved \$0\.00/ })).toBeDefined()
  await back.unmount()
  await clock.advance(5 * MINUTE)
  expect(c.fork).toHaveLength(3)
})

test('a return adds its credit to the stored total, so overlapping sessions all count', async ($, on) => {
  const c = calls()
  const store = new Map<string, unknown>([['savedUsd', 1]])
  world(on, c, { transcriptTail: FIVE_MINUTE_TAIL, fork: { ...BRIEF, usage: COSTLY_PING_USAGE }, store })
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await respond($)
  await detectFiveMinutes($, clock)

  // Another session credits $2 while this one runs.
  store.set('savedUsd', 3)
  // One $1.05 ping keeps the $2.50 cold re-send away: this session's credit is $1.45.
  await clock.advance(5 * MINUTE)
  expect(c.fork).toHaveLength(1)
  await $.prompt.submit({ text: 'back', wait: false, origin: { kind: 'composer' } })
  await respond($)
  const back = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await back.find({ type: 'Text', text: /💸 saved \$4\.45/ })).toBeDefined()
  await back.unmount()
  expect((store.get('savedUsd') as number).toFixed(2)).toBe('4.45')
})

test('a failed ping ends the stretch instead of retrying every second', async ($, on) => {
  const c = calls()
  world(on, c, {
    transcriptTail: FIVE_MINUTE_TAIL,
    fork: { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: { ...PING_USAGE, cache_read_input_tokens: 0, output_tokens: 0 } },
  })
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await respond($)
  await detectFiveMinutes($, clock)

  await clock.advance(6 * MINUTE)
  expect(c.fork).toHaveLength(1)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /🧊 cold \/5m · ping failed/ })).toBeDefined()
  await ui.unmount()
})

test('reads the real TTL from the transcript usage and prices the 5m write at 1.25x', async ($, on) => {
  const c = calls()
  world(on, c, { transcriptTail: FIVE_MINUTE_TAIL })
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await respond($)
  await detectFiveMinutes($, clock)
  expect(c.argv[0]).toEqual(['tail', '-c', '1000000', '/t/s.jsonl'])

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /🔥 5:00 \/5m/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /🧊 next \$2\.50 \(warm \$0\.05\)/ })).toBeDefined()
  await ui.unmount()

  // Half the window is the lead on a short TTL: warned at 2:30, pinged at 0:20.
  await clock.advance(2 * MINUTE + 31_000)
  expect(c.notify).toHaveLength(1)
  expect(c.fork).toHaveLength(0)
  await clock.advance(2 * MINUTE + 10_000)
  expect(c.fork).toHaveLength(1)
})

test('the countdown anchors on the last request start, not the end of a slow response', async ($, on) => {
  const c = calls()
  world(on, c)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const step = $.turn.step({ turnId: 't1', index: 0, model: MODEL, messageCount: 1 })
  for await (const _chunk of step) { /* drain */ }
  await clock.advance(90_000)
  await $.turn.complete({ answer: 'ok', durationMs: 90_000, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /🔥 58:30 / })).toBeDefined()
  await ui.unmount()
})

test('Handoff & Clear writes the brief, clears, and pastes it with any pending draft into the fresh prompt', async ($, on) => {
  const c = calls()
  world(on, c, { draft: 'half-typed question' })
  mock.clock(on, { now: 1_700_000_000_000 })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await respond($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'handoff' })
    await ui.unmount()
  }

  expect(c.fork).toHaveLength(2)
  expect(c.write).toHaveLength(2)
  expect(c.write[0]).toMatch(/^\/home\/tester\/\.claude\/pilot-light\/handoff-.*\.md$/)
  expect(c.run).toEqual(['clear', 'clear'])
  expect(c.fill[0]).toContain('Goal: ship it.')
  expect(c.fill[0]).toContain(c.write[0]!)
  expect(c.fill[0]).toContain('## Pending draft\n\nhalf-typed question')
})

test('one fork at a time, and a fork that lands after the person prompts is discarded', async ($, on) => {
  const c = calls()
  const slow = { wait: async () => {} }
  world(on, c, { transcriptTail: FIVE_MINUTE_TAIL, fork: { ...BRIEF, usage: PING_USAGE }, beforeFork: () => slow.wait() })
  const clock = mock.clock(on, { now: 1_000_000 })
  slow.wait = () => clock.sleep(5_000)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await respond($)
  await detectFiveMinutes($, clock)

  // The fork goes out at 4:40 and is held for 5 s; the ticks meanwhile do not fork again.
  await clock.advance(4 * MINUTE + 42_000)
  expect(c.fork).toHaveLength(1)

  // The person prompts while it is in flight: the stretch resets and the turn sets the anchor.
  await $.prompt.submit({ text: 'back', wait: false, origin: { kind: 'composer' } })
  await respond($)
  await clock.advance(5_000)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /🔥 4:55 \/5m$/ })).toBeDefined()
  await ui.unmount()
  expect(c.fork).toHaveLength(1)
})

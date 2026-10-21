/**
 * Lifebase read-only tools for DeepSeek Harness.
 *
 * Wraps the Lifebase HumanOS JSON CLI (api_version 1) as six tools. The data
 * directory, executable, and destination are plugin-owned: the model only
 * supplies query text and filters. Destination comes from the agent's actual
 * provider route and fails closed to `cloud`; Lifebase enforces source egress
 * policy on its side.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  buildArgv,
  exclusiveGuardReason,
  evidenceIds,
  LifebaseToolError,
  parseResponse,
  renderForModel,
  resolveDestination,
  type Destination,
  type LifebaseArgs,
  type LifebaseResponse,
  type Operation,
} from './core.ts'

export const name = 'lifebase-tools'
export const inject = ['tools', 'subprocess']

export interface Config {
  /** Absolute path to the `lifebase` console script in the conda env. */
  executable: string
  /** Absolute path to the Lifebase library root. */
  dataDir: string
  /** Provider id → actual destination. Unlisted providers count as cloud. */
  routes: Record<string, Destination>
  timeoutMs: number
  /** Deny every non-Lifebase tool in this composition (ADR-018). Keep true for any profile with Lifebase data. */
  exclusive: boolean
}

export const Config: z<Config> = z.object({
  executable: z.string().required(),
  dataDir: z.string().required(),
  routes: z.dict(z.union(['local', 'cloud'] as const)).default({}),
  timeoutMs: z.number().default(30_000),
  exclusive: z.boolean().default(true),
})

const STDOUT_MAX_BYTES = 1024 * 1024
const STDERR_MAX_BYTES = 16 * 1024

const text = (description: string) => ({ type: 'string', description }) as const
const filters = {
  source: text('Restrict to one source id, e.g. "chatgpt:synthetic-account"'),
  role: text('Restrict to a message role: user or assistant'),
  since: text('Inclusive lower bound: ISO date (UTC midnight) or timestamp with timezone'),
  until: text('Exclusive upper bound: ISO date (UTC midnight) or timestamp with timezone'),
  limit: { type: 'integer', description: 'Maximum matches (default 10)' },
} as const
const offset = { type: 'integer', description: 'Skip this many results; pass next_offset from the previous page' } as const

const TOOLS: readonly {
  op: Operation
  description: string
  parameters: Record<string, unknown>
}[] = [
  {
    op: 'topics',
    description: 'List keyword topics in the user\'s Lifebase chat archive with message/conversation counts.',
    parameters: { source: filters.source, limit: { ...filters.limit, description: 'Maximum topics (1–100)' } },
  },
  {
    op: 'conversations',
    description: 'List the user\'s archived conversations, most recent first: title, time span, message counts and top '
      + 'topics, without message text. Start here to see what exists, read one with lifebase_timeline, and '
      + 'page through all of them with offset/next_offset instead of guessing keywords.',
    parameters: { source: filters.source, since: filters.since, until: filters.until,
      limit: { ...filters.limit, description: 'Maximum conversations per page (1–100)' }, offset },
  },
  {
    op: 'search',
    description: 'Search the user\'s archived chat messages by keyword topics. Returns excerpts with evidence locators.',
    parameters: { query: { ...text('Keywords to search for'), required: true }, ...filters },
  },
  {
    op: 'timeline',
    description: 'List messages of one archived conversation in time order. Page long conversations with offset/next_offset.',
    parameters: { conversation: { ...text('conversation_id from a previous result'), required: true }, ...filters, offset },
  },
  {
    op: 'evidence',
    description: 'Resolve one evidence_id to its archived source location and a bounded excerpt. Use it to verify citations.',
    parameters: { evidence_id: { ...text('evidence_id from a previous result'), required: true } },
  },
  {
    op: 'context',
    description: 'Retrieve bounded, source-balanced context (≤10 messages, ≤3000 chars) for answering a question about the user\'s past conversations.',
    parameters: { question: { ...text('The question to gather context for'), required: true }, ...filters,
      limit: { ...filters.limit, description: 'Maximum messages (1–10)' } },
  },
]

export function apply(ctx: Context, config: Config) {
  // Shell, filesystem, web, or subagent tools would let the model reach the data
  // directory without the plugin and its destination gate.
  if (config.exclusive) ctx.tools.guard(exec => exclusiveGuardReason(exec.name))

  async function run(op: Operation, args: LifebaseArgs, exec: {
    signal: AbortSignal
    agent?: { options: { provider?: string }, session: { requestContext(): { provider: string } | undefined } }
  }): Promise<LifebaseResponse> {
    // Re-resolve on every call so a mid-session model switch takes effect immediately.
    const destination = resolveDestination(config.routes, [
      exec.agent?.options.provider,
      exec.agent?.session.requestContext()?.provider,
    ])
    const argv = buildArgv(config.executable, config.dataDir, op, args, destination)
    const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(config.timeoutMs)])
    const handle = ctx.subprocess.spawn({
      argv,
      cwd: config.dataDir,
      stdio: { stdin: 'ignore', stdout: { maxBytes: STDOUT_MAX_BYTES }, stderr: { maxBytes: STDERR_MAX_BYTES } },
      graceMs: 2_000,
      signal,
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0)
    if (!stdout || stdout.lossy) throw new LifebaseToolError('PROTOCOL', 'lifebase output missing or exceeded the cap')
    return parseResponse(stdout.text, outcome.exitCode)
  }

  for (const tool of TOOLS) {
    ctx.tools.register(defineTool({
      name: `lifebase_${tool.op}`,
      description: tool.description,
      parameters: tool.parameters as never,
      isConcurrencySafe: () => true,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderForModel(value as unknown as LifebaseResponse) }],
        presentationMeta: (_args, value) => ({ evidence_ids: evidenceIds(value as unknown as LifebaseResponse) }),
      },
      async execute(args, exec) {
        return await run(tool.op, args as LifebaseArgs, exec) as never
      },
    }))
  }
}

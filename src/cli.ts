import { execFile, spawn } from 'node:child_process'
import { splitArgs } from './parse'
import type { AwsCliConfig, AwsContextInput } from './protocol'

export type CliErrorKind = 'not_found' | 'auth' | 'access_denied' | 'timeout' | 'cli'

export class AwsCliError extends Error {
  readonly kind: CliErrorKind
  readonly stderr: string
  readonly code: string | number | null

  constructor(message: string, kind: CliErrorKind, stderr = '', code: string | number | null = null) {
    super(message)
    this.name = 'AwsCliError'
    this.kind = kind
    this.stderr = stderr
    this.code = code
  }
}

export interface AwsCommandSpec {
  command: string
  args: string[]
}

/** Classifies AWS CLI stderr/error codes so the UI can show actionable hints (e.g. SSO login). */
export function classifyCliError(stderr: string, errCode?: string | number | null, killed?: boolean): CliErrorKind {
  if (errCode === 'ENOENT') return 'not_found'
  if (killed || errCode === 'ETIMEDOUT') return 'timeout'
  const s = stderr.toLowerCase()
  if (s.includes('command not found') || s.includes('is not recognized') || s.includes('não é reconhecido')) {
    return 'not_found'
  }
  if (
    s.includes('expiredtoken') ||
    s.includes('token has expired') ||
    s.includes('sso') && (s.includes('expired') || s.includes('login') || s.includes('token')) ||
    s.includes('unable to locate credentials') ||
    s.includes('invalidclienttokenid') ||
    s.includes('security token included in the request is invalid') ||
    s.includes('error loading sso')
  ) {
    return 'auth'
  }
  if (s.includes('accessdenied') || s.includes('unauthorizedoperation') || s.includes('not authorized')) {
    return 'access_denied'
  }
  return 'cli'
}

/** Builds a shell-free command + argument list for invoking the AWS CLI on Windows or inside WSL.
 *  Supports multi-token commands such as `uvx --from awscli aws` and both AWS CLI v1 and v2. */
export function buildAwsCommand(
  config: Pick<AwsCliConfig, 'awsBin' | 'runInWsl'>,
  serviceArgs: string[],
  ctx?: AwsContextInput,
  outputMode: 'json' | 'text' | 'none' = 'json'
): AwsCommandSpec {
  const tokens = splitArgs(config.awsBin.trim() || 'aws')
  const bin = tokens[0] || 'aws'
  const prefixArgs = tokens.slice(1)

  const awsArgs: string[] = [...prefixArgs]
  const profile = ctx?.profile?.trim()
  const region = ctx?.region?.trim()
  if (profile) awsArgs.push('--profile', profile)
  if (region) awsArgs.push('--region', region)
  if (outputMode === 'json') awsArgs.push('--output', 'json')
  else if (outputMode === 'text') awsArgs.push('--output', 'text')
  awsArgs.push(...serviceArgs)

  if (config.runInWsl) {
    return { command: 'wsl.exe', args: ['--', bin, ...awsArgs] }
  }
  return { command: bin, args: awsArgs }
}

export interface RunAwsOptions {
  output?: 'json' | 'text' | 'none'
  timeoutMs?: number
  maxBuffer?: number
}

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024

/** Executes an AWS CLI command without a shell and returns stdout. */
export function runAwsRaw(
  config: AwsCliConfig,
  serviceArgs: string[],
  ctx?: AwsContextInput,
  opts: RunAwsOptions = {}
): Promise<string> {
  const spec = buildAwsCommand(config, serviceArgs, ctx, opts.output ?? 'json')
  const timeout = opts.timeoutMs ?? config.timeoutMs
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER

  return new Promise((resolve, reject) => {
    execFile(
      spec.command,
      spec.args,
      {
        timeout,
        maxBuffer,
        windowsHide: true,
        env: { ...process.env, AWS_PAGER: '' }
      },
      (err, stdout, stderr) => {
        if (err) {
          const errText = (stderr || err.message || '').trim()
          const code = (err as NodeJS.ErrnoException).code ?? null
          const kind = classifyCliError(errText, code, Boolean(err.killed))
          reject(new AwsCliError(friendlyError(kind, errText, config), kind, errText, code))
          return
        }
        resolve(stdout)
      }
    )
  })
}

/** Executes an AWS CLI command and parses its JSON output (returns {} on empty stdout). */
export async function runAwsJson<T = unknown>(
  config: AwsCliConfig,
  serviceArgs: string[],
  ctx?: AwsContextInput,
  opts: Omit<RunAwsOptions, 'output'> = {}
): Promise<T> {
  const out = await runAwsRaw(config, serviceArgs, ctx, { ...opts, output: 'json' })
  const trimmed = out.trim()
  if (!trimmed) return {} as T
  try {
    return JSON.parse(trimmed) as T
  } catch {
    const prefix = config.lang === 'pt-BR' ? 'Saída inválida do AWS CLI' : 'Invalid AWS CLI output'
    throw new AwsCliError(`${prefix}: ${trimmed.slice(0, 200)}`, 'cli', trimmed)
  }
}

/** Executes an AWS CLI command piping string content to stdin (used by `aws s3 cp - s3://...`). */
export function runAwsWithStdin(
  config: AwsCliConfig,
  serviceArgs: string[],
  stdinText: string,
  ctx?: AwsContextInput,
  timeoutMs?: number
): Promise<string> {
  const spec = buildAwsCommand(config, serviceArgs, ctx, 'none')
  const timeout = timeoutMs ?? config.timeoutMs

  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      windowsHide: true,
      env: { ...process.env, AWS_PAGER: '' }
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new AwsCliError(friendlyError('timeout', 'Timeout exceeded', config), 'timeout', stderr, 'ETIMEDOUT'))
    }, timeout)

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const kind = classifyCliError(err.message, err.code)
      reject(new AwsCliError(friendlyError(kind, err.message, config), kind, err.message, err.code ?? null))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        const fallback = config.lang === 'pt-BR' ? `AWS CLI saiu com código ${code}` : `AWS CLI exited with code ${code}`
        const msg = stderr.trim() || fallback
        const kind = classifyCliError(msg, code)
        reject(new AwsCliError(friendlyError(kind, msg, config), kind, msg, code))
        return
      }
      resolve(stdout)
    })

    child.stdin.end(stdinText, 'utf8')
  })
}

/** Formats a user-facing AWS CLI error message in the active language (`pt-BR` or `en`). */
export function friendlyError(kind: CliErrorKind, raw: string, config: Pick<AwsCliConfig, 'awsBin' | 'runInWsl' | 'timeoutMs' | 'lang'>): string {
  const pt = config.lang === 'pt-BR'
  const compact = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' — ')
  if (kind === 'not_found') {
    const target = config.runInWsl ? `WSL (${config.awsBin})` : config.awsBin
    return pt
      ? `AWS CLI não encontrado em ${target}. Ajuste "AWS CLI command" ou "Run AWS CLI inside WSL" em Settings.`
      : `AWS CLI not found at ${target}. Check "AWS CLI command" or "Run AWS CLI inside WSL" in Settings.`
  }
  if (kind === 'timeout') {
    const secs = Math.round(config.timeoutMs / 1000)
    return pt
      ? `Timeout ao aguardar o AWS CLI (${secs}s).`
      : `Timed out waiting for AWS CLI (${secs}s).`
  }
  if (kind === 'auth') {
    return pt
      ? `Sessão AWS ausente ou expirada. Faça login (SSO/credenciais) e atualize. Detalhe: ${compact}`
      : `AWS session missing or expired. Sign in (SSO/credentials) and refresh. Detail: ${compact}`
  }
  if (kind === 'access_denied') {
    return pt
      ? `Acesso negado pela AWS (IAM): ${compact}`
      : `Access denied by AWS (IAM): ${compact}`
  }
  return compact || (pt ? 'Erro ao executar comando do AWS CLI.' : 'Failed to run AWS CLI command.')
}

import type { OrcaWorkerApi } from 'orca/worker'
import { AwsCliError, runAwsJson, runAwsRaw, runAwsWithStdin } from './cli'
import {
  buildEmrStepPayload,
  parseCallerIdentity,
  parseCliVersion,
  parseEmrClusterDetail,
  parseEmrClusters,
  parseEmrSteps,
  parseProfiles,
  parseS3Buckets,
  parseS3Objects,
  parseSqsAttributes,
  parseSqsMessages,
  parseSqsQueues,
  splitArgs
} from './parse'
import type { AwsCliConfig, AwsContextInput, AwsStatusResult } from './protocol'

const MAX_PREVIEW_BYTES = 256 * 1024

function requireNonEmpty(value: unknown, label: string): string {
  const s = typeof value === 'string' ? value.trim() : ''
  if (!s) throw new Error(`Campo obrigatório ausente: ${label}`)
  return s
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

async function readConfig(orca: OrcaWorkerApi): Promise<AwsCliConfig> {
  const get = async <T>(key: string, fallback: T): Promise<T> => {
    try {
      const v = await orca.settings.get(key)
      return (v === undefined || v === null ? fallback : v) as T
    } catch {
      return fallback
    }
  }
  const awsBin = String(await get('awsBin', 'aws')).trim() || 'aws'
  const runInWsl = Boolean(await get('runInWsl', false))
  const defaultProfile = String(await get('defaultProfile', '')).trim()
  const defaultRegion = String(await get('defaultRegion', '')).trim()
  const timeoutSeconds = clampInt(await get('timeoutSeconds', 30), 30, 5, 180)
  return { awsBin, runInWsl, defaultProfile, defaultRegion, timeoutMs: timeoutSeconds * 1000 }
}

function resolveContext(input: AwsContextInput | undefined, cfg: AwsCliConfig): { profile: string; region: string } {
  const profile = input?.profile !== undefined ? String(input.profile).trim() : cfg.defaultProfile
  const region = input?.region !== undefined ? String(input.region).trim() : cfg.defaultRegion
  return { profile, region }
}

async function notify(orca: OrcaWorkerApi, title: string, body: string): Promise<void> {
  try {
    await orca.host.call('notifications.show', { title, body })
  } catch {
    /* notificação é opcional */
  }
}

export default function activate(orca: OrcaWorkerApi) {
  const statusCache = new Map<string, { at: number; result: AwsStatusResult }>()
  const versionCache = new Map<string, { version: string; supportsSso: boolean }>()
  const STATUS_TTL_MS = 60_000

  async function detectVersion(cfg: AwsCliConfig): Promise<{ version: string; supportsSso: boolean }> {
    const vk = `${cfg.awsBin}|${cfg.runInWsl}`
    const cached = versionCache.get(vk)
    if (cached) return cached
    try {
      const raw = await runAwsRaw(cfg, ['--version'], undefined, { output: 'none', timeoutMs: 10_000 })
      const parsed = parseCliVersion(raw)
      if (parsed.version) versionCache.set(vk, parsed)
      return parsed
    } catch (err) {
      // AWS CLI v1 imprime --version em stderr em algumas versões antigas
      const txt = err instanceof AwsCliError ? err.stderr : ''
      const parsed = parseCliVersion(txt)
      if (parsed.version) versionCache.set(vk, parsed)
      return parsed
    }
  }
  let savedUiState: Record<string, any> = {}
  const dataCache = new Map<string, { at: number; value: any }>()
  const DATA_TTL_MS = 30_000

  function getCached<T>(key: string, force: boolean): T | undefined {
    if (force) return undefined
    const hit = dataCache.get(key)
    if (hit && Date.now() - hit.at < DATA_TTL_MS) return hit.value as T
    return undefined
  }

  function setCached(key: string, value: any): void {
    dataCache.set(key, { at: Date.now(), value })
  }

  orca.panels.handle('ui.getState', async () => {
    orca.log(`frame mounted at ${new Date().toISOString()} state=${JSON.stringify({ tab: savedUiState.tab, bucket: savedUiState.s3Bucket, prefix: savedUiState.s3Prefix })}`)
    return { state: savedUiState }
  })

  orca.panels.handle('ui.setState', async (input) => {
    if (input && typeof input === 'object') {
      savedUiState = { ...savedUiState, ...(input as Record<string, any>) }
    }
    return { ok: true }
  })

  orca.panels.handle('ui.log', async (input) => {
    const msg = input && typeof input === 'object' ? String((input as any).msg ?? '') : ''
    if (msg) orca.log(msg)
    return { ok: true }
  })

  async function withCfg<T>(
    rawInput: unknown,
    fn: (cfg: AwsCliConfig, ctx: { profile: string; region: string }, inp: Record<string, any>) => Promise<T>
  ): Promise<T> {
    const inp = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, any>
    const cfg = await readConfig(orca)
    const ctx = resolveContext(inp, cfg)
    return fn(cfg, ctx, inp)
  }

  // --- Sessão / Perfis / SSO ---

  orca.panels.handle('aws.status', (input) =>
    withCfg(input, async (cfg, ctx, inp): Promise<AwsStatusResult> => {
      const cacheKey = `${cfg.awsBin}|${cfg.runInWsl}|${ctx.profile}|${ctx.region}`
      const cached = statusCache.get(cacheKey)
      if (!inp.force && cached && Date.now() - cached.at < STATUS_TTL_MS) {
        return cached.result
      }

      const ver = await detectVersion(cfg)
      let profiles: string[] = []
      if (ver.supportsSso) {
        try {
          const rawProfiles = await runAwsRaw(cfg, ['configure', 'list-profiles'], undefined, { output: 'none', timeoutMs: 10_000 })
          profiles = parseProfiles(rawProfiles)
        } catch {
          profiles = []
        }
      }

      try {
        const rawId = await runAwsJson(cfg, ['sts', 'get-caller-identity'], ctx)
        const identity = parseCallerIdentity(rawId)
        const res: AwsStatusResult = {
          connected: true,
          profile: ctx.profile,
          region: ctx.region,
          profiles,
          identity,
          cliVersion: ver.version,
          supportsSso: ver.supportsSso
        }
        statusCache.set(cacheKey, { at: Date.now(), result: res })
        return res
      } catch (err) {
        statusCache.delete(cacheKey)
        const cliErr = err instanceof AwsCliError ? err : null
        const res: AwsStatusResult = {
          connected: false,
          profile: ctx.profile,
          region: ctx.region,
          profiles,
          identity: null,
          cliVersion: ver.version,
          supportsSso: ver.supportsSso,
          error: cliErr ? cliErr.message : String(err instanceof Error ? err.message : err),
          errorKind: cliErr ? cliErr.kind : 'cli'
        }
        return res
      }
    })
  )

  orca.panels.handle('aws.ssoLogin', (input) =>
    withCfg(input, async (cfg, ctx) => {
      const ver = await detectVersion(cfg)
      if (!ver.supportsSso) {
        throw new Error(
          `SSO Login requer AWS CLI v2 (detectado ${ver.version ? 'v' + ver.version : 'v1'}). ` +
          'O comando `uvx --from awscli aws` instala a v1, que não tem `aws sso login`.'
        )
      }
      const out = await runAwsRaw(cfg, ['sso', 'login'], ctx, { output: 'none', timeoutMs: 120_000 })
      statusCache.clear()
      await notify(orca, 'AWS SSO Login', `Login concluído (${ctx.profile || 'default'}).`)
      return { ok: true, output: out.trim() }
    })
  )

  // --- S3 ---

  orca.panels.handle('s3.listBuckets', (input) =>
    withCfg(input, async (cfg, ctx, inp) => {
      const ck = `s3.buckets|${ctx.profile}|${ctx.region}`
      const hit = getCached<{ buckets: any[] }>(ck, Boolean(inp.force))
      if (hit) return hit
      const raw = await runAwsJson(cfg, ['s3api', 'list-buckets'], ctx)
      const res = { buckets: parseS3Buckets(raw) }
      setCached(ck, res)
      return res
    })
  )

  orca.panels.handle('s3.listObjects', (input) =>
    withCfg(input, async (cfg, ctx, inp) => {
      const bucket = requireNonEmpty(inp.bucket, 'bucket')
      const prefix = typeof inp.prefix === 'string' ? inp.prefix : ''
      const maxKeys = clampInt(inp.maxKeys, 100, 1, 500)
      const token = typeof inp.continuationToken === 'string' ? inp.continuationToken : ''
      const ck = `s3.objects|${ctx.profile}|${ctx.region}|${bucket}|${prefix}|${maxKeys}|${token}`
      const hit = getCached(ck, Boolean(inp.force))
      if (hit) return hit
      const args = ['s3api', 'list-objects-v2', '--bucket', bucket, '--delimiter', '/', '--max-keys', String(maxKeys)]
      if (prefix) args.push('--prefix', prefix)
      if (token) args.push('--continuation-token', token)
      const raw = await runAwsJson(cfg, args, ctx)
      const res = parseS3Objects(raw, bucket, prefix)
      setCached(ck, res)
      return res
    })
  )

  orca.panels.handle('s3.headObject', (input) =>
    withCfg(input, async (cfg, ctx, inp) => {
      const bucket = requireNonEmpty(inp.bucket, 'bucket')
      const key = requireNonEmpty(inp.key, 'key')
      const raw = await runAwsJson<Record<string, any>>(cfg, ['s3api', 'head-object', '--bucket', bucket, '--key', key], ctx)
      return {
        bucket,
        key,
        contentType: String(raw?.ContentType ?? ''),
        contentLength: Number(raw?.ContentLength ?? 0),
        lastModified: String(raw?.LastModified ?? ''),
        etag: String(raw?.ETag ?? ''),
        storageClass: String(raw?.StorageClass ?? 'STANDARD'),
        metadata: raw?.Metadata ?? {}
      }
    })
  )

  orca.panels.handle('s3.presign', (input) =>
    withCfg(input, async (cfg, ctx, inp) => {
      const bucket = requireNonEmpty(inp.bucket, 'bucket')
      const key = requireNonEmpty(inp.key, 'key')
      const expiresIn = clampInt(inp.expiresIn, 900, 60, 604800)
      const url = (await runAwsRaw(cfg, ['s3', 'presign', `s3://${bucket}/${key}`, '--expires-in', String(expiresIn)], ctx, { output: 'none' })).trim()
      return { url, expiresIn }
    })
  )

  orca.panels.handle('s3.getObjectText', (input) =>
    withCfg(input, async (cfg, ctx, inp) => {
      const bucket = requireNonEmpty(inp.bucket, 'bucket')
      const key = requireNonEmpty(inp.key, 'key')
      const head = await runAwsJson<Record<string, any>>(cfg, ['s3api', 'head-object', '--bucket', bucket, '--key', key], ctx)
      const size = Number(head?.ContentLength ?? 0)
      if (size > MAX_PREVIEW_BYTES) {
        throw new Error(`Objeto tem ${Math.round(size / 1024)} KB (limite de preview: ${MAX_PREVIEW_BYTES / 1024} KB). Gere uma URL assinada para baixar.`)
      }
      const content = await runAwsRaw(cfg, ['s3', 'cp', `s3://${bucket}/${key}`, '-'], ctx, {
        output: 'none',
        maxBuffer: MAX_PREVIEW_BYTES + 65536
      })
      return { bucket, key, size, contentType: String(head?.ContentType ?? ''), content }
    })
  )

  orca.panels.handle('s3.putObjectText', (input) =>
    withCfg(input, async (cfg, ctx, inp) => {
      const bucket = requireNonEmpty(inp.bucket, 'bucket')
      const key = requireNonEmpty(inp.key, 'key')
      const content = typeof inp.content === 'string' ? inp.content : ''
      const contentType = typeof inp.contentType === 'string' && inp.contentType.trim() ? inp.contentType.trim() : ''
      const args = ['s3', 'cp', '-', `s3://${bucket}/${key}`]
      if (contentType) args.push('--content-type', contentType)
      await runAwsWithStdin(cfg, args, content, ctx)
      dataCache.clear()
      await notify(orca, 'S3 Upload', `Enviado s3://${bucket}/${key}`)
      return { ok: true, bucket, key }
    })
  )

  orca.panels.handle('s3.deleteObject', (input) =>
    withCfg(input, async (cfg, ctx, inp) => {
      const bucket = requireNonEmpty(inp.bucket, 'bucket')
      const key = requireNonEmpty(inp.key, 'key')
      await runAwsJson(cfg, ['s3api', 'delete-object', '--bucket', bucket, '--key', key], ctx)
      dataCache.clear()
      await notify(orca, 'S3 Excluir', `Removido s3://${bucket}/${key}`)
      return { ok: true, bucket, key }
    })
  )

  // --- EMR ---

  orca.panels.handle('emr.listClusters', (input) =>
    withCfg(input, async (cfg, ctx, inp) => {
      const onlyActive = inp.onlyActive !== false
      const args = ['emr', 'list-clusters']
      if (onlyActive) args.push('--active')
      const raw = await runAwsJson(cfg, args, ctx)
      return { clusters: parseEmrClusters(raw) }
    })
  )

  orca.panels.handle('emr.describeCluster', (input) =>
    withCfg(input, async (cfg, ctx, inp) => {
      const clusterId = requireNonEmpty(inp.clusterId, 'clusterId')
      const raw = await runAwsJson(cfg, ['emr', 'describe-cluster', '--cluster-id', clusterId], ctx)
      return { cluster: parseEmrClusterDetail(raw) }
    })
  )

  orca.panels.handle('emr.listSteps', (input) =>
    withCfg(input, async (cfg, ctx, inp) => {
      const clusterId = requireNonEmpty(inp.clusterId, 'clusterId')
      const raw = await runAwsJson(cfg, ['emr', 'list-steps', '--cluster-id', clusterId], ctx)
      return { steps: parseEmrSteps(raw) }
    })
  )

  orca.panels.handle('emr.addStep', (input) =>
    withCfg(input, async (cfg, ctx, inp) => {
      const clusterId = requireNonEmpty(inp.clusterId, 'clusterId')
      const name = requireNonEmpty(inp.name, 'name')
      const jar = typeof inp.jar === 'string' && inp.jar.trim() ? inp.jar.trim() : 'command-runner.jar'
      const rawArgs = typeof inp.args === 'string' ? splitArgs(inp.args) : Array.isArray(inp.args) ? inp.args.map(String) : []
      if (rawArgs.length === 0) throw new Error('Informe os argumentos do step (ex.: spark-submit s3://...).')
      const actionOnFailure = typeof inp.actionOnFailure === 'string' && inp.actionOnFailure ? inp.actionOnFailure : 'CONTINUE'
      const stepsJson = buildEmrStepPayload({ name, jar, args: rawArgs, actionOnFailure })
      const raw = await runAwsJson<{ StepIds?: string[] }>(cfg, ['emr', 'add-steps', '--cluster-id', clusterId, '--steps', stepsJson], ctx)
      const stepIds = Array.isArray(raw?.StepIds) ? raw.StepIds : []
      await notify(orca, 'EMR Step adicionado', `Cluster ${clusterId}: ${stepIds.join(', ') || name}`)
      return { ok: true, stepIds }
    })
  )

  orca.panels.handle('emr.cancelStep', (input) =>
    withCfg(input, async (cfg, ctx, inp) => {
      const clusterId = requireNonEmpty(inp.clusterId, 'clusterId')
      const stepId = requireNonEmpty(inp.stepId, 'stepId')
      const option = inp.option === 'TERMINATE_PROCESS' ? 'TERMINATE_PROCESS' : 'SEND_INTERRUPT'
      const raw = await runAwsJson(
        cfg,
        ['emr', 'cancel-steps', '--cluster-id', clusterId, '--step-ids', stepId, '--step-cancellation-option', option],
        ctx
      )
      await notify(orca, 'EMR Step cancelado', `Cancelamento solicitado para ${stepId}`)
      return { ok: true, result: raw }
    })
  )

  orca.panels.handle('emr.terminateCluster', (input) =>
    withCfg(input, async (cfg, ctx, inp) => {
      const clusterId = requireNonEmpty(inp.clusterId, 'clusterId')
      await runAwsRaw(cfg, ['emr', 'terminate-clusters', '--cluster-ids', clusterId], ctx, { output: 'none' })
      await notify(orca, 'EMR Cluster encerrado', `Solicitado encerramento de ${clusterId}`)
      return { ok: true, clusterId }
    })
  )

  // --- SQS ---

  orca.panels.handle('sqs.listQueues', (input) =>
    withCfg(input, async (cfg, ctx, inp) => {
      const args = ['sqs', 'list-queues']
      if (typeof inp.prefix === 'string' && inp.prefix.trim()) {
        args.push('--queue-name-prefix', inp.prefix.trim())
      }
      const raw = await runAwsJson(cfg, args, ctx)
      return { queues: parseSqsQueues(raw) }
    })
  )

  orca.panels.handle('sqs.getAttributes', (input) =>
    withCfg(input, async (cfg, ctx, inp) => {
      const queueUrl = requireNonEmpty(inp.queueUrl, 'queueUrl')
      const raw = await runAwsJson(cfg, ['sqs', 'get-queue-attributes', '--queue-url', queueUrl, '--attribute-names', 'All'], ctx)
      return { attributes: parseSqsAttributes(raw, queueUrl) }
    })
  )

  orca.panels.handle('sqs.peekMessages', (input) =>
    withCfg(input, async (cfg, ctx, inp) => {
      const queueUrl = requireNonEmpty(inp.queueUrl, 'queueUrl')
      const maxMessages = clampInt(inp.maxMessages, 10, 1, 10)
      const visibilityTimeout = clampInt(inp.visibilityTimeout, 0, 0, 43200)
      const raw = await runAwsJson(
        cfg,
        [
          'sqs',
          'receive-message',
          '--queue-url',
          queueUrl,
          '--max-number-of-messages',
          String(maxMessages),
          '--visibility-timeout',
          String(visibilityTimeout),
          '--wait-time-seconds',
          '1',
          '--attribute-names',
          'All',
          '--message-attribute-names',
          'All'
        ],
        ctx
      )
      return { messages: parseSqsMessages(raw) }
    })
  )

  orca.panels.handle('sqs.sendMessage', (input) =>
    withCfg(input, async (cfg, ctx, inp) => {
      const queueUrl = requireNonEmpty(inp.queueUrl, 'queueUrl')
      const body = requireNonEmpty(inp.body, 'body')
      const args = ['sqs', 'send-message', '--queue-url', queueUrl, '--message-body', body]
      if (typeof inp.messageGroupId === 'string' && inp.messageGroupId.trim()) {
        args.push('--message-group-id', inp.messageGroupId.trim())
      }
      if (typeof inp.deduplicationId === 'string' && inp.deduplicationId.trim()) {
        args.push('--message-deduplication-id', inp.deduplicationId.trim())
      }
      if (inp.delaySeconds !== undefined && inp.delaySeconds !== '') {
        const delay = clampInt(inp.delaySeconds, 0, 0, 900)
        if (delay > 0) args.push('--delay-seconds', String(delay))
      }
      const raw = await runAwsJson<{ MessageId?: string }>(cfg, args, ctx)
      await notify(orca, 'SQS Mensagem enviada', `MessageId: ${raw?.MessageId ?? '-'}`)
      return { ok: true, messageId: String(raw?.MessageId ?? '') }
    })
  )

  orca.panels.handle('sqs.deleteMessage', (input) =>
    withCfg(input, async (cfg, ctx, inp) => {
      const queueUrl = requireNonEmpty(inp.queueUrl, 'queueUrl')
      const receiptHandle = requireNonEmpty(inp.receiptHandle, 'receiptHandle')
      await runAwsRaw(cfg, ['sqs', 'delete-message', '--queue-url', queueUrl, '--receipt-handle', receiptHandle], ctx, { output: 'none' })
      return { ok: true }
    })
  )

  orca.panels.handle('sqs.purgeQueue', (input) =>
    withCfg(input, async (cfg, ctx, inp) => {
      const queueUrl = requireNonEmpty(inp.queueUrl, 'queueUrl')
      await runAwsRaw(cfg, ['sqs', 'purge-queue', '--queue-url', queueUrl], ctx, { output: 'none' })
      await notify(orca, 'SQS Fila purgada', queueUrl)
      return { ok: true }
    })
  )
}

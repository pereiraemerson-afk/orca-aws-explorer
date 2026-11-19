import type {
  CallerIdentity,
  EmrClusterDetail,
  EmrClusterSummary,
  EmrStepSummary,
  S3Bucket,
  S3ListObjectsResult,
  S3ObjectItem,
  SqsMessageItem,
  SqsQueueAttributes,
  SqsQueueSummary
} from './protocol'

function toNum(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

export type SupportedLang = 'pt-BR' | 'en'

/** Resolves the UI language from the plugin setting (`auto` | `pt-BR` | `en`) and Orca locale. */
export function resolveLanguage(setting: unknown, orcaLocale?: string): SupportedLang {
  if (setting === 'pt-BR' || setting === 'en') return setting
  const loc = String(orcaLocale ?? '').toLowerCase()
  return loc.startsWith('pt') ? 'pt-BR' : 'en'
}

/** Extracts AWS CLI major version (`aws-cli/2.x` -> supports SSO; `aws-cli/1.x` -> no SSO). */
export function parseCliVersion(output: string): { version: string; supportsSso: boolean } {
  const m = output.match(/aws-cli\/(\d+\.\d+\.\d+)/i)
  const version = m ? m[1] : ''
  const major = version ? Number(version.split('.')[0]) : 0
  return { version, supportsSso: major >= 2 }
}

/** Parses `aws configure list-profiles` plain-text output. */
export function parseProfiles(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** Parses `aws sts get-caller-identity` JSON output. */
export function parseCallerIdentity(raw: any): CallerIdentity {
  return {
    account: String(raw?.Account ?? ''),
    arn: String(raw?.Arn ?? ''),
    userId: String(raw?.UserId ?? '')
  }
}

/** Parses `aws s3api list-buckets` JSON output. */
export function parseS3Buckets(raw: any): S3Bucket[] {
  const list = Array.isArray(raw?.Buckets) ? raw.Buckets : []
  return list
    .map((b: any) => ({
      name: String(b?.Name ?? ''),
      createdAt: String(b?.CreationDate ?? '')
    }))
    .filter((b: S3Bucket) => b.name.length > 0)
    .sort((a: S3Bucket, b: S3Bucket) => a.name.localeCompare(b.name))
}

/** Parses `aws s3api list-objects-v2` JSON output with delimiter `/`. */
export function parseS3Objects(raw: any, bucket: string, prefix: string): S3ListObjectsResult {
  const folders: string[] = (Array.isArray(raw?.CommonPrefixes) ? raw.CommonPrefixes : [])
    .map((p: any) => String(p?.Prefix ?? ''))
    .filter(Boolean)
    .sort((a: string, b: string) => a.localeCompare(b))

  const objects: S3ObjectItem[] = (Array.isArray(raw?.Contents) ? raw.Contents : [])
    .map((o: any) => {
      const key = String(o?.Key ?? '')
      const name = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key
      return {
        key,
        name,
        size: toNum(o?.Size),
        lastModified: String(o?.LastModified ?? ''),
        storageClass: String(o?.StorageClass ?? 'STANDARD')
      }
    })
    .filter((o: S3ObjectItem) => o.key.length > 0 && o.key !== prefix)

  return {
    bucket,
    prefix,
    folders,
    objects,
    truncated: Boolean(raw?.IsTruncated),
    nextToken: raw?.NextContinuationToken ? String(raw.NextContinuationToken) : null
  }
}

/** Parses `aws emr list-clusters` JSON output. */
export function parseEmrClusters(raw: any): EmrClusterSummary[] {
  const list = Array.isArray(raw?.Clusters) ? raw.Clusters : []
  return list.map((c: any) => ({
    id: String(c?.Id ?? ''),
    name: String(c?.Name ?? ''),
    state: String(c?.Status?.State ?? 'UNKNOWN'),
    stateReason: String(c?.Status?.StateChangeReason?.Message ?? ''),
    createdAt: String(c?.Status?.Timeline?.CreationDateTime ?? ''),
    readyAt: String(c?.Status?.Timeline?.ReadyDateTime ?? ''),
    endedAt: String(c?.Status?.Timeline?.EndDateTime ?? ''),
    normalizedHours: toNum(c?.NormalizedInstanceHours)
  }))
}

/** Parses `aws emr describe-cluster` JSON output. */
export function parseEmrClusterDetail(raw: any): EmrClusterDetail {
  const c = raw?.Cluster ?? {}
  const apps = Array.isArray(c?.Applications)
    ? c.Applications.map((a: any) => [a?.Name, a?.Version].filter(Boolean).join(' '))
    : []
  return {
    id: String(c?.Id ?? ''),
    name: String(c?.Name ?? ''),
    state: String(c?.Status?.State ?? 'UNKNOWN'),
    stateReason: String(c?.Status?.StateChangeReason?.Message ?? ''),
    createdAt: String(c?.Status?.Timeline?.CreationDateTime ?? ''),
    readyAt: String(c?.Status?.Timeline?.ReadyDateTime ?? ''),
    endedAt: String(c?.Status?.Timeline?.EndDateTime ?? ''),
    normalizedHours: toNum(c?.NormalizedInstanceHours),
    releaseLabel: String(c?.ReleaseLabel ?? ''),
    masterDns: String(c?.MasterPublicDnsName ?? ''),
    autoTerminate: Boolean(c?.AutoTerminate),
    terminationProtected: Boolean(c?.TerminationProtected),
    logUri: String(c?.LogUri ?? ''),
    applications: apps
  }
}

/** Parses `aws emr list-steps` JSON output. */
export function parseEmrSteps(raw: any): EmrStepSummary[] {
  const list = Array.isArray(raw?.Steps) ? raw.Steps : []
  return list.map((s: any) => ({
    id: String(s?.Id ?? ''),
    name: String(s?.Name ?? ''),
    state: String(s?.Status?.State ?? 'UNKNOWN'),
    actionOnFailure: String(s?.ActionOnFailure ?? ''),
    createdAt: String(s?.Status?.Timeline?.CreationDateTime ?? ''),
    startedAt: String(s?.Status?.Timeline?.StartDateTime ?? ''),
    endedAt: String(s?.Status?.Timeline?.EndDateTime ?? ''),
    jar: String(s?.Config?.Jar ?? ''),
    args: Array.isArray(s?.Config?.Args) ? s.Config.Args.map(String) : [],
    failureReason: String(s?.Status?.FailureDetails?.Message ?? s?.Status?.FailureDetails?.Reason ?? '')
  }))
}

/** Extracts the queue name from a standard SQS queue URL. */
export function queueNameFromUrl(url: string): string {
  const parts = url.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? url
}

/** Parses `aws sqs list-queues` JSON output. */
export function parseSqsQueues(raw: any): SqsQueueSummary[] {
  const urls: string[] = Array.isArray(raw?.QueueUrls) ? raw.QueueUrls.map(String) : []
  return urls
    .map((url) => {
      const name = queueNameFromUrl(url)
      return { url, name, fifo: name.endsWith('.fifo') }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Parses `aws sqs get-queue-attributes --attribute-names All` JSON output. */
export function parseSqsAttributes(raw: any, url: string): SqsQueueAttributes {
  const attrs: Record<string, string> = raw?.Attributes && typeof raw.Attributes === 'object' ? raw.Attributes : {}
  const name = queueNameFromUrl(url)
  let dlqArn = ''
  if (attrs.RedrivePolicy) {
    try {
      const rp = JSON.parse(attrs.RedrivePolicy)
      if (rp?.deadLetterTargetArn) dlqArn = String(rp.deadLetterTargetArn)
    } catch { /* ignore malformed policy */ }
  }
  return {
    url,
    name,
    fifo: name.endsWith('.fifo') || attrs.FifoQueue === 'true',
    visible: toNum(attrs.ApproximateNumberOfMessages),
    notVisible: toNum(attrs.ApproximateNumberOfMessagesNotVisible),
    delayed: toNum(attrs.ApproximateNumberOfMessagesDelayed),
    retentionSeconds: toNum(attrs.MessageRetentionPeriod),
    visibilityTimeout: toNum(attrs.VisibilityTimeout),
    dlqArn,
    arn: String(attrs.QueueArn ?? ''),
    raw: attrs
  }
}

/** Parses `aws sqs receive-message` JSON output. */
export function parseSqsMessages(raw: any): SqsMessageItem[] {
  const list = Array.isArray(raw?.Messages) ? raw.Messages : []
  return list.map((m: any) => {
    const attrs: Record<string, string> = m?.Attributes && typeof m.Attributes === 'object' ? m.Attributes : {}
    const sentMs = Number(attrs.SentTimestamp ?? 0)
    return {
      messageId: String(m?.MessageId ?? ''),
      receiptHandle: String(m?.ReceiptHandle ?? ''),
      body: String(m?.Body ?? ''),
      md5: String(m?.MD5OfBody ?? ''),
      sentAt: sentMs > 0 ? new Date(sentMs).toISOString() : '',
      receiveCount: String(attrs.ApproximateReceiveCount ?? ''),
      messageGroupId: String(attrs.MessageGroupId ?? ''),
      attributes: attrs
    }
  })
}

/** Splits a shell-like argument string into an argv array (supports quoted tokens). */
export function splitArgs(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < input.length) cur += input[++i]
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (cur.length > 0) { out.push(cur); cur = '' }
    } else {
      cur += ch
    }
  }
  if (cur.length > 0) out.push(cur)
  return out
}

/** Builds the JSON payload for `aws emr add-steps --steps`. */
export function buildEmrStepPayload(input: {
  name: string
  jar: string
  args: string[]
  actionOnFailure?: string
}): string {
  const step = {
    Name: input.name.trim(),
    ActionOnFailure: input.actionOnFailure || 'CONTINUE',
    HadoopJarStep: {
      Jar: input.jar.trim() || 'command-runner.jar',
      Args: input.args
    }
  }
  return JSON.stringify([step])
}

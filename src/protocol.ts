export interface AwsContextInput {
  profile?: string
  region?: string
  lang?: 'pt-BR' | 'en'
}

export interface AwsCliConfig {
  awsBin: string
  runInWsl: boolean
  defaultProfile: string
  defaultRegion: string
  timeoutMs: number
  lang: 'pt-BR' | 'en'
}

export interface CallerIdentity {
  account: string
  arn: string
  userId: string
}

export interface AwsStatusResult {
  connected: boolean
  profile: string
  region: string
  profiles: string[]
  identity: CallerIdentity | null
  cliVersion: string
  supportsSso: boolean
  error?: string
  errorKind?: 'not_found' | 'auth' | 'access_denied' | 'timeout' | 'cli'
}

export interface S3Bucket {
  name: string
  createdAt: string
}

export interface S3ObjectItem {
  key: string
  name: string
  size: number
  lastModified: string
  storageClass: string
}

export interface S3ListObjectsResult {
  bucket: string
  prefix: string
  folders: string[]
  objects: S3ObjectItem[]
  truncated: boolean
  nextToken: string | null
}

export interface EmrClusterSummary {
  id: string
  name: string
  state: string
  stateReason: string
  createdAt: string
  readyAt: string
  endedAt: string
  normalizedHours: number
}

export interface EmrClusterDetail extends EmrClusterSummary {
  releaseLabel: string
  masterDns: string
  autoTerminate: boolean
  terminationProtected: boolean
  logUri: string
  applications: string[]
}

export interface EmrStepSummary {
  id: string
  name: string
  state: string
  actionOnFailure: string
  createdAt: string
  startedAt: string
  endedAt: string
  jar: string
  args: string[]
  failureReason: string
}

export interface SqsQueueSummary {
  url: string
  name: string
  fifo: boolean
}

export interface SqsQueueAttributes {
  url: string
  name: string
  fifo: boolean
  visible: number
  notVisible: number
  delayed: number
  retentionSeconds: number
  visibilityTimeout: number
  dlqArn: string
  arn: string
  raw: Record<string, string>
}

export interface SqsMessageItem {
  messageId: string
  receiptHandle: string
  body: string
  md5: string
  sentAt: string
  receiveCount: string
  messageGroupId: string
  attributes: Record<string, string>
}

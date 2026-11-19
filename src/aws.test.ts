import { assert, test } from 'orca/testing'
import { buildAwsCommand, classifyCliError } from './cli'
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
  queueNameFromUrl,
  resolveLanguage,
  splitArgs
} from './parse'

test('buildAwsCommand monta argv seguro no Windows, WSL e comandos multi-token (uvx)', () => {
  const win = buildAwsCommand(
    { awsBin: 'aws', runInWsl: false },
    ['s3api', 'list-buckets'],
    { profile: 'prod', region: 'sa-east-1' },
    'json'
  )
  assert.equal(win.command, 'aws')
  assert.deepEqual(win.args, ['--profile', 'prod', '--region', 'sa-east-1', '--output', 'json', 's3api', 'list-buckets'])

  const wsl = buildAwsCommand(
    { awsBin: '/usr/local/bin/uvx --from awscli aws', runInWsl: true },
    ['sts', 'get-caller-identity'],
    { profile: 'dev-profile' },
    'json'
  )
  assert.equal(wsl.command, 'wsl.exe')
  assert.deepEqual(wsl.args, [
    '--',
    '/usr/local/bin/uvx',
    '--from',
    'awscli',
    'aws',
    '--profile',
    'dev-profile',
    '--output',
    'json',
    'sts',
    'get-caller-identity'
  ])
})

test('classifyCliError identifica ENOENT, SSO expirado, AccessDenied e timeout', () => {
  assert.equal(classifyCliError('', 'ENOENT'), 'not_found')
  assert.equal(classifyCliError('Error loading SSO Token: Token for dev has expired'), 'auth')
  assert.equal(classifyCliError('An error occurred (AccessDenied) when calling ListObjectsV2'), 'access_denied')
  assert.equal(classifyCliError('', null, true), 'timeout')
  assert.equal(classifyCliError('Unknown options: --foo'), 'cli')
})

test('parseProfiles, parseCallerIdentity e parseCliVersion', () => {
  assert.deepEqual(parseProfiles('default\r\nprod\n\nhomolog \n'), ['default', 'prod', 'homolog'])
  const id = parseCallerIdentity({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/dev', UserId: 'AIDA123' })
  assert.equal(id.account, '123456789012')
  assert.equal(id.arn, 'arn:aws:iam::123456789012:user/dev')
  assert.deepEqual(parseCliVersion('aws-cli/1.46.3 Python/3.13.14 Linux'), { version: '1.46.3', supportsSso: false })
  assert.deepEqual(parseCliVersion('aws-cli/2.17.10 Python/3.11.9 Windows/11'), { version: '2.17.10', supportsSso: true })
  assert.equal(resolveLanguage('pt-BR', 'en-US'), 'pt-BR')
  assert.equal(resolveLanguage('en', 'pt-BR'), 'en')
  assert.equal(resolveLanguage('auto', 'pt-BR'), 'pt-BR')
  assert.equal(resolveLanguage('auto', 'en-US'), 'en')
})

test('parseS3Buckets e parseS3Objects com prefixo e pastas', () => {
  const buckets = parseS3Buckets({
    Buckets: [
      { Name: 'z-logs', CreationDate: '2026-01-01T00:00:00Z' },
      { Name: 'a-data', CreationDate: '2025-05-01T00:00:00Z' }
    ]
  })
  assert.deepEqual(buckets.map((b) => b.name), ['a-data', 'z-logs'])

  const listed = parseS3Objects(
    {
      CommonPrefixes: [{ Prefix: 'raw/2026/' }, { Prefix: 'raw/2025/' }],
      Contents: [
        { Key: 'raw/', Size: 0, LastModified: '2026-01-01T00:00:00Z' },
        { Key: 'raw/sample.json', Size: 512, LastModified: '2026-01-02T10:00:00Z', StorageClass: 'STANDARD' }
      ],
      IsTruncated: false
    },
    'a-data',
    'raw/'
  )
  assert.deepEqual(listed.folders, ['raw/2025/', 'raw/2026/'])
  assert.equal(listed.objects.length, 1)
  assert.equal(listed.objects[0].name, 'sample.json')
  assert.equal(listed.objects[0].size, 512)
  assert.equal(listed.nextToken, null)
  // Garante compatibilidade com o validador JSON estrito do Orca (sem undefined/NaN)
  assert.deepEqual(JSON.parse(JSON.stringify(listed)), listed)
})

test('parseEmrClusters, parseEmrClusterDetail, parseEmrSteps e buildEmrStepPayload', () => {
  const clusters = parseEmrClusters({
    Clusters: [
      {
        Id: 'j-123ABC',
        Name: 'etl-prod',
        NormalizedInstanceHours: 24,
        Status: { State: 'WAITING', Timeline: { CreationDateTime: '2026-11-19T10:00:00Z' } }
      }
    ]
  })
  assert.equal(clusters[0].id, 'j-123ABC')
  assert.equal(clusters[0].state, 'WAITING')

  const detail = parseEmrClusterDetail({
    Cluster: {
      Id: 'j-123ABC',
      Name: 'etl-prod',
      ReleaseLabel: 'emr-7.1.0',
      AutoTerminate: false,
      TerminationProtected: true,
      Applications: [{ Name: 'Spark', Version: '3.5.0' }],
      Status: { State: 'WAITING' }
    }
  })
  assert.equal(detail.releaseLabel, 'emr-7.1.0')
  assert.deepEqual(detail.applications, ['Spark 3.5.0'])

  const steps = parseEmrSteps({
    Steps: [
      {
        Id: 's-999',
        Name: 'daily-job',
        ActionOnFailure: 'CONTINUE',
        Status: { State: 'COMPLETED' },
        Config: { Jar: 'command-runner.jar', Args: ['spark-submit', 's3://b/job.py'] }
      }
    ]
  })
  assert.equal(steps[0].id, 's-999')
  assert.deepEqual(steps[0].args, ['spark-submit', 's3://b/job.py'])

  assert.deepEqual(splitArgs('spark-submit --conf "a=b c" s3://b/job.py'), ['spark-submit', '--conf', 'a=b c', 's3://b/job.py'])
  const payload = JSON.parse(buildEmrStepPayload({ name: 'job', jar: 'command-runner.jar', args: ['spark-submit', 's3://b/a.py'] }))
  assert.equal(payload[0].Name, 'job')
  assert.equal(payload[0].HadoopJarStep.Jar, 'command-runner.jar')
})

test('parseSqsQueues, parseSqsAttributes e parseSqsMessages', () => {
  const queues = parseSqsQueues({
    QueueUrls: [
      'https://sqs.sa-east-1.amazonaws.com/123456789012/pedidos.fifo',
      'https://sqs.sa-east-1.amazonaws.com/123456789012/alertas'
    ]
  })
  assert.equal(queueNameFromUrl(queues[0].url), 'alertas')
  assert.equal(queues[0].fifo, false)
  assert.equal(queues[1].name, 'pedidos.fifo')
  assert.equal(queues[1].fifo, true)

  const attrs = parseSqsAttributes(
    {
      Attributes: {
        ApproximateNumberOfMessages: '14',
        ApproximateNumberOfMessagesNotVisible: '2',
        ApproximateNumberOfMessagesDelayed: '0',
        RedrivePolicy: '{"deadLetterTargetArn":"arn:aws:sqs:sa-east-1:123:dlq","maxReceiveCount":5}'
      }
    },
    'https://sqs.sa-east-1.amazonaws.com/123456789012/alertas'
  )
  assert.equal(attrs.visible, 14)
  assert.equal(attrs.notVisible, 2)
  assert.equal(attrs.dlqArn, 'arn:aws:sqs:sa-east-1:123:dlq')

  const msgs = parseSqsMessages({
    Messages: [
      {
        MessageId: 'm-1',
        ReceiptHandle: 'rh-1',
        Body: '{"ok":true}',
        Attributes: { SentTimestamp: '1700000000000', ApproximateReceiveCount: '1' }
      }
    ]
  })
  assert.equal(msgs[0].messageId, 'm-1')
  assert.equal(msgs[0].receiveCount, '1')
  assert.ok(msgs[0].sentAt.startsWith('2023-'))
})

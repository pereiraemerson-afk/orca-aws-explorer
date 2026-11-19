# AWS Explorer (Orca Plugin)

Full-tab AWS console inside Orca for **S3**, **EMR**, and **SQS**, delegating directly to your local authenticated **AWS CLI** (v1 or v2) without reading or storing credentials.

## Features
- **Session & Profiles:** switch `--profile` and `--region` on the fly, verify caller identity (`sts get-caller-identity`), and run `aws sso login` (AWS CLI v2).
- **S3:** list buckets, browse prefixes/folders, preview and save text/JSON objects (up to 256 KB), generate presigned URLs, upload text/JSON objects, and delete objects (with confirmation).
- **EMR:** list active or recent clusters, inspect cluster details and steps, submit new steps (`add-steps`), cancel running/pending steps (`cancel-steps`), and terminate clusters (with confirmation).
- **SQS:** filter queues by prefix, view queue counts (`Visible`, `In flight`, `Delayed`, DLQ), peek messages (`visibility-timeout 0`), send Standard and FIFO messages, delete individual messages, and purge queues (with confirmation).
- **Languages:** English (`en`) and Portuguese (Brazil) (`pt-BR`), configurable via Settings or the top-bar toggle.

## How to open
Click **`+`** in Orca's tab bar (or open the Command Palette) and choose **AWS Explorer**.

## Settings (`Settings → Plugins → AWS Explorer`)
- `awsBin`: binary path or multi-token command (default `aws`; also supports commands like `uvx --from awscli aws`).
- `runInWsl`: on Windows, run via `wsl.exe -- <awsBin>` to use your WSL AWS CLI and credentials.
- `defaultProfile` / `defaultRegion`: initial profile and region.
- `timeoutSeconds`: timeout per AWS CLI command (5–180 s).
- `language`: `auto` (follows Orca's locale), `en`, or `pt-BR`.

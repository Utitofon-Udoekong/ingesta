# Ingesta

**Secure, zero-cold-start document ingestion for production RAG on AWS.**

Ingesta is an AWS CDK v2 (TypeScript) stack that turns S3 uploads into AI-ready vector embeddings — chunked, embedded via Amazon Bedrock Titan, and stored in Aurora Serverless v2 PostgreSQL with pgvector.

## Complete Prompt (AWS Prompt the Planet Challenge)

This repository is a **prompt-driven infrastructure submission**. Copy the verbatim prompt below into any AI assistant (Claude, GPT, Cursor) to generate the full CDK stack:

**[`submissions/01_zero_cold_start_rag/PROMPT_VERBATIM.txt`](submissions/01_zero_cold_start_rag/PROMPT_VERBATIM.txt)**

The code in this repo is the validated output of running that prompt. Judges: start with the prompt file, then explore the generated project in the same directory.

## The Problem

Serverless RAG pipelines often fail at ingestion: Lambda cold starts delay uploads, database credentials end up in secrets or env vars, and vector databases run 24/7 even when idle.

## What Ingesta Delivers

- **Instant ingestion** — Lambda provisioned concurrency on a published alias eliminates cold starts
- **Zero-trust security** — IAM database authentication, KMS-encrypted S3, private VPC endpoints for Bedrock and S3
- **Cost control** — Aurora Serverless v2 (0.5–2.0 ACUs), S3 lifecycle rules, $50/month budget alarm
- **Production reliability** — SQS dead-letter queue, CloudWatch dashboard, pgvector HNSW index

## Architecture

```
S3 Upload → Lambda (warm) → Bedrock Titan Embed → Aurora pgvector
                ↓
         Private VPC (S3 + Bedrock endpoints)
```

## Quick Start

```bash
cd submissions/01_zero_cold_start_rag
npm install
npm run build

# Set budget alert email before deploy
# Windows:
set BUDGET_NOTIFICATION_EMAIL=you@example.com
# macOS/Linux:
export BUDGET_NOTIFICATION_EMAIL=you@example.com

npx cdk bootstrap   # first time only
npx cdk deploy
```

Upload a document to the provisioned S3 bucket to trigger the ingestion pipeline.

## Prerequisites

- AWS CLI v2 with deploy credentials
- Node.js 18+
- AWS CDK CLI (`npm install -g aws-cdk`)
- Bedrock access for `amazon.titan-embed-text-v1` in your target region
- Docker (for Lambda bundling)

## Project Structure

```
.
└── submissions/01_zero_cold_start_rag/
    ├── PROMPT_VERBATIM.txt           # Complete copy-paste prompt (submission)
    ├── lib/serverless-rag-stack.ts   # CDK infrastructure
    ├── lambda/ingestion/             # S3 → chunk → embed → store
    ├── lambda/db-init/               # pgvector schema setup
    └── bin/app.ts                    # CDK app entry
```

See [`submissions/01_zero_cold_start_rag/README.md`](submissions/01_zero_cold_start_rag/README.md) for detailed deploy and architecture notes.

## AWS Services

Amazon Bedrock · AWS Lambda · Aurora Serverless v2 · Amazon S3 · Amazon VPC · AWS KMS · AWS IAM · Amazon SQS · Amazon CloudWatch · AWS Budgets · AWS CDK

## License

See repository license file for terms.

# Zero-Cold-Start Serverless RAG Pipeline

AWS CDK v2 (TypeScript) stack for event-driven document ingestion: S3 upload triggers a warm Lambda function that chunks documents, generates embeddings via Amazon Bedrock (Titan), and stores vectors in Aurora Serverless v2 PostgreSQL with pgvector.

## Complete Prompt

**Copy-paste prompt:** [`PROMPT_VERBATIM.txt`](PROMPT_VERBATIM.txt)

Paste into an AI assistant to regenerate this project from scratch.

## Prerequisites

- AWS CLI v2 with deploy credentials
- Node.js 18+
- AWS CDK CLI (`npm install -g aws-cdk`)
- Bedrock access for `amazon.titan-embed-text-v1` in target region
- Docker (for Lambda bundling)

## Deploy

```bash
npm install
npm run build
# Windows
set BUDGET_NOTIFICATION_EMAIL=you@example.com
# macOS/Linux
export BUDGET_NOTIFICATION_EMAIL=you@example.com
npx cdk deploy
```

## Architecture

- **S3** ingestion bucket (KMS encrypted) triggers Lambda **alias** with provisioned concurrency
- **Lambda** in private subnets: chunk → Bedrock embed → pgvector insert (IAM DB auth)
- **Aurora Serverless v2** (0.5–2 ACUs) with pgvector HNSW index
- **VPC** private endpoints for S3 and Bedrock Runtime
- **SQS DLQ**, CloudWatch dashboard, $50/month budget alert

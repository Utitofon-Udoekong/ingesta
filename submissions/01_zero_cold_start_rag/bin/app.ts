#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ServerlessRagIngestionStack } from '../lib/serverless-rag-stack';

const app = new cdk.App();

new ServerlessRagIngestionStack(app, 'ServerlessRagIngestionStack', {
  // Use account/region from CDK environment defaults or fallback
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  budgetNotificationEmail: process.env.BUDGET_NOTIFICATION_EMAIL,
});

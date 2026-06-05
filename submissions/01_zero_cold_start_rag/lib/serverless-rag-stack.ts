import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as customresources from 'aws-cdk-lib/custom-resources';
import { CustomResource, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as path from 'path';

// AWS-managed S3 Prefix List IDs by region. Used to enable offline synthesis
// without requiring active AWS credentials during CDK build.
const S3_PREFIX_LIST_IDS: { [region: string]: string } = {
  'us-east-1': 'pl-63a5400a',
  'us-east-2': 'pl-7ca54015',
  'us-west-1': 'pl-6fa54006',
  'us-west-2': 'pl-6ca54005',
  'eu-west-1': 'pl-6aa54003',
  'eu-west-2': 'pl-78a54011',
  'eu-west-3': 'pl-7fa54016',
  'eu-central-1': 'pl-6ba54002',
  'ap-northeast-1': 'pl-61a54008',
  'ap-northeast-2': 'pl-62a5400b',
  'ap-southeast-1': 'pl-6ea54007',
  'ap-southeast-2': 'pl-6da54004',
  'ca-central-1': 'pl-6ea54007',
  'sa-east-1': 'pl-6ba54002',
};

export interface ServerlessRagIngestionStackProps extends cdk.StackProps {
  /**
   * The email address to receive budget notifications.
   */
  readonly budgetNotificationEmail?: string;
}

export class ServerlessRagIngestionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: ServerlessRagIngestionStackProps) {
    super(scope, id, props);

    const dbUser = 'db_user';

    // ==========================================
    // 1. VPC & NETWORK ISOLATION
    // ==========================================
    const vpc = new ec2.Vpc(this, 'RagVpc', {
      vpcName: 'RagVpc',
      maxAzs: 2,
      // 1 Public Subnet, 2 Private Isolated Subnets per AZ
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'IsolatedDb',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
        {
          name: 'IsolatedCompute',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // VPC Gateway Endpoint for S3 (Saves NAT Gateway costs)
    const s3GatewayEndpoint = vpc.addGatewayEndpoint('S3GatewayEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
    });

    // ==========================================
    // 2. SECURITY GROUP CONFIGURATIONS
    // ==========================================
    // Get the AWS-managed S3 Prefix List ID for the current region
    const s3PrefixListId = S3_PREFIX_LIST_IDS[this.region] || 'pl-63a5400a';

    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSG', {
      vpc,
      securityGroupName: 'RagLambdaSecurityGroup',
      description: 'Security group for RAG ingestion Lambda function',
      allowAllOutbound: false, // Strict control
    });

    const rdsSecurityGroup = new ec2.SecurityGroup(this, 'RdsSG', {
      vpc,
      securityGroupName: 'RagRdsSecurityGroup',
      description: 'Security group for Aurora PostgreSQL cluster',
      allowAllOutbound: false, // Strict control
    });

    // Configure security group for VPC Interface Endpoints
    const vpceSecurityGroup = new ec2.SecurityGroup(this, 'VpceSG', {
      vpc,
      securityGroupName: 'RagVpcEndpointsSecurityGroup',
      description: 'Security group for private VPC interface endpoints',
    });

    // Inbound: Only allow port 443 (HTTPS) from the Lambda security group
    vpceSecurityGroup.addIngressRule(
      lambdaSecurityGroup,
      ec2.Port.tcp(443),
      'Allow HTTPS connections from Ingestion Lambda'
    );

    // Outbound: Ingestion Lambda can only connect to:
    // A. The RDS security group on PostgreSQL port 5432
    lambdaSecurityGroup.connections.allowTo(
      rdsSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow PostgreSQL connections to Aurora Serverless'
    );

    // B. The VPC endpoints security group on port 443 (HTTPS)
    lambdaSecurityGroup.connections.allowTo(
      vpceSecurityGroup,
      ec2.Port.tcp(443),
      'Allow HTTPS connections to VPC interface endpoints'
    );

    // C. The S3 Gateway Endpoint via regional Prefix List (HTTPS port 443)
    lambdaSecurityGroup.connections.allowTo(
      ec2.Peer.prefixList(s3PrefixListId),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic to S3 Gateway Endpoint'
    );

    // Inbound: RDS Security Group allows inbound PostgreSQL only from Lambda SG
    rdsSecurityGroup.addIngressRule(
      lambdaSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow inbound PostgreSQL connections from Ingestion Lambda'
    );

    // VPC Interface Endpoint for Bedrock Runtime (private LLM traffic)
    vpc.addInterfaceEndpoint('BedrockInterfaceEndpoint', {
      service: new ec2.InterfaceVpcEndpointService(`com.amazonaws.${this.region}.bedrock-runtime`),
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [vpceSecurityGroup],
    });

    // ==========================================
    // 3. STORAGE & ENCRYPTION
    // ==========================================
    // S3 KMS Customer Managed Key (CMK)
    const kmsKey = new kms.Key(this, 'S3BucketKey', {
      enableKeyRotation: true,
      description: 'KMS Customer Managed Key for RAG Ingestion S3 Bucket',
      removalPolicy: RemovalPolicy.DESTROY, // For hackathon/clean demo environment
    });

    // S3 Ingestion Bucket
    const bucket = new s3.Bucket(this, 'IngestionBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: kmsKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // Cost Optimization: Transition and Expiration rules
      lifecycleRules: [
        {
          transitions: [
            {
              transitionAfter: Duration.days(30),
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
            },
          ],
          expiration: Duration.days(90),
        },
      ],
    });

    // ==========================================
    // 4. DATABASE: AURORA SERVERLESS V2
    // ==========================================
    // Generate db credentials stored in Secrets Manager (Master Password)
    const dbCredentials = rds.Credentials.fromGeneratedSecret('postgres', {
      secretName: 'RagDatabaseMasterSecret',
    });

    const cluster = new rds.DatabaseCluster(this, 'RagDatabase', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_4,
      }),
      credentials: dbCredentials,
      clusterIdentifier: 'rag-vector-db-cluster',
      iamAuthentication: true, // No static passwords for application runtime
      vpc,
      vpcSubnets: {
        subnetGroupName: 'IsolatedDb',
      },
      securityGroups: [rdsSecurityGroup],
      removalPolicy: RemovalPolicy.DESTROY,
      // Cost Optimization: 0.5 to 2.0 ACU scaling limits
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 2.0,
      writer: rds.ClusterInstance.serverlessV2('WriterInstance', {
        publiclyAccessible: false,
      }),
    });

    // ==========================================
    // 5. DATABASE INITIALIZATION CUSTOM RESOURCE
    // ==========================================
    // Setup short-lived Lambda in VPC to initialize pgvector & user creation
    const dbInitLambda = new nodejs.NodejsFunction(this, 'DbInitFunction', {
      entry: path.join(__dirname, '../lambda/db-init/index.ts'),
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'handler',
      vpc,
      vpcSubnets: {
        subnetGroupName: 'IsolatedCompute',
      },
      securityGroups: [lambdaSecurityGroup],
      timeout: Duration.seconds(120),
      memorySize: 256,
      logRetention: logs.RetentionDays.TWO_WEEKS, // Cost Optimization: 14 days retention
      environment: {
        DB_SECRET_ARN: cluster.secret!.secretArn,
        DB_USER: dbUser,
      },
    });

    // Grant schema initialization Lambda permissions
    cluster.secret!.grantRead(dbInitLambda);

    // Custom Resource Provider for schema initialization
    const dbInitProvider = new customresources.Provider(this, 'DbInitProvider', {
      onEventHandler: dbInitLambda,
      vpc,
      vpcSubnets: {
        subnetGroupName: 'IsolatedCompute',
      },
      securityGroups: [lambdaSecurityGroup],
    });

    const dbInitResource = new CustomResource(this, 'DbInitCustomResource', {
      serviceToken: dbInitProvider.serviceToken,
    });

    // Ensure database cluster is ready before running initialization
    dbInitResource.node.addDependency(cluster);

    // ==========================================
    // 6. RELIABILITY: SQS DEAD-LETTER QUEUE
    // ==========================================
    const dlq = new sqs.Queue(this, 'IngestionDlq', {
      queueName: 'rag-ingestion-dlq',
      retentionPeriod: Duration.days(14), // 14-day retention requirement
      encryption: sqs.QueueEncryption.KMS_MANAGED,
    });

    // ==========================================
    // 7. COMPUTE: ZERO-COLD-START INGESTION LAMBDA
    // ==========================================
    const ingestionLambda = new nodejs.NodejsFunction(this, 'IngestionFunction', {
      entry: path.join(__dirname, '../lambda/ingestion/index.ts'),
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'handler',
      vpc,
      vpcSubnets: {
        subnetGroupName: 'IsolatedCompute',
      },
      securityGroups: [lambdaSecurityGroup],
      timeout: Duration.seconds(120),
      memorySize: 512,
      logRetention: logs.RetentionDays.TWO_WEEKS, // Cost Optimization: 14 days retention
      deadLetterQueue: dlq, // Configure SQS DLQ
      environment: {
        DB_HOST: cluster.clusterEndpoint.hostname,
        DB_PORT: cluster.clusterEndpoint.port.toString(),
        DB_NAME: 'postgres',
        DB_USER: dbUser,
      },
    });

    // Publish Version & Alias to configure Provisioned Concurrency
    const version = ingestionLambda.currentVersion;
    const alias = new lambda.Alias(this, 'ProdAlias', {
      aliasName: 'prod',
      version: version,
      provisionedConcurrentExecutions: 1, // Eliminates cold start
    });

    // Ensure database setup runs before S3 notifications can invoke the handler
    alias.node.addDependency(dbInitResource);

    // Add S3 Event Notification target to the Prod Alias ARN
    bucket.addObjectCreatedNotification(new s3n.LambdaDestination(alias));

    // ==========================================
    // 8. STRICT LEAST-PRIVILEGE IAM POLICIES
    // ==========================================
    // A. Allow Lambda to read files from S3 Ingestion Bucket
    bucket.grantRead(ingestionLambda);

    // B. Allow Lambda to decrypt S3 files using KMS Customer Managed Key
    kmsKey.grantDecrypt(ingestionLambda);

    // C. Allow Lambda to connect to RDS using IAM database token
    ingestionLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['rds-db:connect'],
        resources: [
          `arn:${Stack.of(this).partition}:rds-db:${this.region}:${this.account}:dbuser:${cluster.clusterResourceIdentifier}/${dbUser}`,
        ],
      })
    );

    // D. Allow Lambda to call Bedrock Titan Embeddings model only
    ingestionLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:${Stack.of(this).partition}:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v1`,
        ],
      })
    );

    // ==========================================
    // 9. MONITORING: CLOUDWATCH DASHBOARD
    // ==========================================
    const dashboard = new cloudwatch.Dashboard(this, 'ServerlessRagDashboard', {
      dashboardName: 'ServerlessRagDashboard',
    });

    // Lambda metrics
    const lambdaInvocations = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Invocations',
      dimensionsMap: { FunctionName: ingestionLambda.functionName },
      statistic: 'Sum',
      period: Duration.minutes(5),
    });

    const lambdaErrors = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Errors',
      dimensionsMap: { FunctionName: ingestionLambda.functionName },
      statistic: 'Sum',
      period: Duration.minutes(5),
    });

    const lambdaDuration = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Duration',
      dimensionsMap: { FunctionName: ingestionLambda.functionName },
      statistic: 'Average',
      period: Duration.minutes(5),
    });

    // SQS DLQ visibility depth
    const dlqDepth = new cloudwatch.Metric({
      namespace: 'AWS/SQS',
      metricName: 'ApproximateNumberOfMessagesVisible',
      dimensionsMap: { QueueName: dlq.queueName },
      statistic: 'Maximum',
      period: Duration.minutes(5),
    });

    // Bedrock metrics
    const bedrockThrottles = new cloudwatch.Metric({
      namespace: 'AWS/Bedrock',
      metricName: 'InvocationThrottles',
      dimensionsMap: { ModelId: 'amazon.titan-embed-text-v1' },
      statistic: 'Sum',
      period: Duration.minutes(5),
    });

    const bedrockLatency = new cloudwatch.Metric({
      namespace: 'AWS/Bedrock',
      metricName: 'InvocationLatency',
      dimensionsMap: { ModelId: 'amazon.titan-embed-text-v1' },
      statistic: 'Average',
      period: Duration.minutes(5),
    });

    // Add widgets to Dashboard
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Invocations & Errors',
        left: [lambdaInvocations],
        right: [lambdaErrors],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Ingestion Duration (ms)',
        left: [lambdaDuration],
        width: 12,
      })
    );

    dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'SQS Ingestion DLQ Queue Depth',
        metrics: [dlqDepth],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Bedrock Titan Embeddings Performance',
        left: [bedrockLatency],
        right: [bedrockThrottles],
        width: 16,
      })
    );

    // ==========================================
    // 10. COST CONTROL: AWS BUDGET
    // ==========================================
    const notificationEmail = props?.budgetNotificationEmail ?? process.env.BUDGET_NOTIFICATION_EMAIL;
    if (!notificationEmail) {
      throw new Error(
        'Set BUDGET_NOTIFICATION_EMAIL environment variable or pass budgetNotificationEmail in stack props.'
      );
    }
    
    new budgets.CfnBudget(this, 'ServerlessRagBudget', {
      budget: {
        budgetName: 'ServerlessRagBudgetLimit',
        budgetType: 'COST',
        budgetLimit: {
          amount: 50, // $50 monthly budget constraint
          unit: 'USD',
        },
        timeUnit: 'MONTHLY',
      },
      notificationsWithSubscribers: [
        {
          notification: {
            comparisonOperator: 'GREATER_THAN',
            notificationType: 'FORECASTED',
            threshold: 100, // Alert at 100% of forecast ($50)
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            {
              address: notificationEmail,
              subscriptionType: 'EMAIL',
            },
          ],
        },
      ],
    });
  }
}

import { CloudFormationCustomResourceEvent, CloudFormationCustomResourceResponse } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Client } from 'pg';

const secretsManager = new SecretsManagerClient({});

export const handler = async (
  event: CloudFormationCustomResourceEvent
): Promise<CloudFormationCustomResourceResponse> => {
  console.log('Received custom resource event:', JSON.stringify(event, null, 2));

  const requestType = event.RequestType;
  const physicalResourceId = event.PhysicalResourceId || 'DbInitResource';

  if (requestType === 'Delete') {
    console.log('Delete request received. Skipping database initialization cleanup to prevent data loss.');
    return {
      PhysicalResourceId: physicalResourceId,
      Status: 'SUCCESS',
      RequestId: event.RequestId,
      StackId: event.StackId,
      LogicalResourceId: event.LogicalResourceId,
    };
  }

  const secretArn = process.env.DB_SECRET_ARN;
  const dbUser = process.env.DB_USER || 'db_user';
  
  if (!secretArn) {
    throw new Error('Missing environment variable DB_SECRET_ARN');
  }

  console.log(`Retrieving database credentials from secret: ${secretArn}`);
  const secretResponse = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );

  if (!secretResponse.SecretString) {
    throw new Error('SecretString is empty in the secret');
  }

  const credentials = JSON.parse(secretResponse.SecretString);
  const { host, port, dbname, username, password } = credentials;

  console.log(`Connecting to database ${dbname} on host ${host}:${port} as user ${username}...`);
  
  const client = new Client({
    host,
    port: parseInt(port || '5432', 10),
    database: dbname,
    user: username,
    password: password,
    ssl: {
      rejectUnauthorized: false // Required for RDS SSL connection
    }
  });

  try {
    await client.connect();
    console.log('Database connected successfully.');

    // 1. Create pgvector extension
    console.log('Creating vector extension if not exists...');
    await client.query('CREATE EXTENSION IF NOT EXISTS vector;');

    // 2. Create the document embeddings table
    console.log('Creating document_embeddings table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS document_embeddings (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          document_key VARCHAR(1024) NOT NULL,
          chunk_index INT NOT NULL,
          chunk_text TEXT NOT NULL,
          embedding VECTOR(1536), -- 1536 dimension for Titan Embeddings
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. Create HNSW index
    console.log('Creating HNSW vector index...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS document_embeddings_vector_idx 
      ON document_embeddings USING hnsw (embedding vector_cosine_ops);
    `);

    // 4. Provision IAM Database Authentication user
    console.log(`Creating database user ${dbUser} for IAM authentication...`);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${dbUser}') THEN
          CREATE USER ${dbUser} WITH LOGIN;
        END IF;
      END
      $$;
    `);

    console.log(`Granting rds_iam role and privileges to ${dbUser}...`);
    await client.query(`GRANT rds_iam TO ${dbUser};`);
    await client.query(`GRANT ALL PRIVILEGES ON TABLE document_embeddings TO ${dbUser};`);
    await client.query(`GRANT ALL PRIVILEGES ON SCHEMA public TO ${dbUser};`);

    console.log('Database initialization completed successfully.');

    return {
      PhysicalResourceId: physicalResourceId,
      Status: 'SUCCESS',
      RequestId: event.RequestId,
      StackId: event.StackId,
      LogicalResourceId: event.LogicalResourceId,
    };
  } catch (error: any) {
    console.error('Error during database initialization:', error);
    throw error;
  } finally {
    try {
      await client.end();
      console.log('Database connection closed.');
    } catch (closeError) {
      console.error('Error closing database connection:', closeError);
    }
  }
};

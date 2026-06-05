import { S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { Signer } from '@aws-sdk/rds-signer';
import { Client } from 'pg';

// Initialize AWS Clients
const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({});

// Retrieve configuration from Environment Variables
const DB_HOST = process.env.DB_HOST;
const DB_PORT = parseInt(process.env.DB_PORT || '5432', 10);
const DB_NAME = process.env.DB_NAME || 'postgres';
const DB_USER = process.env.DB_USER || 'db_user';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v1';

/**
 * Splits text into overlapping chunks.
 */
function chunkDocument(text: string, chunkSize = 1000, overlap = 200): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let startIndex = 0;

  while (startIndex < text.length) {
    let endIndex = startIndex + chunkSize;
    
    // Adjust chunk boundary to land on a space if possible to avoid cutting words
    if (endIndex < text.length) {
      const nextSpace = text.lastIndexOf(' ', endIndex);
      if (nextSpace > startIndex) {
        endIndex = nextSpace;
      }
    }
    
    const chunk = text.substring(startIndex, endIndex).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    
    startIndex = endIndex - overlap;
    if (startIndex >= text.length || overlap >= chunkSize) {
      break;
    }
  }
  
  return chunks;
}

/**
 * Calls Amazon Bedrock to generate a 1536-dimension embedding vector for the given text.
 */
async function getEmbedding(text: string): Promise<number[]> {
  const payload = {
    inputText: text,
  };

  const command = new InvokeModelCommand({
    modelId: EMBEDDING_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload),
  });

  const response = await bedrock.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  
  if (!responseBody.embedding) {
    throw new Error(`Invalid response from Bedrock: ${JSON.stringify(responseBody)}`);
  }
  
  return responseBody.embedding;
}

/**
 * Main Lambda Ingestion Handler
 */
export const handler = async (event: S3Event): Promise<void> => {
  console.log('Received S3 Event:', JSON.stringify(event, null, 2));

  if (!DB_HOST) {
    throw new Error('Database host environment variable (DB_HOST) is not set');
  }

  // 1. Generate IAM Auth Token for RDS Database Connection
  console.log(`Generating RDS Signer IAM Token for user: ${DB_USER} on host: ${DB_HOST}:${DB_PORT}`);
  const signer = new Signer({
    hostname: DB_HOST,
    port: DB_PORT,
    username: DB_USER,
    region: AWS_REGION,
  });

  const dbPasswordToken = await signer.getAuthToken();
  console.log('RDS Signer token generated successfully.');

  // 2. Initialize Postgres client using IAM token as password
  const client = new Client({
    host: DB_HOST,
    port: DB_PORT,
    database: DB_NAME,
    user: DB_USER,
    password: dbPasswordToken,
    ssl: {
      rejectUnauthorized: false, // Required for secure communication with RDS
    },
  });

  try {
    await client.connect();
    console.log('Successfully connected to Aurora Serverless PostgreSQL.');

    for (const record of event.Records) {
      const bucket = record.s3.bucket.name;
      const rawKey = record.s3.object.key;
      const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      console.log(`Processing file: s3://${bucket}/${key}`);

      // 3. Fetch object from S3
      const getObjectCommand = new GetObjectCommand({ Bucket: bucket, Key: key });
      const s3Response = await s3.send(getObjectCommand);
      const documentText = await s3Response.Body?.transformToString('utf-8');

      if (!documentText) {
        console.warn(`File is empty or could not be read: s3://${bucket}/${key}`);
        continue;
      }

      // 4. Chunk document content
      const chunks = chunkDocument(documentText);
      console.log(`Split document into ${chunks.length} chunks.`);

      // 5. Generate embeddings and save to database
      for (let i = 0; i < chunks.length; i++) {
        const chunkText = chunks[i];
        console.log(`Processing chunk ${i + 1}/${chunks.length} (length: ${chunkText.length})...`);

        // Compute vector embeddings using Bedrock (Titan model)
        const embedding = await getEmbedding(chunkText);
        
        // Convert number array to pgvector insert string format: "[val1,val2,...]"
        const vectorString = `[${embedding.join(',')}]`;

        // Insert document chunk, metadata, and embedding vector into the database
        await client.query(
          `INSERT INTO document_embeddings (document_key, chunk_index, chunk_text, embedding)
           VALUES ($1, $2, $3, $4::vector)`,
          [key, i, chunkText, vectorString]
        );
      }
      
      console.log(`Successfully completed ingestion for s3://${bucket}/${key}`);
    }
  } catch (error) {
    console.error('Fatal error occurred during document ingestion:', error);
    throw error; // Re-throw error to trigger SQS DLQ
  } finally {
    try {
      await client.end();
      console.log('Database connection pool closed.');
    } catch (closeError) {
      console.error('Error closing database connection:', closeError);
    }
  }
};

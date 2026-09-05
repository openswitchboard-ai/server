import { KMSClient } from '@aws-sdk/client-kms';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { SESv2Client } from '@aws-sdk/client-sesv2';

const region = process.env.AWS_REGION ?? 'us-east-1';

export const kms = new KMSClient({ region });
export const s3 = new S3Client({ region });
export const sqs = new SQSClient({ region });
export const secretsManager = new SecretsManagerClient({ region });
export const bedrock = new BedrockRuntimeClient({ region });
// SES may live in another region than the rest of the stack (prod sends via
// the host identity in ap-southeast-2; see config.sesRegion).
export const sesv2 = new SESv2Client({ region: process.env.SES_REGION ?? region });

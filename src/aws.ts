import { KMSClient } from '@aws-sdk/client-kms';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';

const region = process.env.AWS_REGION ?? 'us-east-1';

export const kms = new KMSClient({ region });
export const s3 = new S3Client({ region });
export const sqs = new SQSClient({ region });
export const secretsManager = new SecretsManagerClient({ region });
export const bedrock = new BedrockRuntimeClient({ region });
// Prod sends from the host account (infra/host-ses): the client assumes a
// role there, in that region, because SES applies the sandbox to whichever
// account makes the call. Dev: own account, own region, no role.
const sesRegion = process.env.SES_REGION ?? region;
const sesRole = process.env.SES_ASSUME_ROLE_ARN;
export const sesv2 = new SESv2Client({
  region: sesRegion,
  ...(sesRole
    ? {
        credentials: fromTemporaryCredentials({
          params: { RoleArn: sesRole, RoleSessionName: 'osb-email', DurationSeconds: 3600 },
          clientConfig: { region: sesRegion },
        }),
      }
    : {}),
});

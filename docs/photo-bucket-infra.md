# The photo bucket — the infra change, NOT APPLIED and NOT DEPLOYED

The infra CDK lives in its own repository (`../infra`), so this change cannot
ride in the server's commit and is written out here instead. It is hand-applied:
the blocks below are the exact code, and each one says where it goes. It has
never been synthesised and never been deployed.

    cd ../infra
    # add the four blocks below
    npx cdk diff   OsbFoundation-dev OsbCore-dev   # read it before anything else
    npx cdk deploy OsbFoundation-dev               # the bucket and its key first
    npx cdk deploy OsbCore-dev                     # then PHOTO_BUCKET and the grants

Until BOTH stacks are deployed the server runs exactly as it does today: with no
`PHOTO_BUCKET` in the environment photos are off, `respond(request_photo)`
answers with a sentence saying so, and nothing else changes.

WHAT THE BUCKET IS, and how it differs from the two that exist. The consent log
and the evidence vault are WORM: versioned, Object-Locked, kept for years. This
one is their opposite by design, because the promise on a conversation is that
nothing is kept — no versions (a version is a copy of the thing just deleted),
no Object Lock (a lock would make deletion impossible, which is the one thing
this bucket must do), and a lifecycle rule that expires anything left at 15 days
as the backstop under the server's own 14-day sweep. It is encrypted with a KMS
key of its own, so a photo is never readable with the key that reads anything
else.

CORS is PUT and GET from the human origin only: the sending human's browser PUTs
the bytes, and a collecting agent's GET rides a presigned link as a plain fetch.

## 1. `lib/foundation-stack.ts` — after `const consentKey = makeKey('Consent');`

```ts
// 1.J photos on a conversation: a key of its own, so the bytes of a photo are
// never readable with the key that reads consent, identity or evidence.
const photoKey = makeKey('Photo');
```

## 2. `lib/foundation-stack.ts` — after the evidence bucket, before the Secrets Manager skeleton

```ts
// ------------------------------------------------------------------
// Conversation photos: the anti-WORM bucket.
//
// Everything else stored here is kept on purpose. This is the one store whose
// whole job is to stop holding things: a photo crosses inside an open
// conversation, the other side collects it once, and the server deletes the
// object (server src/domain/channelPhoto.ts). So there are no versions and no
// Object Lock — a version would be a copy of the thing just deleted, and a
// lock would make the deletion impossible.
//
// The lifecycle rule is the backstop under the server's own sweep, which
// deletes an uncollected photo at 14 days: if the sweep never ran at all, S3
// still clears the bucket at 15. Incomplete multipart uploads go at 1 day,
// because a browser that dies mid-upload should cost nothing.
// ------------------------------------------------------------------
const photoBucket = new s3.Bucket(this, 'ConversationPhotoBucket', {
  bucketName: `osb-${envName}-conversation-photos-${this.account}`,
  versioned: false,
  encryption: s3.BucketEncryption.KMS,
  encryptionKey: photoKey,
  bucketKeyEnabled: true,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  enforceSSL: true,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
  lifecycleRules: [
    {
      id: 'expire-15d',
      expiration: cdk.Duration.days(15),
      abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
    },
  ],
  // The sending human's own browser PUTs the bytes straight here on a
  // presigned link, and the collecting agent's GET is a presigned link too.
  // Same origin list as the evidence vault: the human host only.
  cors: [
    {
      allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
      allowedOrigins: [
        envName === 'prod'
          ? 'https://my.openswitchboard.ai'
          : 'https://my-dev.openswitchboard.ai',
      ],
      allowedHeaders: ['content-type', 'x-amz-checksum-sha256'],
      maxAge: 600,
    },
  ],
});
```

And beside the other `publish(...)` lines at the bottom of the same file:

```ts
publish('kms/photo-key-arn', photoKey.keyArn, 'photo-key-arn');
publish('s3/conversation-photo-bucket', photoBucket.bucketName, 'conversation-photo-bucket');
```

## 3. `lib/core-stack.ts` — after the `evidenceBucket` import (`s3.Bucket.fromBucketName`)

```ts
// 1.J photos on a conversation: held only until the other side collects them,
// so this is the one store with no Object Lock and no versions (see the
// foundation stack).
const photoKey = kms.Key.fromLookup(this, 'PhotoKey', {
  aliasName: `alias/osb/${envName}/photo`,
});
const photoBucket = s3.Bucket.fromBucketName(
  this,
  'ConversationPhotoBucket',
  `osb-${envName}-conversation-photos-${this.account}`,
);
```

In the task definition's `environment` block, beside `EVIDENCE_BUCKET`:

```ts
// Photos cross inside an open conversation and nowhere else. Unset means the
// feature is off and the server says so; setting it is the whole of switching
// it on.
PHOTO_BUCKET: photoBucket.bucketName,
```

## 4. `lib/core-stack.ts` — beside the evidence grants on the task role

```ts
// 1.J photos: the server signs the browser's PUT and the collecting agent's
// GET, and DELETES on collection and on expiry — the delete is the grant the
// other two buckets deliberately do not have. Its own prefix only. Decrypt is
// needed because a presigned GET against an SSE-KMS object is decrypted with
// the signer's own permissions.
photoBucket.grantPut(taskDef.taskRole, 'conversation-photos/*');
photoBucket.grantRead(taskDef.taskRole, 'conversation-photos/*');
photoBucket.grantDelete(taskDef.taskRole, 'conversation-photos/*');
photoKey.grant(taskDef.taskRole, 'kms:GenerateDataKey', 'kms:Decrypt');
```

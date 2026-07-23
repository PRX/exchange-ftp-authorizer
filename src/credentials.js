import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { ConfiguredRetryStrategy } from "@smithy/util-retry";
import { decrypt } from "./crypto.js";
import { msg } from "./util.js";

const ENV = process.env;

const retryStrategy = new ConfiguredRetryStrategy(
  6, // Max attempts
  (attempt) => 100 + attempt * 500,
);

const requestHandler = new NodeHttpHandler({
  connectionTimeout: 1000,
  requestTimeout: 2000,
  socketTimeout: 500,
});

const ssm = new SSMClient({ retryStrategy, requestHandler });
const s3 = new S3Client({});

/** @returns {Promise<string>} */
async function loadSecret() {
  msg("Fetching secret (should only occur during cold start).");

  const resp = await ssm.send(
    new GetParameterCommand({
      Name: ENV.ENCRYPTION_SECRET_PARAMETER_ARN,
      WithDecryption: true,
    }),
  );

  return resp.Parameter?.Value;
}

/** @returns {Promise<object>} */
async function loadCredentialData() {
  msg("Fetching credential data (should only occur during cold start).");
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: ENV.MEDIAJOINT_S3_BUCKET_ARN.split(":")[5],
      Key: "ftp_authorizer/enc_cred.json",
    }),
  );

  const body = await response.Body.transformToString();
  return JSON.parse(body);
}

const secretPromise = loadSecret();
const credentialDataPromise = loadCredentialData();

/**
 * @param {string} username
 * @param {string} assertedPassword
 * @returns {Promise<boolean>}
 */
export default async function authorize(username, assertedPassword) {
  const secret = await secretPromise;

  if (!secret) {
    throw new Error("Encryption secret paramter is missing!");
  }

  const credentialData = await credentialDataPromise;

  if (!credentialData) {
    throw new Error("Credential data is missing!");
  }

  if (!username || !assertedPassword) {
    return false;
  }

  const encryptedPassword = credentialData[username];
  if (encryptedPassword) {
    msg(`Found encrypted password for ${username}`);
    const decryptedPassword = decrypt(encryptedPassword, secret);

    if (decryptedPassword === assertedPassword) {
      return true;
    }
  }

  return false;
}

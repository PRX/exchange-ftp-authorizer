import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { Upload } from "@aws-sdk/lib-storage";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { ConfiguredRetryStrategy } from "@smithy/util-retry";
import { createConnection } from "mysql2/promise";

const ENV = process.env;

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

const retryStrategy = new ConfiguredRetryStrategy(
  6, // Max attempts
  (attempt) => 100 + attempt * 500,
);

const requestHandler = new NodeHttpHandler({
  connectionTimeout: 1000,
  requestTimeout: 2000,
  socketTimeout: 500,
});

const ssm = new SSMClient({
  apiVersion: "2014-11-06",
  retryStrategy,
  requestHandler,
});

const s3 = new S3Client({
  apiVersion: "2006-03-01",
});

function deriveKey(secret) {
  return createHash("sha256").update(secret).digest();
}

function encrypt(text, secret) {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack iv + authTag + ciphertext together
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

function decrypt(encoded, secret) {
  const key = deriveKey(secret);
  const data = Buffer.from(encoded, "base64");

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = data.subarray(IV_LENGTH + 16);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

async function initializeParams() {
  console.log("Initializing SSM params");

  return ssm.send(
    new GetParametersCommand({
      Names: [
        ENV.DB_NAME_PARAMETER_ARN.split(":parameter")[1],
        ENV.DB_USERNAME_PARAMETER_ARN.split(":parameter")[1],
        ENV.DB_PASSWORD_PARAMETER_ARN.split(":parameter")[1],
        ENV.ENCRYPTION_SECRET_PARAMETER_ARN.split(":parameter")[1],
      ],
      WithDecryption: true,
    }),
  );
}

const getParams = await initializeParams();

/**
 * @param {any} _event
 */
export const handler = async (_event) => {
  const params = getParams;

  const dbConnectionParams = {
    host: ENV.MYSQL_ENDPOINT,
    database: params.Parameters.find((p) => p.ARN === ENV.DB_NAME_PARAMETER_ARN)
      .Value,
    user: params.Parameters.find((p) => p.ARN === ENV.DB_USERNAME_PARAMETER_ARN)
      .Value,
    password: params.Parameters.find(
      (p) => p.ARN === ENV.DB_PASSWORD_PARAMETER_ARN,
    ).Value,
  };

  console.log("Creating MySQL connection");
  const connection = await createConnection(dbConnectionParams);
  console.log("Done creating MySQL connection");

  console.log("Running MySQL query");
  const [rows] = await connection.execute(
    "SELECT delivery_ftp_user, delivery_ftp_password FROM `accounts` WHERE type = 'StationAccount' AND status = 'open' AND deleted_at is NULL",
  );
  console.log("Done running MySQL query");
  connection.end();

  const secret = params.Parameters.find(
    (p) => p.ARN === ENV.ENCRYPTION_SECRET_PARAMETER_ARN,
  ).Value;

  if (Array.isArray(rows) && rows.length) {
    const map = {};

    for (const row of rows) {
      map[row["delivery_ftp_user"]] = encrypt(
        row["delivery_ftp_password"],
        secret,
      );
    }

    const upload = new Upload({
      client: s3,
      params: {
        Bucket: ENV.MEDIAJOINT_S3_BUCKET_ARN.split(":")[5],
        Key: "ftp_authorizer/enc_cred.json",
        Body: JSON.stringify(map),
      },
    });
    await upload.done();
  }
};

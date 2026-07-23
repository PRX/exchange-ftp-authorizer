/** @import { Parameter } from "@aws-sdk/client-ssm" */

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { ConfiguredRetryStrategy } from "@smithy/util-retry";
import { createConnection } from "mysql2/promise";
import { encrypt } from "./crypto.js";
import { msg, paramValue } from "./util.js";

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

/** @returns {Promise<Parameter[]>} */
async function loadSsmParams() {
  msg("Fetching parameters (should only occur during cold start).");
  const data = await ssm.send(
    new GetParametersCommand({
      Names: [
        ENV.DB_NAME_PARAMETER_ARN,
        ENV.DB_USERNAME_PARAMETER_ARN,
        ENV.DB_PASSWORD_PARAMETER_ARN,
        ENV.ENCRYPTION_SECRET_PARAMETER_ARN,
      ],
      WithDecryption: true,
    }),
  );

  return data.Parameters;
}

const paramsPromise = loadSsmParams();

/** @returns {Promise<void>} */
export const handler = async () => {
  const params = await paramsPromise;

  if (!params) {
    throw new Error("SSM parameters are missing!");
  }

  const sql = [
    "SELECT delivery_ftp_user, delivery_ftp_password",
    "FROM `accounts`",
    "WHERE type = 'StationAccount' AND status = 'open' AND deleted_at is NULL",
  ].join(" ");

  const connection = await createConnection({
    host: ENV.MYSQL_ENDPOINT,
    database: paramValue(params, ENV.DB_NAME_PARAMETER_ARN),
    user: paramValue(params, ENV.DB_USERNAME_PARAMETER_ARN),
    password: paramValue(params, ENV.DB_PASSWORD_PARAMETER_ARN),
  });
  const [rows] = await connection.execute(sql);
  connection.end();

  const secret = paramValue(params, ENV.ENCRYPTION_SECRET_PARAMETER_ARN);

  if (Array.isArray(rows) && rows.length) {
    const map = {};

    for (const row of rows) {
      // @ts-expect-error
      const { delivery_ftp_user, delivery_ftp_password } = row;

      if (delivery_ftp_password) {
        map[delivery_ftp_user] = encrypt(delivery_ftp_password, secret);
      }
    }

    await s3.send(
      new PutObjectCommand({
        Bucket: ENV.MEDIAJOINT_S3_BUCKET_ARN.split(":")[5],
        Key: "ftp_authorizer/enc_cred.json",
        Body: JSON.stringify(map),
      }),
    );
    msg(`Successfully sent ${rows.length} station credentials to S3.`);
  }
};

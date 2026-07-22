import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { ConfiguredRetryStrategy } from "@smithy/util-retry";
import { createConnection } from "mysql2/promise";

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

const ENV = process.env;

async function initializeParams() {
  console.log("Initializing SSM params");

  return ssm.send(
    new GetParametersCommand({
      Names: [
        ENV.DB_NAME_PARAMETER_ARN.split(":parameter")[1],
        ENV.DB_USERNAME_PARAMETER_ARN.split(":parameter")[1],
        ENV.DB_PASSWORD_PARAMETER_ARN.split(":parameter")[1],
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

  if (Array.isArray(rows) && rows.length) {
    return true;
  }
};

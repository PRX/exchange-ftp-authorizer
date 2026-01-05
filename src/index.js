import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { ConfiguredRetryStrategy } from "@smithy/util-retry";
import checkCredentials from "./credentials.js";
import checkRateLimit from "./rate_limit.js";
import transferAuth from "./transfer_auth.js";

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

const eventbridge = new EventBridgeClient();

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

export const handler = async (event) => {
  console.log("Getting SSM parameters");
  const params = getParams;
  console.log("Done getting SSM parameters");

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

  if (event.password?.length) {
    // Password-based authentication for FTP and SFTP

    const isAuthed = await checkCredentials(
      dbConnectionParams,
      event.username,
      event.password,
    );

    if (isAuthed) {
      const isRateLimited = await checkRateLimit(event.username);

      if (isRateLimited && !["kuaf"].includes(event.username)) {
        await eventbridge.send(
          new PutEventsCommand({
            Entries: [
              {
                Source: "org.prx.spire.exchange-ftp-authorizer",
                DetailType: "Slack Message Relay Message Payload",
                Detail: JSON.stringify({
                  channel: "C09QPRSMMU5",
                  username: "FTP Rate Limiting",
                  icon_emoji: ":abacus:",
                  text: `❌ *${event.username}* has been rate limited; a connection attempt was denied. (${process.env.AWS_REGION})`,
                }),
              },
            ],
          }),
        );

        console.log(`${event.username}: Password OK, rate limit DENIED`);
        return {}; // Returning an empty object here prevents the login
      }

      console.log(`${event.username}: Password OK, rate limit OK`);
      return transferAuth(event.username, process.env.S3_BUCKET_ARN);
    } else {
      console.log(`${event.username}: Password DENIED`);
      return {};
    }
    // } else if (event.protocol === 'SFTP') {
    // Key-based authentication for SFTP
  } else {
    // Invalid authentication; do not return any policy
    console.log(`${event.username}: Authentication method INVALID`);
    return {};
  }
};

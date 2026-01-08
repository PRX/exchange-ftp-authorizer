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

// List of stations where Slack messages should not be sampled at 100%.
// `wxyz: 50` means to sample at (1 / 50) for WXYZ.
const SAMPLE_RATES = { kuaf: 50, kuat: 20 };

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

function rand(min, max) {
  const minCeiled = Math.ceil(min);
  return Math.floor(
    Math.random() * (Math.floor(max) - minCeiled + 1) + minCeiled,
  );
}

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

      if (isRateLimited) {
        // Is this one of the stations that we sample at less than 100%?
        const isSampled = Object.keys(SAMPLE_RATES).includes(event.username);
        // If it is, use the defined rate, otherwise default to 1
        const sample_rate = isSampled ? SAMPLE_RATES[event.username] : 1;

        // With the default of 1, for most stations this will send a message
        // with a 100% sample rate (i.e., every rate limiting event). For
        // stations with a sample rate override, it should only message at a
        // rate of about 1/the_override_rate.
        if (rand(1, sample_rate) === 1) {
          const username = `FTP Rate Limiting${isSampled ? ` (Sampled at 1 per ${sample_rate})` : ""}`;

          await eventbridge.send(
            new PutEventsCommand({
              Entries: [
                {
                  Source: "org.prx.spire.exchange-ftp-authorizer",
                  DetailType: "Slack Message Relay Message Payload",
                  Detail: JSON.stringify({
                    channel: "C09QPRSMMU5",
                    username,
                    icon_emoji: ":abacus:",
                    text: `❌ *${event.username}* has been rate limited; a connection attempt was denied. (${process.env.AWS_REGION})`,
                  }),
                },
              ],
            }),
          );
          console.log(
            `${event.username}: Password OK, rate limit DENIED, event sampled`,
          );
        } else {
          console.log(
            `${event.username}: Password OK, rate limit DENIED, event NOT sampled`,
          );
        }

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

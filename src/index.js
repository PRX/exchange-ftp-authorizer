/** @import { TransferFamilyAuthorizerEvent, TransferFamilyAuthorizerResult } from "aws-lambda" */

import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import checkCredentials from "./credentials.js";
import checkRateLimit from "./rate_limit.js";
import transferAuth from "./transfer_auth.js";
import { msg, rand, redact } from "./util.js";

// List of stations where Slack messages should not be sampled at 100%.
// `wxyz: 50` means to sample at (1 / 50) for WXYZ.
const SAMPLE_RATES = { kuaf: 50, kuat: 20, redriver: 15 };
const SILENCED = ["redriver", "will"];

const eventbridge = new EventBridgeClient();

/**
 * @param {TransferFamilyAuthorizerEvent} event
 * @returns {Promise<TransferFamilyAuthorizerResult>}
 */
export const handler = async (event) => {
  redact(event);

  if (event.password?.length) {
    // Password-based authentication for FTP and SFTP

    const isAuthed = await checkCredentials(event.username, event.password);

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
        //
        // Some stations we silence entirely.
        if (rand(1, sample_rate) === 1 && !SILENCED.includes(event.username)) {
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
          msg(
            `${event.username}: Password OK, rate limit DENIED, event sampled`,
          );
        } else {
          msg(
            `${event.username}: Password OK, rate limit DENIED, event NOT sampled`,
          );
        }

        return {}; // Returning an empty object here prevents the login
      }

      msg(`${event.username}: Password OK, rate limit OK`);
      return transferAuth(event.username, process.env.S3_BUCKET_ARN);
    } else {
      msg(`${event.username}: Password DENIED`);
      return {};
    }
    // } else if (event.protocol === 'SFTP') {
    // Key-based authentication for SFTP
  } else {
    // Invalid authentication; do not return any policy
    msg(`${event.username}: Authentication method INVALID`);
    return {};
  }
};

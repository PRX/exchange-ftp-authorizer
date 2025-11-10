import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { ConfiguredRetryStrategy } from "@smithy/util-retry";

const retryStrategy = new ConfiguredRetryStrategy(
  6, // Max attempts
  (attempt) => 100 + attempt * 500,
);

const requestHandler = new NodeHttpHandler({
  connectionTimeout: 1000,
  requestTimeout: 2000,
  socketTimeout: 500,
});

const REGIONS = ["us-east-1", "us-west-2"];

// Used for both fetching CloudWatch Metrics data points, and bucket refill frequency
const PERIOD = 3600;
// How far back to fetch CloudWatch Metrics data
const NUM_PERIODS = 24 * 7;
// Bytes accrued per metric period.
const REFILL_RATE_BYTES = 150_000_000 * 3; // 120 MB is about 1 hour of broadcast MP2 audio
// Maximum allowance
const BUCKET_MAX_BYTES = 10_000_000_000; // 10 GB
// When we check if the user has any bytes left, we can only chose to let them
// login or not; we can't actually cut them off at a certain point. Meaning
// even if they have 1 byte remaining, they could log in an download 1 GB of
// data. Instead, we check to see if they have FUDGE_BYTES left, as a
// reasonable approximation of what they may download once they connect.
const FUDGE_BYTES = 150_000_000 * 3;

function metricQueryInput(username, startTime, endTime) {
  return {
    MetricDataQueries: [
      {
        Id: "hourlyTotals",
        MetricStat: {
          Metric: {
            Namespace: "PRX/Transfer",
            MetricName: "BytesOut",
            Dimensions: [
              {
                Name: "Environment",
                Value: process.env.APP_ENVIRONMENT,
              },
              {
                Name: "Station",
                Value: username,
              },
            ],
          },
          Period: PERIOD,
          Stat: "Sum",
          Unit: "Bytes",
        },
      },
    ],
    StartTime: startTime,
    EndTime: endTime,
  };
}

export default async function checkUsage(username) {
  const startTime = new Date(Date.now() - 1000 * NUM_PERIODS * PERIOD);
  const endTime = new Date(Date.now());

  const getMetricDataInput = metricQueryInput(username, startTime, endTime);

  // Everyone starts with a bucket that is full at `startTime`. We will replay
  // the usage and refill for each period to determine how many tokens are
  // remaining at `endTime`.
  let remaingTokens = BUCKET_MAX_BYTES;

  // Check usage in all regions; some stations end up making connections to
  // both, and we want to consider their total usage.
  for (const region of REGIONS) {
    const cloudwatch = new CloudWatchClient({
      region: region,
      retryStrategy,
      requestHandler,
    });

    const metricData = await cloudwatch.send(
      // @ts-ignore
      new GetMetricDataCommand(getMetricDataInput),
    );
    // results will look like:
    // { Timestamps: [2025/01/01 05 AM, 2025/01/01 10 AM, 2025/01/01 11 AM], Values: [0, 5, 0] }
    const results = metricData.MetricDataResults?.[0];

    // Convert the results in a hash like:
    // [{ timestamp: 2025/01/01 05 AM, value: 0 }, { timestamp: 2025/01/01 10 AM, value: 5 }]
    const dataPoints = results.Timestamps.map((timestamp, i) => ({
      timestamp: new Date(timestamp),
      value: results.Values[i],
    })).sort((a, b) => a.timestamp.valueOf() - b.timestamp.valueOf());

    // Create an array of dates for all the periods that exist between
    // startTime and endTime
    const allApproximateTimestamps = [];
    for (
      let t = new Date(startTime);
      t < endTime;
      t = new Date(t.getTime() + PERIOD * 1000)
    ) {
      allApproximateTimestamps.push(new Date(t));
    }

    // Build another hash, where any periods that were missing from the results
    // are included with a value of 0.
    // We do this so that we refill for all periods in the range, not just
    // periods that had a data point in CloudWatch Metrics
    const filledDataPoints = allApproximateTimestamps.map((aprox) => {
      const match = dataPoints.find(
        (p) =>
          Math.abs(p.timestamp.valueOf() - aprox.valueOf()) <
          (PERIOD * 1000) / 2, // close enough within 1 period
      );
      return {
        timestamp: aprox,
        value: match ? match.value : 0,
      };
    });

    // For each period, refill and reduce for usage.
    const tokens = filledDataPoints.reduce((acc, dataPoint) => {
      const previousTokens = acc;

      // Refill, up to the max
      const afterRefill = Math.min(
        BUCKET_MAX_BYTES,
        previousTokens + REFILL_RATE_BYTES,
      );

      // Subtract usage for this period, with a min of 0
      return Math.max(0, afterRefill - dataPoint.value);
    }, remaingTokens);

    // Update the running total to reflect all regions
    remaingTokens = tokens;
  }

  // If the station has less than the fudge factor remaining, we consider them
  // to be over the limit and should be rate limited
  const isRateLimited = remaingTokens < FUDGE_BYTES;

  return isRateLimited;
}

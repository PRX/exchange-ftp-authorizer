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
// Bytes accrued per Metrics period.
const REFILL_RATE_BYTES = 150_000_000 * 3; // 120 MB is about 1 hour of broadcast MP2 audio
// Maximum allowance
const BUCKET_MAX_BYTES = 10_000_000_000; // 10 GB
// When we check if the user has any bytes left, we can only chose to let them
// login or not; we can't actually cut them off at a certain point. Meaning
// even if they have 1 byte remaining, they could log in and download 1 GB of
// data. So instead, we check to see if they have FUDGE_BYTES left, as a
// reasonable approximation of what they may download once they connect.
const FUDGE_BYTES = 150_000_000 * 3;

// Returns the query input to send to CloudWatch Metrics `GetMetricData`
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

  // @ts-expect-error
  const metricDataCmd = new GetMetricDataCommand(getMetricDataInput);

  // This will be an array of objects like:
  // [{ timestamp: 2025/01/01 05 AM, value: 0 }, { timestamp: 2025/01/01 10 AM, value: 5 }]
  // Some timestamps may appear more than once, if there was a corresponding
  // data point in multiple regions
  const dataPointsAllRegions = [];

  // Fetch usage in all regions; some stations end up making connections to
  // both, and we want to consider their total usage.
  for (const region of REGIONS) {
    const cloudwatch = new CloudWatchClient({
      region: region,
      retryStrategy,
      requestHandler,
    });

    const metricData = await cloudwatch.send(metricDataCmd);
    // results will look like:
    // { Timestamps: [2025/01/01 05 AM, 2025/01/01 10 AM, 2025/01/01 11 AM], Values: [0, 5, 0] }
    const results = metricData.MetricDataResults?.[0];

    // Zipper the timestamps and values in `results` to an an array of objects
    // like:
    // [{ timestamp: 2025/01/01 05 AM, value: 0 }, { timestamp: 2025/01/01 10 AM, value: 5 }]
    const dataPoints = results.Timestamps.map((timestamp, i) => ({
      timestamp: new Date(timestamp),
      value: results.Values[i],
    })).sort((a, b) => a.timestamp.valueOf() - b.timestamp.valueOf());
    dataPointsAllRegions.push(...dataPoints);
  }

  // Create an array of dates for all the periods that exist between
  // startTime and endTime
  const allPeriodTimestampsInRange = [];
  for (
    let t = new Date(startTime);
    t < endTime;
    t = new Date(t.getTime() + PERIOD * 1000)
  ) {
    allPeriodTimestampsInRange.push(new Date(t));
  }

  // Build another object, where any periods that were missing from the results
  // are included with a value of 0.
  // We do this so that we refill for *all* periods in the range, not just
  // periods that had a data point in CloudWatch Metrics, as to not shortchange
  // the user.
  const filledDataPoints = allPeriodTimestampsInRange.map((periodTs) => {
    const perTs = periodTs.valueOf();

    const value = dataPointsAllRegions
      // Find data points that are in this period, even if the time doesn't
      // match exactly
      .filter((dp) => {
        const dpTs = dp.timestamp.valueOf();

        return Math.abs(dpTs - perTs) < (PERIOD * 1000) / 2;
      })
      // Add up any points that were found, or use 0
      .reduce((prev, dp) => prev + dp.value, 0);

    return { timestamp: periodTs, value };
  });

  // Everyone starts with a bucket that is full at `startTime`. We will replay
  // the usage and refill for each period to determine how many tokens are
  // remaining at `endTime`.
  const remaingTokens = filledDataPoints.reduce((acc, dataPoint) => {
    const previousTokens = acc;

    // First, refill up to the max
    const afterRefill = Math.min(
      BUCKET_MAX_BYTES,
      previousTokens + REFILL_RATE_BYTES,
    );

    // Then, subtract usage for this period, with a min of 0
    return Math.max(0, afterRefill - dataPoint.value);
  }, BUCKET_MAX_BYTES);

  // If the station has less than the fudge factor remaining, we consider them
  // to be over the limit and should be rate limited
  const isRateLimited = remaingTokens < FUDGE_BYTES;

  return isRateLimited;
}

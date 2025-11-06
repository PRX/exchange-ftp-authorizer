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

const cloudwatch = new CloudWatchClient({
  retryStrategy,
  requestHandler,
});

const PERIOD = 3600;
const NUM_PERIODS = 24 * 7;
const REFILL_RATE_BYTES = 150_000_000 * 3; // Bytes accrued per metric period. 120 MB is about 1 hour of broadcast MP2 audio
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
  // console.log(JSON.stringify(getMetricDataInput));

  const metricData = await cloudwatch.send(
    // @ts-ignore
    new GetMetricDataCommand(getMetricDataInput),
  );
  const results = metricData.MetricDataResults?.[0];
  // console.log(JSON.stringify(results));

  const dataPoints = results.Timestamps.map((timestamp, i) => ({
    timestamp: new Date(timestamp),
    value: results.Values[i],
  })).sort((a, b) => a.timestamp.valueOf() - b.timestamp.valueOf());
  // console.log(JSON.stringify(dataPoints));

  const allApproximateTimestamps = [];
  for (
    let t = new Date(startTime);
    t < endTime;
    t = new Date(t.getTime() + PERIOD * 1000)
  ) {
    allApproximateTimestamps.push(new Date(t));
  }
  // console.log(JSON.stringify(allApproximateTimestamps));

  const filledDataPoints = allApproximateTimestamps.map((aprox) => {
    const match = dataPoints.find(
      (p) =>
        Math.abs(p.timestamp.valueOf() - aprox.valueOf()) < (PERIOD * 1000) / 2, // close enough within 1 period
    );
    return {
      timestamp: aprox,
      value: match ? match.value : 0,
    };
  });
  // console.log(JSON.stringify(filledDataPoints));

  const tokens = filledDataPoints.reduce((acc, dataPoint) => {
    const previousTokens = acc;
    const purse = Math.min(
      BUCKET_MAX_BYTES,
      previousTokens + REFILL_RATE_BYTES,
    );
    const spent = dataPoint.value;
    const finalTokens = Math.max(0, purse - spent);

    // console.log(
    //   `incoming total: ${previousTokens}, spent: ${spent}, refill: ${REFILL_RATE_BYTES}, final: ${finalTokens}`,
    // );

    // return Math.max(
    //   0,
    //   Math.min(BUCKET_MAX_BYTES, acc - dataPoint.value + REFILL_RATE_BYTES),
    // );
    return finalTokens;
  }, BUCKET_MAX_BYTES);

  const isRateLimited = tokens < FUDGE_BYTES;

  return isRateLimited;
}

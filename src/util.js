/** @import { TransferFamilyAuthorizerEvent } from "aws-lambda" */
/** @import { Parameter } from "@aws-sdk/client-ssm" */

/**
 * @param {Parameter[]} parameters
 * @param {string} parameterArn
 * @returns {string}
 */
export function paramValue(parameters, parameterArn) {
  const value = parameters.find((p) => p.ARN === parameterArn)?.Value;

  if (!value) {
    throw new Error(`Could not find value for parameter ${parameterArn}`);
  }

  return value;
}

/** @param {string} msg */
export function msg(msg) {
  console.info(JSON.stringify({ msg }));
}

/** @param {TransferFamilyAuthorizerEvent} event */
export function redact(event) {
  const clone = structuredClone(event);

  if (clone.password) {
    clone.password = "[REDACTED]";
  }

  console.info(JSON.stringify({ event: clone }));
}

/**
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function rand(min, max) {
  const minCeiled = Math.ceil(min);
  return Math.floor(
    Math.random() * (Math.floor(max) - minCeiled + 1) + minCeiled,
  );
}

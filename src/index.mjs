import { createConnection } from 'mysql2/promise';
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';
import { ConfiguredRetryStrategy } from '@aws-sdk/util-retry';

const ssm = new SSMClient({
  apiVersion: '2014-11-06',
  retryStrategy: new ConfiguredRetryStrategy(6, 1100),
  // TODO Shoud also set connectTimeout=1000 and timeout=2000, but couldn't get
  // it working with SDK v3 using requestHandler
});

const ENV = process.env;

async function authorize(connectionParams, username, password) {
  if (!username || !password) {
    return false;
  }

  console.log('Creating MySQL connection');
  const connection = await createConnection(connectionParams);
  console.log('Done creating MySQL connection');

  console.log('Running MySQL query');
  const [rows] = await connection.execute(
    "SELECT name FROM `accounts` WHERE delivery_ftp_user = ? AND delivery_ftp_password = ? AND type = 'StationAccount' AND status = 'open' AND deleted_at is NULL",
    [username, password],
  );
  console.log('Done running MySQL query');
  connection.end();

  if (Array.isArray(rows) && rows.length) {
    return true;
  }

  return false;
}

const initializeParams = async () => {
  console.log('Initializing SSM params');

  return ssm.send(
    new GetParametersCommand({
      Names: [
        ENV.DB_NAME_PARAMETER_ARN.split(':parameter')[1],
        ENV.DB_USERNAME_PARAMETER_ARN.split(':parameter')[1],
        ENV.DB_PASSWORD_PARAMETER_ARN.split(':parameter')[1],
      ],
      WithDecryption: true,
    }),
  );
};

const getParams = initializeParams();

exports.handler = async (event) => {
  console.log('Getting SSM parameters');
  const params = await getParams;
  console.log('Done getting SSM parameters');

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

  const bucketName = ENV.S3_BUCKET_ARN.split(':')[5];

  const userPolicy = {
    Statement: [
      {
        Action: ['s3:ListBucket'],
        Condition: {
          StringLike: {
            's3:prefix': [event.username, `${event.username}/*`],
          },
        },
        Effect: 'Allow',
        Resource: [ENV.S3_BUCKET_ARN],
        Sid: 'AllowBucketUserPrefixReadOnly',
      },
      {
        Action: [
          's3:GetObject',
          's3:GetObjectAttributes',
          's3:GetObjectVersion',
          's3:GetObjectVersionAttributes',
        ],
        Effect: 'Allow',
        Resource: [`${ENV.S3_BUCKET_ARN}/*`],
        Sid: 'AllowObjectUserPrefixReadOnly',
      },
    ],
    Version: '2012-10-17',
  };

  const authorization = {
    Role: ENV.FTP_USER_ACCESS_ROLE,
    Policy: JSON.stringify(userPolicy),
    HomeDirectoryType: 'LOGICAL',
    HomeDirectoryDetails: JSON.stringify([
      {
        // Exposes the contents of a folder in S3 as the root file
        // system for the user's session. Examples do not include a
        // trailing slash. If wxyz/audio.mp2 exists in the bucket,
        // when wxyz logs in they will see audio.mp2 in the root of
        // the FTP server.
        Entry: `/`,
        Target: `/${bucketName}/${event.username}`,
      },
    ]),
  };

  if (event.password?.length) {
    // Password-based authentication for FTP and SFTP

    const isAuthed = await authorize(
      dbConnectionParams,
      event.username,
      event.password,
    );

    if (isAuthed) {
      console.log('Password OK');
      return authorization;
    } else {
      console.log('Bad password');
      return {};
    }
    // } else if (event.protocol === 'SFTP') {
    // Key-based authentication for SFTP
  } else {
    // Invalid authentication; do not return any policy
    console.log('Bad login');
    return {};
  }
};

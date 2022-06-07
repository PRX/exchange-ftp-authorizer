import * as mysql from 'mysql';
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({ region: process.env.AWS_REGION });

const ENV = process.env;

function authorize(connectionParams, username, password) {
  return new Promise((resolve, reject) => {
    const connection = mysql.createConnection(connectionParams);

    connection.connect();

    connection.query(
      `SELECT name FROM accounts WHERE delivery_ftp_user = ? AND delivery_ftp_password = ?`,
      [username, password],
      function (error, result) {
        if (error) {
          // query error
          reject(error);
        } else if (result.length) {
          // Will only get a result when name/password match the input, so this
          // is a successful login
          resolve(true);
        } else {
          resolve(false);
        }
      },
    );

    connection.end();
  });
}

exports.handler = async (event) => {
  // TODO Move outside of handler for better performance
  const params = await ssm.send(
    new GetParametersCommand({
      Names: [
        ENV.DB_NAME_PARAMETER_ARN.split(':parameter')[1],
        ENV.DB_USERNAME_PARAMETER_ARN.split(':parameter')[1],
        ENV.DB_PASSWORD_PARAMETER_ARN.split(':parameter')[1],
      ],
      WithDecryption: true,
    }),
  );

  const dbConnectionParams = {
    host: ENV.MYSQL_ENDPOINT,
    database: params.Parameters.find(
      (p) => p.ARN === ENV.DB_NAME_PARAMETER_ARN,
    ),
    user: params.Parameters.find(
      (p) => p.ARN === ENV.DB_USERNAME_PARAMETER_ARN,
    ),
    password: params.Parameters.find(
      (p) => p.ARN === ENV.DB_PASSWORD_PARAMETER_ARN,
    ),
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
      event.usernamem,
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

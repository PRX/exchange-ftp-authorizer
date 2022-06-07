const https = require('https');
const AWS = require('aws-sdk');

const ssm = new AWS.SSM({ apiVersion: '2014-11-06' });

const ENV = process.env;

exports.handler = async (event) => {
  // TODO Move outside of handler for better performance
  const param = await ssm
    .getParameter({
      Name: ENV.FTP_AUTH_TOKEN_PARAMETER_ARN.split(':parameter')[1],
      WithDecryption: true,
    })
    .promise();
  const token = param.Parameter.Value;

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

    const isAuthed = await new Promise((resolve, reject) => {
      const body = JSON.stringify({
        token,
        user: event.username,
        password: event.password,
      });

      const req = https
        .request(
          {
            host: ENV.EXCHANGE_HOSTNAME,
            path: '/ftp/auth',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (r) => {
            r.on('data', () => {});
            r.on('end', () =>
              r.statusCode === 200 ? resolve(true) : resolve(false),
            );
          },
        )
        .on('error', reject);

      req.write(body);
      req.end();
    });

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

function userPolicy(username, bucketArn) {
  return {
    Statement: [
      {
        Action: ["s3:ListBucket"],
        Condition: {
          StringLike: {
            "s3:prefix": [username, `${username}/*`],
          },
        },
        Effect: "Allow",
        Resource: [bucketArn],
        Sid: "AllowBucketUserPrefixReadOnly",
      },
      {
        Action: [
          "s3:GetObject",
          "s3:GetObjectAttributes",
          "s3:GetObjectVersion",
          "s3:GetObjectVersionAttributes",
        ],
        Effect: "Allow",
        Resource: [`${bucketArn}/*`],
        Sid: "AllowObjectUserPrefixReadOnly",
      },
    ],
    Version: "2012-10-17",
  };
}

export default function authorization(username, bucketArn) {
  const bucketName = bucketArn.split(":")[5];

  return {
    Role: process.env.FTP_USER_ACCESS_ROLE,
    Policy: JSON.stringify(userPolicy(username, bucketArn)),
    HomeDirectoryType: "LOGICAL",
    HomeDirectoryDetails: JSON.stringify([
      {
        // Exposes the contents of a folder in S3 as the root file
        // system for the user's session. Examples do not include a
        // trailing slash. If wxyz/audio.mp2 exists in the bucket,
        // when wxyz logs in they will see audio.mp2 in the root of
        // the FTP server.
        Entry: `/`,
        Target: `/${bucketName}/${username}`,
      },
    ]),
  };
}

import { createConnection } from "mysql2/promise";

export default async function authorize(connectionParams, username, password) {
  if (!username || !password) {
    return false;
  }

  console.log("Creating MySQL connection");
  const connection = await createConnection(connectionParams);
  console.log("Done creating MySQL connection");

  console.log("Running MySQL query");
  const [rows] = await connection.execute(
    "SELECT name FROM `accounts` WHERE delivery_ftp_user = ? AND delivery_ftp_password = ? AND type = 'StationAccount' AND status = 'open' AND deleted_at is NULL",
    [username, password],
  );
  console.log("Done running MySQL query");
  connection.end();

  if (Array.isArray(rows) && rows.length) {
    return true;
  }

  return false;
}

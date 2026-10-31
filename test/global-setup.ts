import { connect, migrate } from "../src/db/index.js";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/keel_test";
  process.env.TEST_DATABASE_URL = url;
  const sql = connect(url, { max: 1 });
  await sql.unsafe("drop schema public cascade; create schema public;");
  await migrate(sql);
  await sql.end();
}

import { connect, migrate } from "../db/index.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const sql = connect(url, { max: 1 });
const ran = await migrate(sql);
console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Database is up to date");
await sql.end();

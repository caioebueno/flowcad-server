import { readFile } from "node:fs/promises";
import { connect } from "../db/index.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { ConfigDocSchema } from "../config/schema.js";
import { publishConfig, rollbackConfig } from "../config/store.js";

const usage = `Usage:
  npm run config -- show                       print the live config
  npm run config -- defaults                   print the bundled defaults
  npm run config -- validate <file.json>
  npm run config -- publish <file.json> [note] publish a new version
  npm run config -- rollback <version>         republish an earlier version
Set CONFIG_AUTHOR to record who made the change.`;

const [cmd, arg, note] = process.argv.slice(2);
const author = process.env.CONFIG_AUTHOR ?? process.env.USER ?? "unknown";

if (cmd === "defaults") {
  console.log(JSON.stringify(DEFAULT_CONFIG, null, 2));
} else if (cmd === "validate" && arg) {
  ConfigDocSchema.parse(JSON.parse(await readFile(arg, "utf8")));
  console.log("Valid");
} else if (cmd === "show" || cmd === "publish" || cmd === "rollback") {
  const sql = connect(process.env.DATABASE_URL ?? "", { max: 1 });
  try {
    if (cmd === "show") {
      const [row] = await sql`select version, doc, author, created_at from config_versions order by version desc limit 1`;
      console.log(row ? JSON.stringify(row, null, 2) : "Nothing published; the service uses the bundled defaults.");
    } else if (cmd === "publish" && arg) {
      const v = await publishConfig(sql, JSON.parse(await readFile(arg, "utf8")), author, note);
      console.log(`Published config v${v}`);
    } else if (cmd === "rollback" && arg) {
      const v = await rollbackConfig(sql, Number(arg), author);
      console.log(`Rolled back: v${arg} is live again as v${v}`);
    } else console.log(usage);
  } finally {
    await sql.end();
  }
} else {
  console.log(usage);
}

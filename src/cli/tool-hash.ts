import { readFile } from "node:fs/promises";
import { toolHash } from "../proxy/toolHash.js";

// Prints allowlist entries for a JSON file holding an array of tool definitions.
const file = process.argv[2];
if (!file) {
  console.log("Usage: npm run tool-hash -- tools.json");
  process.exit(1);
}
const tools = JSON.parse(await readFile(file, "utf8")) as { name: string; input_schema: unknown }[];
console.log(JSON.stringify(Object.fromEntries(tools.map((t) => [t.name, toolHash(t)])), null, 2));

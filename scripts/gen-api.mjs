import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import openapiTS, { astToString } from "openapi-typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const port = process.env.OPENCODE_PORT ?? "4096";
const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";

const docUrl = `http://localhost:${port}/doc`;

const headers = {};
if (password) {
  headers["Authorization"] =
    "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
}

try {
  const url = new URL(docUrl);
  const ast = await openapiTS(url, { headers });
  const output = astToString(ast);

  const outDir = path.join(rootDir, "src", "client", "generated");
  fs.mkdirSync(outDir, { recursive: true });

  const outFile = path.join(outDir, "api.ts");
  fs.writeFileSync(outFile, output, "utf8");

  console.log(`Generated ${outFile}`);
} catch (err) {
  if (
    err.code === "ECONNREFUSED" ||
    err.code === "ENOTFOUND" ||
    err.cause?.code === "ECONNREFUSED"
  ) {
    console.error(
      `opencode serve must be running on :${port} before running gen:api`
    );
  } else {
    console.error("gen:api failed:", err.message ?? err);
  }
  process.exit(1);
}

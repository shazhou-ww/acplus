import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { positionals } = parseArgs({ allowPositionals: true, options: {} });
if (positionals.length !== 2) {
  throw new Error(
    "Usage: node docs\\render-api-docs.js <bundle.json> <output.html>",
  );
}

const spec = JSON.parse(readFileSync(positionals[0], "utf8"));
if (spec.openapi !== "3.1.0" || !spec.info?.title || !spec.paths) {
  throw new Error("Expected a bundled OpenAPI 3.1 document");
}

const serialized = JSON.stringify(spec).replaceAll("<", "\\u003c");
writeFileSync(
  positionals[1],
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ahplex HTTP API</title>
    <style>body { margin: 0; }</style>
  </head>
  <body>
    <noscript>This API reference requires JavaScript. Read API.md or openapi.yaml for the source contract.</noscript>
    <div id="redoc">Loading API reference. The ReDoc viewer requires access to cdn.redocly.com.</div>
    <script id="openapi" type="application/json">${serialized}</script>
    <script src="https://cdn.redocly.com/redoc/v2.5.0/bundles/redoc.standalone.js"></script>
    <script>
      if (typeof Redoc === "undefined") {
        document.getElementById("redoc").textContent =
          "Unable to load the ReDoc viewer. Check network access to cdn.redocly.com, or read API.md and openapi.yaml.";
      } else {
        Redoc.init(
          JSON.parse(document.getElementById("openapi").textContent),
          { disableGoogleFont: true },
          document.getElementById("redoc"),
        );
      }
    </script>
  </body>
</html>
`,
  "utf8",
);

import type { LoadHook } from "node:module";

function replaceExact(
  source: string,
  before: string,
  after: string,
  count = 1,
): string {
  if (source.split(before).length !== count + 1) {
    throw new Error("Unsupported ahpc source: compatibility patch mismatch");
  }
  return source.replaceAll(before, after);
}

// A pinned, fail-closed in-memory patch also works for npm consumers of the tarball.
export function patchLive(source: string): string {
  source = "import { pathToFileURL as hubFileURL } from 'node:url';\n" + source;
  source = replaceExact(
    source,
    "workingDirectory: `file://${workingDirectory}`",
    "workingDirectory: hubFileURL(workingDirectory).href",
    2,
  );
  source = replaceExact(
    source,
    "workingDirectories: [`file://${workingDirectory}`]",
    "workingDirectories: [hubFileURL(workingDirectory).href]",
  );
  source = replaceExact(
    source,
    "say: (uri, text, model) => {",
    "say: (uri, text, model, hubTurnId) => {",
  );
  source = replaceExact(
    source,
    "type: 'chat/turnStarted',\n                turnId: randomUUID(),",
    "type: 'chat/turnStarted',\n                turnId: hubTurnId ?? randomUUID(),",
  );
  source = replaceExact(
    source,
    "stopTurn: (uri) => {",
    "stopTurn: (uri, hubTurnId) => {",
  );
  source = replaceExact(
    source,
    "if (!turnId)\n                    return;",
    "if (!turnId || (hubTurnId !== undefined && turnId !== hubTurnId))\n                    return;",
  );
  return source;
}

export const load: LoadHook = async (url, context, nextLoad) => {
  const loaded = await nextLoad(url, context);
  if (url.endsWith("/@softov/ahpc/dist/src/ahp/live.js")) {
    const source = loaded.source;
    const text =
      typeof source === "string" ? source : new TextDecoder().decode(source);
    return { ...loaded, source: patchLive(text) };
  }
  return loaded;
};

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { setInterval, setTimeout } from "node:timers";

// Synthetic CLI/protocol fixture, never a GitHub authentication implementation.
const directory = process.env.GH_CONFIG_DIR;
const args = process.argv.slice(2);
let control;
try {
  control = JSON.parse(readFileSync(join(directory, "control.json"), "utf8"));
} catch {
  control = {};
}
appendFileSync(
  join(directory, "calls.jsonl"),
  JSON.stringify({
    args,
    pid: process.pid,
    configDir: directory,
    browser: process.env.GH_BROWSER,
    dbus: process.env.DBUS_SESSION_BUS_ADDRESS,
    ambient: Object.keys(process.env).filter((key) =>
      /^(?:GH_TOKEN|GITHUB_TOKEN|COPILOT_GITHUB_TOKEN|GH_DEBUG|NODE_OPTIONS|SHOULD_NOT_REACH_CHILD)$/u.test(
        key,
      ),
    ),
  }) + "\n",
);
if (control.fail === args[1]) {
  process.stderr.write(
    "credential gho_fixtureSecret must never be forwarded\n",
  );
  process.exit(1);
}
if (control.overflow) {
  process.stdout.write(
    (control.overflow === "lines" ? "private\n" : "private").repeat(12000),
  );
  setInterval(() => {}, 1000);
} else if (args[1] === "login") {
  process.stdout.write("discard unrelated stdout gho_fixtureSecret\n");
  if (!control.noCode) {
    process.stderr.write("\u001b[33m! First copy your one-");
    await new Promise((resolve) => setTimeout(resolve, 5));
    process.stderr.write("time code: ABCD-1234\u001b[0m\n");
    process.stderr.write("Open this URL to continue in your web browser: ");
    process.stderr.write(
      control.badUrl
        ? "https://evil.example/login/device\n"
        : "https://github.com/login/device\n",
    );
  }
  if (control.hold) {
    writeFileSync(join(directory, "pid"), String(process.pid));
    setInterval(() => {}, 1000);
  } else {
    writeFileSync(join(directory, "logged-in"), "synthetic");
  }
} else if (args[1] === "status") {
  if (control.invalidJson) process.stdout.write("{private");
  else {
    let loggedIn = true;
    try {
      readFileSync(join(directory, "logged-in"));
    } catch {
      loggedIn = false;
    }
    const entry = {
      state: control.state ?? "success",
      active: true,
      host: "github.com",
      login: control.account ?? "fixture-user",
      tokenSource: control.source ?? join(directory, "hosts.yml"),
      token: "gho_*************",
      scopes: control.scopes ?? "repo, read:org, gist, read:user, user:email",
      ...(control.expiry === undefined
        ? {}
        : {
            tokenExpiresAt:
              control.expiry === "future"
                ? new Date(Date.now() + 5000).toISOString()
                : control.expiry,
          }),
    };
    process.stdout.write(
      JSON.stringify({
        hosts: { "github.com": loggedIn ? [entry] : [] },
      }),
    );
  }
} else if (args[1] === "token") {
  process.stdout.write(control.token ?? "gho_fixtureSecret\n");
} else {
  process.exitCode = 2;
}

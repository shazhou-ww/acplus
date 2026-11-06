import process from "node:process";
import { setTimeout, setInterval } from "node:timers";
const scenario = process.env.LOGIN_SCENARIO;
if (scenario === "overflow") {
  process.stdout.write("x".repeat(33000));
} else if (scenario === "failure") {
  process.stderr.write("private token gh_fake_never_forward");
  process.exitCode = 1;
} else if (scenario === "success") {
  process.exitCode = 0;
} else {
  process.stdout.write("To authenticate visit https://github.com/login/");
  setTimeout(() => {
    process.stdout.write("device and enter ABCD-EF12\n");
    if (scenario !== "wait") {
      if (scenario === "premature-receipt")
        process.stdout.write("Signed in successfully as fixture-user.\n");
      process.stdout.write(
        "System keychain unavailable. Store token in plaintext config file? (y/N)",
      );
      process.stdin.once("data", (chunk) => {
        if (chunk.toString() !== "y\n") process.exit(1);
        if (
          scenario === "prompt-no-receipt" ||
          scenario === "premature-receipt"
        )
          process.exit(0);
        if (scenario === "partial-receipt") {
          process.stdout.write("\r\nSigned in successfully as fixture-user.");
          setTimeout(() => {
            process.stdout.write(" but storage did not complete\r\n", () =>
              process.exit(0),
            );
          }, 20);
          return;
        }
        process.stdout.write(
          "\r\nSigned in successfully as fixture-user.\r\n",
          () => {
            process.exit(scenario === "receipt-failure" ? 1 : 0);
          },
        );
      });
      process.stdin.resume();
    }
  }, 20);
}
if (scenario === "wait") setInterval(() => {}, 1000);

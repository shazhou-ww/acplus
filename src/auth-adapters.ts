import { setTimeout as delay } from "node:timers/promises";
import { ServiceError, record } from "./common.js";
import { objectSchema, secretSchema, type SecretReference } from "./config.js";
import { codec, type AuthenticationAdapterFactory } from "./extensions.js";

export const tokenFactory: AuthenticationAdapterFactory<{
  credential: SecretReference;
}> = {
  id: "ahp-token",
  options: codec(objectSchema({ credential: secretSchema })),
  create: (options) => ({
    async run(context, signal) {
      const token = await context.secrets.resolve(options.credential);
      await context.submitCredential({ token }, signal);
    },
  }),
};

export interface DeviceOptions {
  clientId: string;
  scopes: string[];
}
export const deviceFactory: AuthenticationAdapterFactory<DeviceOptions> = {
  id: "github-device",
  options: codec(
    objectSchema({
      clientId: { type: "string", minLength: 1 },
      scopes: {
        type: "array",
        uniqueItems: true,
        items: { type: "string", minLength: 1 },
      },
    }),
  ),
  create: (options) => ({
    async run(context, signal) {
      if (
        context.target.provider === "$host" ||
        context.target.resource !== "https://api.github.com"
      )
        throw new ServiceError("auth_target_unsupported", 409);
      const device = await oauth(
        "https://github.com/login/device/code",
        {
          client_id: options.clientId,
          scope: options.scopes.join(" "),
        },
        signal,
      );
      if (
        typeof device.device_code !== "string" ||
        device.device_code === "" ||
        typeof device.user_code !== "string" ||
        device.user_code === "" ||
        typeof device.verification_uri !== "string" ||
        typeof device.expires_in !== "number" ||
        device.expires_in <= 0 ||
        typeof device.interval !== "number" ||
        device.interval < 1
      )
        throw new ServiceError("auth_invalid_response", 502);
      const link = new URL(device.verification_uri);
      if (
        link.origin !== "https://github.com" ||
        link.username !== "" ||
        link.password !== ""
      )
        throw new ServiceError("auth_invalid_response", 502);
      context.publishStep({
        kind: "link",
        url: link.href,
        userCode: device.user_code,
      });
      const deadline = Math.min(
        Date.parse(context.expiresAt),
        Date.now() + device.expires_in * 1000,
      );
      let interval = device.interval * 1000;
      while (Date.now() < deadline) {
        await delay(Math.min(interval, deadline - Date.now()), undefined, {
          signal,
        });
        if (Date.now() >= deadline) break;
        const result = await oauth(
          "https://github.com/login/oauth/access_token",
          {
            client_id: options.clientId,
            device_code: device.device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          },
          signal,
        );
        if (result.error === "authorization_pending") continue;
        if (result.error === "slow_down") {
          interval += 5000;
          continue;
        }
        if (result.error === "expired_token") break;
        if (result.error !== undefined)
          throw new ServiceError("auth_authorization_denied", 409);
        if (
          typeof result.access_token !== "string" ||
          result.access_token === "" ||
          result.token_type !== "bearer" ||
          (result.expires_in !== undefined &&
            (typeof result.expires_in !== "number" || result.expires_in <= 0))
        )
          throw new ServiceError("auth_invalid_response", 502);
        const scopes =
          typeof result.scope === "string"
            ? result.scope.split(/[,\s]+/u).filter(Boolean)
            : [];
        if (options.scopes.some((scope) => !scopes.includes(scope)))
          throw new ServiceError("auth_scope_missing", 409);
        await context.submitCredential(
          {
            token: result.access_token,
            scopes,
            ...(typeof result.expires_in === "number"
              ? {
                  expiresAt: new Date(
                    Date.now() + result.expires_in * 1000,
                  ).toISOString(),
                }
              : {}),
          },
          signal,
        );
        return;
      }
      throw new ServiceError("auth_expired", 409);
    },
  }),
};

async function oauth(
  url: string,
  values: Record<string, string>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(values),
    signal,
    redirect: "error",
  });
  const data: unknown = await response.json();
  if (!response.ok || !record(data))
    throw new ServiceError("auth_server_unavailable", 502);
  return data;
}

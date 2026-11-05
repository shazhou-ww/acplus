import { randomUUID } from "node:crypto";
import { AhpErrorCodes } from "@microsoft/agent-host-protocol";
import { RpcError } from "@microsoft/agent-host-protocol/client";
import type { HostClientHandle } from "@microsoft/agent-host-protocol/hosts";
import {
  bounded,
  diagnostic,
  record,
  ServiceError,
  type Redactor,
} from "./common.js";
import type { AuthenticationBinding } from "./config.js";
import type {
  AdapterRegistry,
  AuthInput,
  AuthenticationContext,
  AuthVerification,
  InputStepContent,
  LinkStepContent,
  SecretResolver,
  UpstreamCredential,
} from "./extensions.js";
import type { NativeHost } from "./native.js";
import { ProcessOwner } from "./processes.js";

type AuthStatus =
  | { status: "idle" }
  | {
      status:
        "pending" | "action_required" | "succeeded" | "failed" | "expired";
      methodId: string;
      step?: LinkStepContent | (InputStepContent & { stepId: string });
      error?: { code: string; message: string };
    };
interface Attempt {
  binding: AuthenticationBinding;
  controller: AbortController;
  processes: ProcessOwner;
  done: Promise<void>;
  handle?: HostClientHandle;
  verified?: AuthVerification;
  expiresAt: number;
  credentialExpiry?: number;
  challenge: number;
  input?: { stepId: string; fields: string[]; resolve(input: AuthInput): void };
}

export class Authentication {
  private status: AuthStatus = { status: "idle" };
  private attempt: Attempt | undefined;
  private active = false;
  private closed = false;
  private expiry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly host: NativeHost,
    private readonly registry: AdapterRegistry,
    private readonly secrets: SecretResolver,
    private readonly redactor: Redactor,
    private readonly timeoutMs = 600_000,
  ) {
    host.authActive = () => this.active;
    host.onConnectionChange = () => {
      if (this.status.status === "succeeded") this.status = { status: "idle" };
      if (this.active && this.attempt?.handle !== undefined)
        this.attempt.controller.abort();
    };
    host.onAuthenticationRequired = (resource) => {
      if (
        this.attempt === undefined ||
        (resource !== undefined && this.attempt.binding.resource !== resource)
      )
        return;
      this.attempt.challenge++;
      delete this.attempt.verified;
      if (this.status.status === "succeeded") this.status = { status: "idle" };
    };
  }

  get(): AuthStatus {
    if (
      this.status.status === "succeeded" &&
      this.attempt?.handle !== undefined
    ) {
      try {
        this.attempt.handle.checkAlive();
        this.host.connection(this.attempt.handle.generation);
      } catch {
        this.status = { status: "idle" };
      }
    }
    if (
      this.status.status === "succeeded" &&
      this.attempt?.credentialExpiry !== undefined &&
      Date.now() >= this.attempt.credentialExpiry
    )
      this.status = { status: "idle" };
    return this.status;
  }

  begin(methodId: string): void {
    if (this.closed) throw new ServiceError("service_stopping", 503);
    if (this.host.status === "stopping")
      throw new ServiceError("host_stopping", 409);
    if (this.active) throw new ServiceError("auth_in_progress", 409);
    const binding = this.host.config.authentication.find(
      (binding) => binding.id === methodId,
    );
    if (binding === undefined)
      throw new ServiceError("auth_method_not_found", 404);
    const attempt: Attempt = {
      binding,
      controller: new AbortController(),
      processes: new ProcessOwner(),
      done: Promise.resolve(),
      expiresAt: Date.now() + this.timeoutMs,
      challenge: 0,
    };
    this.attempt = attempt;
    this.active = true;
    this.status = { status: "pending", methodId };
    this.expiry = setTimeout(() => {
      this.status = {
        status: "expired",
        methodId,
        error: diagnostic(new ServiceError("auth_expired", 409)),
      };
      attempt.controller.abort();
    }, this.timeoutMs);
    this.expiry.unref();
    attempt.done = this.run(attempt);
  }

  input(stepId: string, values: Record<string, string>): void {
    const attempt = this.attempt;
    if (
      !this.active ||
      attempt?.input === undefined ||
      attempt.input.stepId !== stepId ||
      attempt.controller.signal.aborted
    )
      throw new ServiceError("auth_step_mismatch", 409);
    const current = attempt.input;
    if (
      Object.keys(values).length !== current.fields.length ||
      current.fields.some((key) => !Object.hasOwn(values, key))
    )
      throw new ServiceError("auth_step_mismatch", 409);
    for (const value of Object.values(values)) this.redactor.add(value);
    delete attempt.input;
    this.status = { status: "pending", methodId: attempt.binding.id };
    current.resolve({ stepId, values });
  }

  private check(attempt: Attempt): void {
    if (
      this.closed ||
      this.attempt !== attempt ||
      attempt.controller.signal.aborted ||
      Date.now() >= attempt.expiresAt
    )
      throw new ServiceError("auth_attempt_inactive", 409);
    if (
      attempt.credentialExpiry !== undefined &&
      Date.now() >= attempt.credentialExpiry
    )
      throw new ServiceError("auth_expired", 409);
    if (attempt.handle !== undefined) {
      try {
        attempt.handle.checkAlive();
        this.host.connection(attempt.handle.generation);
      } catch {
        throw new ServiceError("auth_connection_changed", 409);
      }
    }
  }

  private async run(attempt: Attempt): Promise<void> {
    const { binding, controller } = attempt;
    const signal = controller.signal;
    try {
      if (binding.provider !== "$host") {
        attempt.handle = await bounded(this.host.ensure(), signal);
        const root = await bounded(this.host.root(attempt.handle), signal);
        const agent = root.agents.find(
          (agent) => agent.provider === binding.provider,
        );
        if (
          agent === undefined ||
          !agent.protectedResources?.some(
            (resource) => resource.resource === binding.resource,
          )
        )
          throw new ServiceError("auth_target_not_advertised", 409);
      }
      this.check(attempt);
      const context: AuthenticationContext = {
        target: {
          hostId: this.host.config.id,
          provider: binding.provider,
          resource: binding.resource,
          ...(attempt.handle === undefined
            ? {}
            : { generation: attempt.handle.generation }),
        },
        expiresAt: new Date(attempt.expiresAt).toISOString(),
        secrets: this.secrets,
        processes: attempt.processes,
        logger: { event: () => {} },
        publishStep: (step) => {
          this.check(attempt);
          const url = new URL(step.url);
          if (
            !["https:", "http:"].includes(url.protocol) ||
            url.username !== "" ||
            url.password !== "" ||
            attempt.input !== undefined
          )
            throw new ServiceError("auth_invalid_step", 502);
          this.status = {
            status: "action_required",
            methodId: binding.id,
            step: {
              kind: "link",
              url: step.url,
              ...(step.userCode === undefined
                ? {}
                : { userCode: step.userCode }),
            },
          };
        },
        requestInput: async (step, inputSignal) => {
          this.check(attempt);
          if (
            step.fields.length === 0 ||
            step.fields.some((field) => field === "") ||
            new Set(step.fields).size !== step.fields.length ||
            attempt.input !== undefined
          )
            throw new ServiceError("auth_invalid_step", 502);
          const stepId = randomUUID();
          const pending = new Promise<AuthInput>((resolve) => {
            attempt.input = { stepId, fields: [...step.fields], resolve };
          });
          this.status = {
            status: "action_required",
            methodId: binding.id,
            step: { kind: "input", fields: [...step.fields], stepId },
          };
          try {
            return await bounded(
              pending,
              AbortSignal.any([signal, inputSignal]),
            );
          } finally {
            delete attempt.input;
          }
        },
        submitCredential: (credential, submitSignal) =>
          this.submit(
            attempt,
            credential,
            AbortSignal.any([signal, submitSignal]),
          ),
        verifyAuthentication: async (verifySignal) => {
          this.check(attempt);
          const challenge = attempt.challenge;
          const result =
            attempt.verified ??
            (await bounded(
              this.host.driver.verifyAuthentication(
                context.target,
                verifySignal,
              ),
              AbortSignal.any([signal, verifySignal]),
            ));
          this.check(attempt);
          if (attempt.challenge !== challenge)
            throw new ServiceError("upstream_auth_required", 409);
          attempt.verified = result;
          return result;
        },
      };
      const adapter = this.registry.authentication(
        binding.adapter,
        binding.options,
      );
      await bounded(adapter.run(context, signal), signal);
      const result = await context.verifyAuthentication(signal);
      this.check(attempt);
      if (result.status !== "authenticated")
        throw new ServiceError(
          result.status === "required"
            ? "upstream_auth_required"
            : "auth_verification_unsupported",
          409,
        );
      this.status = { status: "succeeded", methodId: binding.id };
    } catch (error) {
      if (this.status.status !== "expired") {
        const safe = signal.aborted
          ? new ServiceError("auth_connection_changed", 409)
          : error;
        this.status = {
          status:
            Date.now() >= attempt.expiresAt ||
            (error instanceof ServiceError && error.code === "auth_expired")
              ? "expired"
              : "failed",
          methodId: binding.id,
          error: diagnostic(safe),
        };
      }
    } finally {
      clearTimeout(this.expiry);
      delete attempt.input;
      controller.abort();
      try {
        await attempt.processes.close();
        this.active = false;
      } catch {
        this.status = {
          status: "failed",
          methodId: binding.id,
          error: diagnostic(new ServiceError("auth_cleanup_failed", 503)),
        };
        // Retain admission ownership if process cleanup failed.
      }
    }
  }

  private async submit(
    attempt: Attempt,
    credential: UpstreamCredential,
    signal: AbortSignal,
  ): Promise<AuthVerification> {
    this.check(attempt);
    delete attempt.verified;
    delete attempt.credentialExpiry;
    const challenge = attempt.challenge;
    const handle = attempt.handle;
    if (handle === undefined)
      throw new ServiceError("auth_target_unsupported", 409);
    const token = this.redactor.add(credential.token);
    if (token === "") throw new ServiceError("credential_unavailable", 409);
    const expiry =
      credential.expiresAt === undefined
        ? undefined
        : Date.parse(credential.expiresAt);
    if (expiry !== undefined) {
      if (!Number.isFinite(expiry))
        throw new ServiceError("auth_invalid_credential", 409);
      if (expiry <= Date.now()) throw new ServiceError("auth_expired", 409);
    }
    try {
      // AHP defines authenticate's successful RPC reply as token validation;
      // command completion, not a local token write or a model catalogue, is evidence.
      const result = await bounded(
        handle.request("authenticate", {
          channel: "ahp-root://",
          resource: attempt.binding.resource,
          token,
          ...(credential.scopes === undefined
            ? {}
            : { scopes: credential.scopes }),
          ...(expiry === undefined
            ? {}
            : {
                expiresIn: Math.max(
                  1,
                  Math.floor((expiry - Date.now()) / 1000),
                ),
              }),
        }),
        signal,
      );
      if (!record(result)) throw new ServiceError("auth_invalid_response", 502);
      if (result.authenticated === false)
        throw new ServiceError("upstream_auth_required", 409);
      if (Object.keys(result).length !== 0 && result.authenticated !== true)
        throw new ServiceError("auth_invalid_response", 502);
      this.check(attempt);
      if (attempt.challenge !== challenge)
        throw new ServiceError("upstream_auth_required", 409);
      if (expiry !== undefined) attempt.credentialExpiry = expiry;
      attempt.verified = { status: "authenticated" };
      return attempt.verified;
    } catch (error) {
      if (
        error instanceof RpcError &&
        error.code === AhpErrorCodes.AuthRequired
      )
        throw new ServiceError("upstream_auth_required", 409);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.attempt?.controller.abort();
    await this.attempt?.done;
    await this.attempt?.processes.close();
    clearTimeout(this.expiry);
  }
}

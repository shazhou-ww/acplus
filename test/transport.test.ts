import { describe, expect, it, vi } from "vitest";
import {
  InMemoryTransport,
  type AhpTransport,
  type TransportFrame,
} from "@microsoft/agent-host-protocol/client";
import { safeTransport } from "../src/transport.js";

describe("SDK logging boundary", () => {
  it("preserves protocol frames but removes untrusted error messages and error data", async () => {
    const [client, server] = InMemoryTransport.pair();
    const safe = safeTransport(client);
    await server.send({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32007,
        message: "token=sensitive",
        data: { credential: "sensitive" },
      },
    });
    expect(await safe.recv()).toEqual({
      kind: "text",
      text: '{"jsonrpc":"2.0","id":1,"error":{"code":-32007,"message":"Upstream request rejected"}}',
    });
    await safe.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect(await server.recv()).toMatchObject({ kind: "text" });
    await safe.close();
    expect(await safe.recv()).toBeNull();
  });

  it("sanitizes transport failures and supports parsed and binary transports", async () => {
    const recv = vi.fn<AhpTransport["recv"]>();
    const send = vi
      .fn<AhpTransport["send"]>()
      .mockRejectedValue(new Error("ws://secret"));
    const close = vi
      .fn<AhpTransport["close"]>()
      .mockRejectedValue(new Error("secret"));
    const safe = safeTransport({ recv, send, close });
    await expect(safe.send("request")).rejects.toThrow(
      "host transport send failed",
    );
    await expect(safe.close()).rejects.toThrow("host transport close failed");
    recv.mockRejectedValueOnce(new Error("token"));
    await expect(safe.recv()).rejects.toThrow("host transport receive failed");
    recv.mockResolvedValueOnce({ kind: "text", text: "invalid json secret" });
    await expect(safe.recv()).rejects.toThrow("host transport receive failed");
    const parsed: TransportFrame = {
      kind: "parsed",
      message: { jsonrpc: "2.0", id: 1, result: null },
    };
    recv.mockResolvedValueOnce(parsed);
    expect(await safe.recv()).toEqual(parsed);
    const binary: TransportFrame = {
      kind: "binary",
      data: Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}'),
    };
    recv.mockResolvedValueOnce(binary);
    expect(await safe.recv()).toEqual(binary);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const hasura = vi.fn();
vi.mock("../hasura", () => ({ hasura: (...a: unknown[]) => hasura(...a), einvoiceClaims: (c: string) => ({ companyId: c }) }));
const generate = vi.fn();
vi.mock("./provider", () => ({ providerFor: () => ({ generate }) }));

import { decryptConfig, encryptConfig } from "./secrets";
import { registerWithIrp } from "./register";
import type { IrpPayload } from "../../lib/einvoice/payload";

process.env.EINVOICE_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");
const payload = {} as IrpPayload;

describe("secrets", () => {
  it("round-trips and rejects tampering", () => {
    const blob = encryptConfig({ clientId: "abc", password: "p" });
    expect(blob).not.toContain("abc");
    expect(decryptConfig(blob)).toEqual({ clientId: "abc", password: "p" });
    const bad = Buffer.from(blob, "base64");
    bad[bad.length - 1] ^= 1;
    expect(() => decryptConfig(bad.toString("base64"))).toThrow();
  });
});

describe("registerWithIrp", () => {
  beforeEach(() => {
    hasura.mockReset();
    generate.mockReset();
    hasura.mockImplementation(async (q: string) =>
      q.includes("einvoice_credentials")
        ? { einvoice_credentials: [{ provider: "gsp", config_encrypted: encryptConfig({ baseUrl: "https://x" }) }] }
        : {},
    );
  });

  it("stores the IRN on success", async () => {
    generate.mockResolvedValue({ irn: "IRN1", ackNo: "9", ackDate: "2026-10-01T00:00:00Z", signedQr: "jwt" });
    await registerWithIrp("co", "inv", payload);
    expect(hasura.mock.calls.at(-1)![1].set).toMatchObject({ irn: "IRN1", einvoice_status: "generated" });
  });

  it("marks failed and rethrows, so the caller can't send", async () => {
    generate.mockRejectedValue(new Error("IRP said no"));
    await expect(registerWithIrp("co", "inv", payload)).rejects.toThrow("IRP said no");
    expect(hasura.mock.calls.at(-1)![1].set).toMatchObject({ einvoice_status: "failed", einvoice_error: "IRP said no" });
  });

  it("fails closed when no credentials are saved", async () => {
    hasura.mockImplementation(async (q: string) => (q.includes("einvoice_credentials") ? { einvoice_credentials: [] } : {}));
    await expect(registerWithIrp("co", "inv", payload)).rejects.toThrow(/isn't set up/);
    expect(hasura.mock.calls.at(-1)![1].set.einvoice_status).toBe("failed");
  });
});

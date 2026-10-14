// TEMPORARY — sandbox-only diagnostic. Deleted right after it runs.
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { buildEInvoice } from "../../lib/einvoice/payload";
import { toMastersBody } from "./mastersIndia";

it("sandbox diagnostic", async () => {
  const env: Record<string, string> = {};
  for (const line of readFileSync("C:/Users/avina/Desktop/invoice-tracker/infra/.env", "utf8").split(/\r?\n/)) {
    const m = /^(MASTERS_BASE_URL|MASTERS_API_KEY)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  const base = env.MASTERS_BASE_URL;
  const key = env.MASTERS_API_KEY;
  if (!/sandb/i.test(base ?? "")) throw new Error(`Refusing: ${base} is not a sandbox URL`);
  const mask = (s: string) => s.split(key).join("<key>").slice(0, 700);
  const { payload } = buildEInvoice(
    {
      invoiceNumber: "TEST/" + Date.now().toString().slice(-8),
      invoiceDate: new Date().toISOString().slice(0, 10),
      seller: { gstin: "27AAPFU0939F1ZV", legalName: "Probe Seller", address: "1 MG Road", city: "Mumbai", pincode: "400001" },
      buyer: { gstin: "07AAGFF2194N1Z1", legalName: "Probe Buyer", address: "5 CP", city: "New Delhi", pincode: "110001" },
      items: [{ description: "Probe", hsnSac: "8471", quantity: 1, unitPrice: 100, uqc: "NOS", gstRate: 18 }],
    },
    new Date(),
  );
  const url = `${base.replace(/\/+$/, "")}/api/v1/einvoice/`;
  for (const [label, body, headers] of [
    ["full payload, api_key header", toMastersBody(payload!), { api_key: key }],
    ["empty body, api_key header", {}, { api_key: key }],
    ["empty body, NO key", {}, {}],
  ] as const) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    console.log(`DIAG [${label}] HTTP ${res.status}:`, mask(await res.text()));
  }
}, 90_000);

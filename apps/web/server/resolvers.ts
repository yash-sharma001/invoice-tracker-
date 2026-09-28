/**
 * Resolvers for the frontend's GraphQL contract (graphql/schema.graphql),
 * backed by the real Hasura API + genai-service. Field names / enums / computed
 * values are translated here so no component, operation, or codegen output has
 * to change. This is the Hasura-backed sibling of mock/resolvers.ts.
 */
import { hasura } from "./hasura";
import { publishNotification } from "./queue";
import { safeImageSrc } from "../lib/pdf/render";
import { requireRole, myCompanyId } from "./auth";
import {
  TODAY, iso, dayDiff, round, num, cleanEmail,
  mapMlModel, mapMlDriftReport, mapMlRetrainEvent, mapReviewQueueItem, mapDemoRequest,
  mapVendor, mapCompanySettings, mapCustomer, mapInvoice, INVOICE_SEL, COMPANY_SEL,
  vendorStats, customerStats,
} from "./mappers";
import { buildWhere, buildOrderBy } from "./queryBuilders";
import * as mlService from "./clients/mlService";
import * as genaiService from "./clients/genaiService";
import { toInsert, importInvoicesRows } from "./csvImport";
import { generateAndSendInvoiceImpl, resendInvoiceImpl } from "./invoiceSend";
import { attachPredictions } from "./predictions";

/** myCompanyId(), or throw — every mutation below still scopes its own
 * queries by company_id explicitly, on top of Hasura's row-level filter,
 * as defense in depth. */
function requireCompanyId(): string {
  const id = myCompanyId();
  if (!id) throw new Error("No company on this session — sign in again.");
  return id;
}

// ---- resolvers ----------------------------------------------------------------

/** update_vendors / update_customers differ only by table + returned columns. */
/** update_vendors / update_customers differ only by table, returned columns and
 * mapper — which always travel together, so they live in one record. */
const PARTY = {
  vendors: { sel: "id name tax_id payment_terms_days email", map: mapVendor, label: "Vendor" },
  customers: {
    sel: "id name tax_id payment_terms_days email credit_limit gstin address state",
    map: mapCustomer,
    label: "Customer",
  },
} as const;

async function setPartyEmail(table: keyof typeof PARTY, { id, email }: { id: string; email?: string | null }) {
  requireRole("admin");
  const { sel, map, label } = PARTY[table];
  const data = await hasura(
    `mutation SetEmail($id: uuid!, $companyId: uuid!, $email: String) {
       update_${table}(where: { id: { _eq: $id }, company_id: { _eq: $companyId } }, _set: { email: $email }) {
         returning { ${sel} }
       }
     }`,
    { id, email: cleanEmail(email), companyId: requireCompanyId() },
  );
  const row = data[`update_${table}`].returning[0];
  if (!row) throw new Error(`${label} not found`);
  return map(row);
}

export const resolvers = {
  Query: {
    async dashboardStats(_: unknown, { vendorId }: { vendorId?: string | null }) {
      const scope = vendorId ? `vendor_id: { _eq: "${vendorId}" }` : "";
      const s = scope ? `, ${scope}` : "";
      const today = iso(TODAY);
      const cutoff = iso(new Date(TODAY.getTime() - 30 * 86_400_000));
      const payScope = vendorId ? `, invoice: { vendor_id: { _eq: "${vendorId}" } }` : "";
      const d = `direction: { _eq: "payable" }`;
      const payDir = `, invoice: { direction: { _eq: "payable" } }`;
      const data = await hasura(`
        query {
          pending: invoices_aggregate(where: { ${d}, approval_status: { _eq: "pending" } ${s} }) {
            aggregate { count sum { amount tax_amount } }
          }
          overdue: invoices_aggregate(where: { ${d}, payment_status: { _neq: "paid" }, due_date: { _lt: "${today}" } ${s} }) {
            aggregate { count sum { amount tax_amount } }
          }
          exposure: invoices_aggregate(where: { ${d}, payment_status: { _neq: "paid" } ${s} }) {
            aggregate { sum { amount tax_amount } }
          }
          approvedUnpaid: invoices_aggregate(where: { ${d}, approval_status: { _eq: "approved" }, payment_status: { _neq: "paid" } ${s} }) {
            aggregate { count sum { amount tax_amount } }
          }
          rejected: invoices_aggregate(where: { ${d}, approval_status: { _eq: "rejected" } ${s} }) {
            aggregate { count }
          }
          paidLast30: payments_aggregate(where: { paid_at: { _gte: "${cutoff}" } ${payScope}${payDir} }) {
            aggregate { count sum { amount_paid } }
          }
          # ponytail: in-resolver scan for avg days-to-pay, capped at 500 paid invoices
          paidInvoices: invoices(where: { ${d}, payment_status: { _eq: "paid" } ${s} }, limit: 500) {
            invoice_date payments(order_by: { paid_at: asc_nulls_last }, limit: 1) { paid_at }
          }
        }
      `);
      const sum = (a: any) => num(a?.sum?.amount) + num(a?.sum?.tax_amount);
      const daysToPay = (data.paidInvoices ?? [])
        .map((i: any) => {
          const p = i.payments?.[0]?.paid_at;
          return p ? dayDiff(p, i.invoice_date) : null;
        })
        .filter((n: number | null): n is number => n != null && n >= 0);
      return {
        pendingCount: data.pending.aggregate.count,
        pendingAmount: round(sum(data.pending.aggregate)),
        overdueCount: data.overdue.aggregate.count,
        overdueAmount: round(sum(data.overdue.aggregate)),
        vendorExposureTotal: round(sum(data.exposure.aggregate)),
        approvedUnpaidCount: data.approvedUnpaid.aggregate.count,
        approvedUnpaidAmount: round(sum(data.approvedUnpaid.aggregate)),
        paidLast30Count: data.paidLast30.aggregate.count,
        paidLast30Amount: round(num(data.paidLast30.aggregate?.sum?.amount_paid)),
        rejectedCount: data.rejected.aggregate.count,
        avgDaysToPay: daysToPay.length
          ? Math.round((daysToPay.reduce((a: number, b: number) => a + b, 0) / daysToPay.length) * 10) / 10
          : 0,
      };
    },

    async invoices(
      _: unknown,
      { filter, sort, page = 1, pageSize = 25 }: any,
    ) {
      const where = buildWhere(filter);
      const orderBy = buildOrderBy(sort);
      const data = await hasura(
        `query Invoices($where: invoices_bool_exp!, $orderBy: [invoices_order_by!], $limit: Int!, $offset: Int!) {
           invoices(where: $where, order_by: $orderBy, limit: $limit, offset: $offset) { ${INVOICE_SEL} }
           invoices_aggregate(where: $where) { aggregate { count } }
         }`,
        { where, orderBy, limit: pageSize, offset: (page - 1) * pageSize },
      );
      let rows = data.invoices.map(mapInvoice);
      // amount sort is on base amount server-side; refine by amount+tax here
      if (sort?.field === "amount") {
        const s = sort.dir === "DESC" ? -1 : 1;
        rows = [...rows].sort((a: any, b: any) => s * (a.amount + a.taxAmount - b.amount - b.taxAmount));
      }
      rows = await attachPredictions(rows, data.invoices[0]?.company_id);
      return { rows, total: data.invoices_aggregate.aggregate.count, page, pageSize };
    },

    async invoice(_: unknown, { id }: { id: string }) {
      const data = await hasura(
        `query One($id: uuid!) { invoices_by_pk(id: $id) { ${INVOICE_SEL} } }`,
        { id },
      );
      if (!data.invoices_by_pk) return null;
      const [mapped] = await attachPredictions([mapInvoice(data.invoices_by_pk)], data.invoices_by_pk.company_id);
      return mapped;
    },

    async invoiceSummary(_: unknown, { id }: { id: string }) {
      return genaiService.summarizeInvoice(id, requireCompanyId());
    },

    async vendors() {
      const data = await hasura(`
        query {
          vendors(order_by: { name: asc }) {
            id name tax_id payment_terms_days email
            invoices { amount tax_amount payment_status due_date payments { paid_at } }
          }
        }
      `);
      return data.vendors.map(vendorStats);
    },

    async vendor(_: unknown, { id }: { id: string }) {
      const data = await hasura(
        `query V($id: uuid!) {
           vendors_by_pk(id: $id) {
             id name tax_id payment_terms_days
             invoices { amount tax_amount payment_status due_date payments { paid_at } }
           }
         }`,
        { id },
      );
      return data.vendors_by_pk ? vendorStats(data.vendors_by_pk) : null;
    },

    async vendorExposure(_: unknown, { vendorId }: { vendorId?: string | null }) {
      const scope = vendorId ? `(where: { id: { _eq: "${vendorId}" } })` : "";
      const data = await hasura(`
        query {
          vendors${scope} {
            id name
            invoices_aggregate(where: { payment_status: { _neq: "paid" } }) {
              aggregate { sum { amount tax_amount } }
            }
          }
        }
      `);
      return data.vendors
        .map((v: any) => ({
          vendorId: v.id,
          vendorName: v.name,
          outstanding: round(
            num(v.invoices_aggregate.aggregate.sum?.amount) +
              num(v.invoices_aggregate.aggregate.sum?.tax_amount),
          ),
        }))
        .sort((a: any, b: any) => b.outstanding - a.outstanding);
    },

    async customers() {
      const data = await hasura(`
        query {
          customers(order_by: { name: asc }) {
            id name tax_id payment_terms_days email credit_limit gstin address state
            invoices { amount tax_amount payment_status due_date payments { paid_at } }
          }
        }
      `);
      return data.customers.map(customerStats);
    },

    async customer(_: unknown, { id }: { id: string }) {
      const data = await hasura(
        `query C($id: uuid!) {
           customers_by_pk(id: $id) {
             id name tax_id payment_terms_days email credit_limit gstin address state
             invoices { amount tax_amount payment_status due_date payments { paid_at } }
           }
         }`,
        { id },
      );
      return data.customers_by_pk ? customerStats(data.customers_by_pk) : null;
    },

    async customerExposure(_: unknown, { customerId }: { customerId?: string | null }) {
      const scope = customerId ? `(where: { id: { _eq: "${customerId}" } })` : "";
      const data = await hasura(`
        query {
          customers${scope} {
            id name
            invoices_aggregate(where: { payment_status: { _neq: "paid" } }) {
              aggregate { sum { amount tax_amount } }
            }
          }
        }
      `);
      return data.customers
        .map((c: any) => ({
          customerId: c.id,
          customerName: c.name,
          outstanding: round(
            num(c.invoices_aggregate.aggregate.sum?.amount) +
              num(c.invoices_aggregate.aggregate.sum?.tax_amount),
          ),
        }))
        .sort((a: any, b: any) => b.outstanding - a.outstanding);
    },

    async inflowStats(_: unknown, { customerId }: { customerId?: string | null }) {
      const scope = customerId ? `, customer_id: { _eq: "${customerId}" }` : "";
      const today = iso(TODAY);
      const cutoff = iso(new Date(TODAY.getTime() - 30 * 86_400_000));
      const R = `direction: { _eq: "receivable" }`;
      const data = await hasura(`
        query {
          outstanding: invoices_aggregate(where: { ${R}, payment_status: { _neq: "paid" } ${scope} }) {
            aggregate { count sum { amount tax_amount } }
          }
          overdue: invoices_aggregate(where: { ${R}, payment_status: { _neq: "paid" }, due_date: { _lt: "${today}" } ${scope} }) {
            aggregate { count sum { amount tax_amount } }
          }
          draft: invoices_aggregate(where: { ${R}, collection_status: { _eq: "draft" } ${scope} }) { aggregate { count } }
          disputed: invoices_aggregate(where: { ${R}, collection_status: { _eq: "disputed" } ${scope} }) { aggregate { count } }
          collected: invoices(where: { ${R}, payment_status: { _eq: "paid" } ${scope} }, limit: 500) {
            invoice_date due_date amount tax_amount
            payments(order_by: { paid_at: asc_nulls_last }, limit: 1) { paid_at }
          }
        }
      `);
      const sum = (a: any) => num(a?.sum?.amount) + num(a?.sum?.tax_amount);
      type Collected = { toCollect: number; gross: number; recent: boolean };
      const collected: Collected[] = ((data.collected ?? []) as any[])
        .map((i: any): Collected | null => {
          const p = i.payments?.[0]?.paid_at;
          return p
            ? { toCollect: dayDiff(p, i.invoice_date), gross: num(i.amount) + num(i.tax_amount), recent: p >= cutoff }
            : null;
        })
        .filter((x): x is Collected => x != null);
      const daysToCollect = collected.map((c) => c.toCollect).filter((n: number) => n >= 0);
      const settledLast30 = collected.filter((c) => c.recent);
      const avg = (xs: number[]) =>
        xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;
      return {
        outstandingCount: data.outstanding.aggregate.count,
        outstandingAmount: round(sum(data.outstanding.aggregate)),
        overdueCount: data.overdue.aggregate.count,
        overdueAmount: round(sum(data.overdue.aggregate)),
        draftCount: data.draft.aggregate.count,
        disputedCount: data.disputed.aggregate.count,
        settledLast30Count: settledLast30.length,
        settledLast30Amount: round(settledLast30.reduce((s, c) => s + c.gross, 0)),
        avgDaysToCollect: avg(daysToCollect),
        dso: avg(daysToCollect), // ponytail: mean days-to-collect as DSO proxy
      };
    },

    async cashForecast() {
      // Predicted cash-move date = due_date + predicted_delay_days (0 if no model row).
      // delayPrediction is no longer a Hasura relationship (moved to ml-service's
      // own private ml_db) — fetch invoices, then batch-fetch predictions by id.
      const data = await hasura(`
        query {
          invoices(where: { payment_status: { _neq: "paid" } }, limit: 2000) {
            id company_id direction due_date amount tax_amount
          }
        }
      `);
      const rows = data.invoices as any[];
      const companyId = rows[0]?.company_id;
      const delays = await mlService.getDelayPredictions(companyId, rows.map((r) => r.id));
      const buckets = [
        { label: "0–7 days", max: 7 },
        { label: "8–14 days", max: 14 },
        { label: "15–30 days", max: 30 },
        { label: "30+ days", max: Infinity },
      ].map((b) => ({ label: b.label, inflow: 0, outflow: 0, net: 0 }));
      const edges = [7, 14, 30, Infinity];
      for (const row of rows) {
        const gross = num(row.amount) + num(row.tax_amount);
        const delay = num(delays[row.id]?.predicted_delay_days);
        const days = dayDiff(
          iso(new Date(new Date(row.due_date).getTime() + delay * 86_400_000)),
          iso(TODAY),
        );
        const idx = edges.findIndex((e) => days <= e);
        const b = buckets[idx < 0 ? buckets.length - 1 : idx];
        if (row.direction === "receivable") b.inflow += gross;
        else b.outflow += gross;
      }
      let netTotal = 0;
      for (const b of buckets) {
        b.inflow = round(b.inflow);
        b.outflow = round(b.outflow);
        b.net = round(b.inflow - b.outflow);
        netTotal += b.net;
      }
      return { buckets, netTotal: round(netTotal) };
    },

    async ask(_: unknown, { prompt }: { prompt: string }) {
      // /query (not /summarize) — the hybrid router: exact totals/filters go
      // through a normal DB query same as before, but a genuinely semantic
      // question ("invoices that mention a penalty clause") also searches
      // invoice_embeddings (pgvector) for meaning-based matches, not just
      // keyword filters. Falls back to a DB-only answer if embeddings are
      // unavailable (see genai-service's _safe_semantic).
      let summary = "The assistant service is unavailable right now.";
      let ids: string[] = [];
      try {
        const j = await genaiService.askAssistant(prompt, requireCompanyId());
        summary = j.answer ?? summary;
        ids = j.invoice_ids ?? [];
      } catch {
        return { text: summary, invoices: [] };
      }
      let invoices: any[] = [];
      if (ids.length) {
        const data = await hasura(
          `query Refs($ids: [uuid!]!) { invoices(where: { id: { _in: $ids } }) { ${INVOICE_SEL} } }`,
          { ids },
        );
        invoices = await attachPredictions(data.invoices.map(mapInvoice), data.invoices[0]?.company_id);
      }
      return { text: summary, invoices };
    },

    async companySettings() {
      requireRole("finance_user", "admin");
      const data = await hasura(
        `query CompanySettings($id: uuid!) { companies_by_pk(id: $id) { ${COMPANY_SEL} } }`,
        { id: requireCompanyId() },
      );
      return mapCompanySettings(data.companies_by_pk);
    },

    async mlModelStatus() {
      requireRole("admin");
      const data = await mlService.getModels(requireCompanyId());
      return { duplicate: mapMlModel(data.duplicate), delay: mapMlModel(data.delay) };
    },

    async mlDriftStatus() {
      requireRole("admin");
      const data = await mlService.getDrift(requireCompanyId());
      return [data.duplicate, data.delay].filter(Boolean).map(mapMlDriftReport);
    },

    async mlRetrainHistory(_: unknown, { limit }: { limit?: number | null }) {
      requireRole("admin");
      const data = await mlService.getRetrainHistory(requireCompanyId(), limit ?? 20);
      return data.map(mapMlRetrainEvent);
    },

    async reviewQueue(_: unknown, { status }: { status?: string | null }) {
      requireRole("finance_user", "admin");
      const data = await hasura(
        `query ReviewQueue($status: String) {
           review_queue(where: { status: { _eq: $status } }, order_by: { created_at: desc }) {
             id status issues created_at invoice_draft
           }
         }`,
        { status: status ?? "pending" },
      );
      return data.review_queue.map(mapReviewQueueItem);
    },

    async demoRequests(_: unknown, { limit }: { limit?: number | null }) {
      requireRole("super_admin");
      const data = await hasura(
        `query DemoRequests($limit: Int!) {
           demo_requests(order_by: { created_at: desc }, limit: $limit) {
             id company_name contact_name work_email company_size message created_at
           }
         }`,
        { limit: limit ?? 20 },
      );
      return data.demo_requests.map(mapDemoRequest);
    },
  },

  Mutation: {
    async approveInvoices(_: unknown, { ids }: { ids: string[] }) {
      requireRole("approver", "admin");
      const companyId = requireCompanyId();
      const data = await hasura(
        `mutation Approve($ids: [uuid!]!, $companyId: uuid!, $rows: [approvals_insert_input!]!) {
           update_invoices(
             where: { id: { _in: $ids }, company_id: { _eq: $companyId }, approval_status: { _eq: "pending" } }
             _set: { approval_status: "approved" }
           ) { returning { ${INVOICE_SEL} } }
           insert_approvals(objects: $rows) { affected_rows }
         }`,
        {
          ids,
          companyId,
          // company_id isn't a field here — the insert permission auto-fills
          // it from the session, so it's not part of approvals_insert_input.
          rows: ids.map((id) => ({
            invoice_id: id, approver: "you", level: 1, status: "approved",
            acted_at: new Date().toISOString(),
          })),
        },
      );
      return data.update_invoices.returning.map(mapInvoice);
    },

    async setApproval(
      _: unknown,
      { id, status, note }: { id: string; status: string; note?: string | null },
    ) {
      requireRole("approver", "admin");
      const s = status.toLowerCase();
      const companyId = requireCompanyId();
      const data = await hasura(
        `mutation SetApproval($id: uuid!, $companyId: uuid!, $row: [approvals_insert_input!]!, $status: String!) {
           update_invoices(where: { id: { _eq: $id }, company_id: { _eq: $companyId } }, _set: { approval_status: $status }) {
             returning { ${INVOICE_SEL} }
           }
           insert_approvals(objects: $row) { affected_rows }
         }`,
        {
          id, status: s, companyId,
          row: [{ invoice_id: id, approver: "you", level: 1, status: s, acted_at: new Date().toISOString(), }],
        },
      );
      void note;
      return mapInvoice(data.update_invoices.returning[0]);
    },

    async reviewDuplicate(
      _: unknown,
      { invoiceId, status }: { invoiceId: string; status: string },
    ) {
      requireRole("finance_user", "approver", "admin");
      const companyId = requireCompanyId();
      // duplicate_flags moved to ml-service's own private ml_db — reviewing
      // a flag is now an ml-service call, not a Hasura mutation.
      await mlService.reviewDuplicateFlag(companyId, invoiceId, status);
      const data = await hasura(
        `query One($id: uuid!) { invoices_by_pk(id: $id) { ${INVOICE_SEL} } }`,
        { id: invoiceId },
      );
      if (data.invoices_by_pk?.company_id && data.invoices_by_pk.company_id !== companyId) {
        throw new Error("Invoice not found");
      }
      if (!data.invoices_by_pk) return null;
      const [mapped] = await attachPredictions([mapInvoice(data.invoices_by_pk)], companyId);
      return mapped;
    },

    async recordPayment(
      _: unknown,
      { invoiceId, paidAt, amountPaid }: { invoiceId: string; paidAt: string; amountPaid: number },
    ) {
      requireRole("finance_user", "admin");
      const companyId = requireCompanyId();
      // A payable can only be paid once approval has cleared. A receivable has no
      // approval step — recording a receipt is always allowed. Enforced here too,
      // not just in the UI — this is a money write.
      const gate = await hasura<{
        invoices_by_pk: {
          approval_status: string;
          direction: string;
          company_id: string;
          invoice_number: string;
          customer: { name: string; email: string | null } | null;
        } | null;
      }>(
        `query PayGate($id: uuid!) {
           invoices_by_pk(id: $id) { approval_status direction company_id invoice_number customer { name email } }
         }`,
        { id: invoiceId },
      );
      if (gate.invoices_by_pk?.company_id !== companyId) throw new Error("Invoice not found");
      const isReceivable = gate.invoices_by_pk?.direction === "receivable";
      const approval = gate.invoices_by_pk?.approval_status;
      if (!isReceivable && approval !== "approved") {
        throw new Error(
          approval === "rejected"
            ? "This invoice was rejected and can't be paid."
            : "This invoice isn't approved yet — it can't be paid until approval completes.",
        );
      }
      const extra = isReceivable ? `, collection_status: "settled"` : "";
      const data = await hasura(
        `mutation Pay($p: payments_insert_input!, $id: uuid!, $companyId: uuid!) {
           insert_payments_one(object: $p) { id paid_at amount_paid }
           update_invoices(where: { id: { _eq: $id }, company_id: { _eq: $companyId } }, _set: { payment_status: "paid"${extra} }) { affected_rows }
         }`,
        {
          // company_id isn't a field here — finance_user/company_admin's
          // insert permission auto-fills it from the session (X-Hasura-Company-Id),
          // so it's not part of their payments_insert_input type at all.
          p: { invoice_id: invoiceId, paid_at: paidAt, amount_paid: amountPaid },
          id: invoiceId,
          companyId,
        },
      );
      const p = data.insert_payments_one;

      // Best-effort receipt confirmation — never blocks or fails the payment
      // itself if the email can't be sent.
      const customer = gate.invoices_by_pk?.customer;
      if (isReceivable && customer?.email) {
        void publishNotification({
          type: "payment-received",
          payload: {
            customer_email: customer.email,
            customer_name: customer.name,
            invoice_number: gate.invoices_by_pk?.invoice_number ?? "",
            amount: amountPaid,
            paid_at: paidAt,
          },
        });
      }

      return { id: p.id, paidAt: p.paid_at, amountPaid: num(p.amount_paid) };
    },

    async createInvoice(_: unknown, { input }: { input: any }) {
      requireRole("finance_user"); // invoice entry is finance_user's job, not admin's
      const companyId = requireCompanyId();
      // company_id isn't a field on the insert object — finance_user's insert
      // permission auto-fills it from the session, so it's not part of
      // invoices_insert_input for this role at all.
      const o: any = toInsert(input);
      const partyCol = o.direction === "receivable" ? "customer_id" : "vendor_id";
      const partyId = o.direction === "receivable" ? o.customer_id : o.vendor_id;
      const dup = await hasura(
        `query Dup($p: uuid!, $n: String!, $companyId: uuid!) {
           invoices(where: { ${partyCol}: { _eq: $p }, invoice_number: { _eq: $n }, company_id: { _eq: $companyId } }, limit: 1) {
             invoice_number
           }
         }`,
        { p: partyId, n: o.invoice_number, companyId },
      );
      if (dup.invoices.length > 0) {
        throw new Error(
          `Invoice "${o.invoice_number}" already exists for this ${
            o.direction === "receivable" ? "customer" : "vendor"
          } — duplicate not added.`,
        );
      }
      const data = await hasura(
        `mutation Create($o: invoices_insert_input!) { insert_invoices_one(object: $o) { ${INVOICE_SEL} } }`,
        { o },
      );
      return mapInvoice(data.insert_invoices_one);
    },

    async generateAndSendInvoice(_: unknown, { input }: { input: any }) {
      requireRole("finance_user", "admin");
      return generateAndSendInvoiceImpl(requireCompanyId(), input);
    },

    async resendInvoice(_: unknown, { id }: { id: string }) {
      requireRole("finance_user", "admin");
      return resendInvoiceImpl(requireCompanyId(), id);
    },

    async deleteInvoice(_: unknown, { id }: { id: string }) {
      requireRole("finance_user", "admin");
      const data = await hasura(
        `mutation DeleteInvoice($id: uuid!, $companyId: uuid!) {
           delete_invoices(where: { id: { _eq: $id }, company_id: { _eq: $companyId } }) {
             returning { id }
           }
         }`,
        { id, companyId: requireCompanyId() },
      );
      if (!data.delete_invoices.returning.length) throw new Error("Invoice not found");
      return true;
    },

    async createVendor(
      _: unknown,
      { name, taxId, paymentTermsDays, email }: {
        name: string;
        taxId?: string | null;
        paymentTermsDays?: number | null;
        email?: string | null;
      },
    ) {
      requireRole("finance_user", "admin");
      requireCompanyId(); // no-session guard — the insert itself needs no company_id field, see below
      const clean = String(name ?? "").trim();
      if (!clean) throw new Error("Vendor name is required");
      const data = await hasura(
        // company_id isn't a field here — the insert permission auto-fills
        // it from the session.
        `mutation AddVendor($o: vendors_insert_input!) {
           insert_vendors_one(object: $o) { id name tax_id payment_terms_days email }
         }`,
        {
          o: {
            name: clean,
            tax_id: (taxId ?? "").trim() || null,
            payment_terms_days: paymentTermsDays ?? 30,
            email: cleanEmail(email),
          },
        },
      );
      return mapVendor(data.insert_vendors_one);
    },

    updateVendorEmail: (_: unknown, a: { id: string; email?: string | null }) =>
      setPartyEmail("vendors", a),

    async createCustomer(
      _: unknown,
      { name, taxId, email, paymentTermsDays, creditLimit }: {
        name: string;
        taxId?: string | null;
        email?: string | null;
        paymentTermsDays?: number | null;
        creditLimit?: number | null;
      },
    ) {
      requireRole("finance_user", "admin");
      requireCompanyId(); // no-session guard — the insert itself needs no company_id field, see below
      const clean = String(name ?? "").trim();
      if (!clean) throw new Error("Customer name is required");
      const data = await hasura(
        // company_id isn't a field here — the insert permission auto-fills
        // it from the session.
        `mutation AddCustomer($o: customers_insert_input!) {
           insert_customers_one(object: $o) {
             id name tax_id payment_terms_days email credit_limit
           }
         }`,
        {
          o: {
            name: clean,
            tax_id: (taxId ?? "").trim() || null,
            payment_terms_days: paymentTermsDays ?? 30,
            email: cleanEmail(email),
            credit_limit: creditLimit == null ? null : Number(creditLimit),
          },
        },
      );
      return mapCustomer(data.insert_customers_one);
    },

    updateCustomerEmail: (_: unknown, a: { id: string; email?: string | null }) =>
      setPartyEmail("customers", a),

    async updateCustomerTaxDetails(
      _: unknown,
      { id, gstin, address, state }: { id: string; gstin?: string | null; address?: string | null; state?: string | null },
    ) {
      requireRole("finance_user", "admin");
      const data = await hasura(
        `mutation SetCustomerTax($id: uuid!, $companyId: uuid!, $gstin: String, $address: String, $state: String) {
           update_customers(
             where: { id: { _eq: $id }, company_id: { _eq: $companyId } }
             _set: { gstin: $gstin, address: $address, state: $state }
           ) {
             returning { id name tax_id payment_terms_days email credit_limit gstin address state }
           }
         }`,
        {
          id,
          gstin: gstin?.trim() || null,
          address: address?.trim() || null,
          state: state?.trim() || null,
          companyId: requireCompanyId(),
        },
      );
      if (!data.update_customers.returning.length) throw new Error("Customer not found");
      return mapCustomer(data.update_customers.returning[0]);
    },

    async setCollectionStatus(
      _: unknown,
      { id, status }: { id: string; status: string },
    ) {
      requireRole("finance_user", "admin");
      const s = String(status).toLowerCase();
      if (!["draft", "sent", "disputed", "settled"].includes(s))
        throw new Error(`Unknown collection status: ${status}`);
      const data = await hasura(
        `mutation SetColl($id: uuid!, $companyId: uuid!, $s: String!) {
           update_invoices(
             where: { id: { _eq: $id }, company_id: { _eq: $companyId }, direction: { _eq: "receivable" } }
             _set: { collection_status: $s }
           ) { returning { ${INVOICE_SEL} } }
         }`,
        { id, s, companyId: requireCompanyId() },
      );
      const row = data.update_invoices.returning[0];
      if (!row) throw new Error("Receivable not found");
      return mapInvoice(row);
    },

    async updateCompanySettings(
      _: unknown,
      { name, aliases, digestEmails }: { name: string; aliases: string[]; digestEmails?: string[] | null },
    ) {
      requireRole("admin");
      const clean = String(name ?? "").trim();
      const cleanAliases = (aliases ?? []).map((a) => String(a).trim()).filter(Boolean);
      const set: Record<string, unknown> = { name: clean, aliases: cleanAliases };
      if (digestEmails) {
        const emails = digestEmails.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
        const bad = emails.find((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
        if (bad) throw new Error(`"${bad}" is not a valid email address`);
        set.digest_emails = emails;
      }
      const data = await hasura(
        `mutation SetCompany($id: uuid!, $set: companies_set_input!) {
           update_companies_by_pk(pk_columns: { id: $id }, _set: $set) {
             ${COMPANY_SEL}
           }
         }`,
        { id: requireCompanyId(), set },
      );
      return mapCompanySettings(data.update_companies_by_pk);
    },

    async saveCompanySignature(_: unknown, { dataUrl }: { dataUrl: string }) {
      requireRole("finance_user", "admin");
      if (!safeImageSrc(dataUrl)) {
        throw new Error("Signature must be an image data URL under 2MB");
      }
      const data = await hasura(
        `mutation SetSignature($id: uuid!, $url: String!) {
           update_companies_by_pk(pk_columns: { id: $id }, _set: { signature_data_url: $url }) {
             ${COMPANY_SEL}
           }
         }`,
        { id: requireCompanyId(), url: dataUrl },
      );
      return mapCompanySettings(data.update_companies_by_pk);
    },

    async saveCompanyLogo(_: unknown, { dataUrl }: { dataUrl: string }) {
      requireRole("finance_user", "admin");
      if (!safeImageSrc(dataUrl)) {
        throw new Error("Logo must be an image data URL under 2MB");
      }
      const data = await hasura(
        `mutation SetLogo($id: uuid!, $url: String!) {
           update_companies_by_pk(pk_columns: { id: $id }, _set: { logo_data_url: $url }) {
             ${COMPANY_SEL}
           }
         }`,
        { id: requireCompanyId(), url: dataUrl },
      );
      return mapCompanySettings(data.update_companies_by_pk);
    },

    async updateCompanyTaxDetails(
      _: unknown,
      args: {
        gstin?: string | null;
        pan?: string | null;
        address?: string | null;
        state?: string | null;
        bankAccountName?: string | null;
        bankName?: string | null;
        bankAccountNumber?: string | null;
        bankIfsc?: string | null;
        bankSwift?: string | null;
      },
    ) {
      requireRole("finance_user", "admin");
      const clean = (v?: string | null) => (v?.trim() ? v.trim() : null);
      const data = await hasura(
        `mutation SetCompanyTax(
           $id: uuid!, $gstin: String, $pan: String, $address: String, $state: String,
           $bankAccountName: String, $bankName: String, $bankAccountNumber: String, $bankIfsc: String, $bankSwift: String
         ) {
           update_companies_by_pk(
             pk_columns: { id: $id }
             _set: {
               gstin: $gstin, pan: $pan, address: $address, state: $state,
               bank_account_name: $bankAccountName, bank_name: $bankName,
               bank_account_number: $bankAccountNumber, bank_ifsc: $bankIfsc, bank_swift: $bankSwift
             }
           ) { ${COMPANY_SEL} }
         }`,
        {
          id: requireCompanyId(),
          gstin: clean(args.gstin),
          pan: clean(args.pan),
          address: clean(args.address),
          state: clean(args.state),
          bankAccountName: clean(args.bankAccountName),
          bankName: clean(args.bankName),
          bankAccountNumber: clean(args.bankAccountNumber),
          bankIfsc: clean(args.bankIfsc),
          bankSwift: clean(args.bankSwift),
        },
      );
      return mapCompanySettings(data.update_companies_by_pk);
    },

    async setReviewQueueStatus(_: unknown, { id, status }: { id: string; status: string }) {
      requireRole("finance_user", "admin");
      // review_queue's update_permission for finance_user only grants the
      // `status` column — Hasura's own perms are enough, no admin secret.
      const data = await hasura(
        `mutation SetReviewQueueStatus($id: uuid!, $status: String!) {
           update_review_queue_by_pk(pk_columns: { id: $id }, _set: { status: $status }) {
             id status issues created_at invoice_draft
           }
         }`,
        { id, status },
      );
      return mapReviewQueueItem(data.update_review_queue_by_pk);
    },

    async triggerDriftCheck() {
      requireRole("admin");
      const data = await mlService.checkDrift(requireCompanyId());
      return [data.duplicate, data.delay].filter(Boolean).map(mapMlDriftReport);
    },

    async triggerModelRetrain(_: unknown, { modelName }: { modelName: string }) {
      requireRole("admin");
      const companyId = requireCompanyId();
      const result = await mlService.retrain(companyId, modelName);
      const [latest] = await mlService.getRetrainHistory(companyId, 1);
      return latest
        ? mapMlRetrainEvent(latest)
        : {
            id: result.event_id ?? "unknown",
            modelName,
            triggeredBy: "manual",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            status: result.status,
            oldVersion: null,
            newVersion: result.version ?? null,
            oldMetrics: null,
            newMetrics: null,
            error: result.detail ?? null,
          };
    },

    async deleteDemoRequest(_: unknown, { id }: { id: string }) {
      requireRole("super_admin");
      const data = await hasura(
        `mutation DeleteDemoRequest($id: uuid!) { delete_demo_requests_by_pk(id: $id) { id } }`,
        { id },
      );
      return Boolean(data.delete_demo_requests_by_pk);
    },

    async importInvoices(_: unknown, { rows }: { rows: any[] }) {
      requireRole("finance_user"); // invoice import is finance_user's job, not admin's
      return importInvoicesRows(requireCompanyId(), rows);
    },
  },
};

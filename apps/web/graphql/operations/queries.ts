import { graphql } from "../generated";

export const DashboardStatsQuery = graphql(`
  query DashboardStats($vendorId: ID) {
    dashboardStats(vendorId: $vendorId) {
      pendingCount
      pendingAmount
      overdueCount
      overdueAmount
      vendorExposureTotal
      approvedUnpaidCount
      approvedUnpaidAmount
      paidLast30Count
      paidLast30Amount
      rejectedCount
      avgDaysToPay
    }
  }
`);

export const CompanySettingsQuery = graphql(`
  query CompanySettings {
    companySettings {
      name
      aliases
      digestEmails
      signatureDataUrl
      logoDataUrl
      gstin
      pan
      address
      state
      bankAccountName
      bankName
      bankAccountNumber
      bankIfsc
      bankSwift
    }
  }
`);

export const MlModelStatusQuery = graphql(`
  query MlModelStatus {
    mlModelStatus {
      duplicate {
        status
        method
        modelVersion
        trainedAt
        nRows
        featureCount
        threshold
        metrics {
          rocAuc
          accuracy
          precision
          recall
        }
      }
      delay {
        status
        method
        modelVersion
        trainedAt
        nRows
        featureCount
        metrics {
          rocAuc
          accuracy
          precision
          recall
          maeDays
          r2
        }
      }
    }
  }
`);

export const MlDriftStatusQuery = graphql(`
  query MlDriftStatus {
    mlDriftStatus {
      modelName
      checkedAt
      driftDetected
      featurePsiJson
      rollingMetricsJson
      baselineMetricsJson
      notes
    }
  }
`);

export const MlRetrainHistoryQuery = graphql(`
  query MlRetrainHistory($limit: Int) {
    mlRetrainHistory(limit: $limit) {
      id
      modelName
      triggeredBy
      startedAt
      finishedAt
      status
      oldVersion
      newVersion
      oldMetrics {
        rocAuc
        accuracy
        precision
        recall
        maeDays
        r2
      }
      newMetrics {
        rocAuc
        accuracy
        precision
        recall
        maeDays
        r2
      }
      error
    }
  }
`);

export const DemoRequestsQuery = graphql(`
  query DemoRequests($limit: Int) {
    demoRequests(limit: $limit) {
      id
      companyName
      contactName
      workEmail
      companySize
      message
      createdAt
    }
  }
`);

export const ReviewQueueQuery = graphql(`
  query ReviewQueue($status: String) {
    reviewQueue(status: $status) {
      id
      status
      issues
      createdAt
      filename
      direction
      counterpartyName
      extractedFieldsJson
      sourceMapJson
      fullText
    }
  }
`);

export const VendorExposureQuery = graphql(`
  query VendorExposure($vendorId: ID) {
    vendorExposure(vendorId: $vendorId) {
      vendorId
      vendorName
      outstanding
    }
  }
`);

export const InvoicesQuery = graphql(`
  query Invoices($filter: InvoiceFilter, $sort: InvoiceSort, $page: Int, $pageSize: Int) {
    invoices(filter: $filter, sort: $sort, page: $page, pageSize: $pageSize) {
      total
      page
      pageSize
      rows {
        ...InvoiceRowFields
      }
    }
  }
`);

export const InvoiceDetailQuery = graphql(`
  query InvoiceDetail($id: ID!) {
    invoice(id: $id) {
      ...InvoiceRowFields
      description
      template
      vendor {
        id
        name
        taxId
        paymentTermsDays
      }
      customer {
        id
        name
        taxId
        email
        paymentTermsDays
        creditLimit
      }
      purchaseOrder {
        id
        poNumber
        amount
        status
        department
      }
      duplicateFlag {
        matchedInvoiceId
        confidenceScore
        reviewedStatus
        reason
        explanation {
          feature
          label
          value
          contribution
          direction
        }
        matchedInvoice {
          id
          invoiceNumber
          amount
          taxAmount
          invoiceDate
          vendor {
            name
          }
        }
      }
      delayPrediction {
        delayProbability
        predictedDelayDays
        modelVersion
        explanation {
          feature
          label
          value
          contribution
          direction
        }
      }
      approvalEvents {
        id
        actor
        action
        note
        at
      }
      payments {
        id
        paidAt
        amountPaid
      }
    }
  }
`);

export const InvoiceSummaryQuery = graphql(`
  query InvoiceSummary($id: ID!) {
    invoiceSummary(id: $id)
  }
`);

export const VendorsQuery = graphql(`
  query Vendors {
    vendors {
      vendor {
        id
        name
        taxId
        paymentTermsDays
        email
      }
      totalInvoices
      totalExposure
      avgDelayDays
      onTimePct
    }
  }
`);

export const VendorDetailQuery = graphql(`
  query VendorDetail($id: ID!) {
    vendor(id: $id) {
      vendor {
        id
        name
        taxId
        paymentTermsDays
        email
      }
      totalInvoices
      totalExposure
      avgDelayDays
      onTimePct
    }
  }
`);

export const CustomersQuery = graphql(`
  query Customers {
    customers {
      customer {
        id
        name
        taxId
        email
        paymentTermsDays
        creditLimit
        gstin
        address
        state
      }
      totalInvoices
      totalExposure
      avgDelayDays
      onTimePct
    }
  }
`);

export const CustomerDetailQuery = graphql(`
  query CustomerDetail($id: ID!) {
    customer(id: $id) {
      customer {
        id
        name
        taxId
        email
        paymentTermsDays
        creditLimit
        gstin
        address
        state
      }
      totalInvoices
      totalExposure
      avgDelayDays
      onTimePct
    }
  }
`);

export const InflowStatsQuery = graphql(`
  query InflowStats($customerId: ID) {
    inflowStats(customerId: $customerId) {
      outstandingCount
      outstandingAmount
      overdueCount
      overdueAmount
      draftCount
      disputedCount
      settledLast30Count
      settledLast30Amount
      avgDaysToCollect
      dso
    }
  }
`);

export const CashForecastQuery = graphql(`
  query CashForecast {
    cashForecast {
      netTotal
      buckets {
        label
        inflow
        outflow
        net
      }
    }
  }
`);

export const AskQuery = graphql(`
  query Ask($prompt: String!) {
    ask(prompt: $prompt) {
      text
      invoices {
        ...InvoiceRowFields
      }
    }
  }
`);

import { graphql } from "../generated";

export const ApproveInvoicesMutation = graphql(`
  mutation ApproveInvoices($ids: [ID!]!) {
    approveInvoices(ids: $ids) {
      id
      approvalStatus
    }
  }
`);

export const SetApprovalMutation = graphql(`
  mutation SetApproval($id: ID!, $status: ApprovalStatus!, $note: String) {
    setApproval(id: $id, status: $status, note: $note) {
      id
      approvalStatus
    }
  }
`);

export const ReviewDuplicateMutation = graphql(`
  mutation ReviewDuplicate($invoiceId: ID!, $status: String!) {
    reviewDuplicate(invoiceId: $invoiceId, status: $status) {
      id
      duplicateFlag {
        reviewedStatus
      }
    }
  }
`);

export const RecordPaymentMutation = graphql(`
  mutation RecordPayment($invoiceId: ID!, $paidAt: String!, $amountPaid: Float!) {
    recordPayment(invoiceId: $invoiceId, paidAt: $paidAt, amountPaid: $amountPaid) {
      id
      paidAt
      amountPaid
    }
  }
`);

export const CreateInvoiceMutation = graphql(`
  mutation CreateInvoice($input: InvoiceInput!) {
    createInvoice(input: $input) {
      id
      invoiceNumber
    }
  }
`);

export const DeleteInvoiceMutation = graphql(`
  mutation DeleteInvoice($id: ID!) {
    deleteInvoice(id: $id)
  }
`);

export const SetReviewQueueStatusMutation = graphql(`
  mutation SetReviewQueueStatus($id: ID!, $status: String!) {
    setReviewQueueStatus(id: $id, status: $status) {
      id
      status
    }
  }
`);

export const TriggerDriftCheckMutation = graphql(`
  mutation TriggerDriftCheck {
    triggerDriftCheck {
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

export const TriggerModelRetrainMutation = graphql(`
  mutation TriggerModelRetrain($modelName: String!) {
    triggerModelRetrain(modelName: $modelName) {
      id
      modelName
      triggeredBy
      startedAt
      finishedAt
      status
      oldVersion
      newVersion
      error
    }
  }
`);

export const UpdateCompanySettingsMutation = graphql(`
  mutation UpdateCompanySettings($name: String!, $aliases: [String!]!, $digestEmails: [String!]) {
    updateCompanySettings(name: $name, aliases: $aliases, digestEmails: $digestEmails) {
      name
      aliases
      digestEmails
    }
  }
`);

export const SaveCompanySignatureMutation = graphql(`
  mutation SaveCompanySignature($dataUrl: String!) {
    saveCompanySignature(dataUrl: $dataUrl) {
      signatureDataUrl
    }
  }
`);

export const SaveCompanyLogoMutation = graphql(`
  mutation SaveCompanyLogo($dataUrl: String!) {
    saveCompanyLogo(dataUrl: $dataUrl) {
      logoDataUrl
    }
  }
`);

export const UpdateCompanyTaxDetailsMutation = graphql(`
  mutation UpdateCompanyTaxDetails(
    $gstin: String
    $pan: String
    $address: String
    $state: String
    $bankAccountName: String
    $bankName: String
    $bankAccountNumber: String
    $bankIfsc: String
    $bankSwift: String
  ) {
    updateCompanyTaxDetails(
      gstin: $gstin
      pan: $pan
      address: $address
      state: $state
      bankAccountName: $bankAccountName
      bankName: $bankName
      bankAccountNumber: $bankAccountNumber
      bankIfsc: $bankIfsc
      bankSwift: $bankSwift
    ) {
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

export const GenerateAndSendInvoiceMutation = graphql(`
  mutation GenerateAndSendInvoice($input: GenerateInvoiceInput!) {
    generateAndSendInvoice(input: $input) {
      id
      invoiceNumber
    }
  }
`);

export const ResendInvoiceMutation = graphql(`
  mutation ResendInvoice($id: ID!) {
    resendInvoice(id: $id)
  }
`);

export const CreateVendorMutation = graphql(`
  mutation CreateVendor(
    $name: String!
    $taxId: String
    $paymentTermsDays: Int
    $email: String
  ) {
    createVendor(
      name: $name
      taxId: $taxId
      paymentTermsDays: $paymentTermsDays
      email: $email
    ) {
      id
      name
      email
    }
  }
`);

export const UpdateVendorEmailMutation = graphql(`
  mutation UpdateVendorEmail($id: ID!, $email: String) {
    updateVendorEmail(id: $id, email: $email) {
      id
      email
    }
  }
`);

export const CreateCustomerMutation = graphql(`
  mutation CreateCustomer(
    $name: String!
    $taxId: String
    $email: String
    $paymentTermsDays: Int
    $creditLimit: Float
  ) {
    createCustomer(
      name: $name
      taxId: $taxId
      email: $email
      paymentTermsDays: $paymentTermsDays
      creditLimit: $creditLimit
    ) {
      id
      name
      email
    }
  }
`);

export const UpdateCustomerEmailMutation = graphql(`
  mutation UpdateCustomerEmail($id: ID!, $email: String) {
    updateCustomerEmail(id: $id, email: $email) {
      id
      email
    }
  }
`);

export const UpdateCustomerTaxDetailsMutation = graphql(`
  mutation UpdateCustomerTaxDetails($id: ID!, $gstin: String, $address: String, $state: String) {
    updateCustomerTaxDetails(id: $id, gstin: $gstin, address: $address, state: $state) {
      id
      gstin
      address
      state
    }
  }
`);

export const SetCollectionStatusMutation = graphql(`
  mutation SetCollectionStatus($id: ID!, $status: CollectionStatus!) {
    setCollectionStatus(id: $id, status: $status) {
      id
      collectionStatus
    }
  }
`);

export const DeleteDemoRequestMutation = graphql(`
  mutation DeleteDemoRequest($id: ID!) {
    deleteDemoRequest(id: $id)
  }
`);

export const ImportInvoicesMutation = graphql(`
  mutation ImportInvoices($rows: [InvoiceInput!]!) {
    importInvoices(rows: $rows) {
      created
      failed
      errors {
        row
        message
      }
    }
  }
`);

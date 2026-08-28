// Declarative Xero tool registry exposed over MCP.
//
// Every tool ultimately becomes one Xero REST call. Read tools share a common
// set of list parameters (where / order / page / modifiedSince); write tools
// take a typed payload that is wrapped in the collection envelope Xero expects.

import * as store from './store.js';
import { api, fetchConnections, getAccessToken, XeroError } from './xero.js';

const TENANT = {
  tenantId: {
    type: 'string',
    description:
      'Xero organisation to act on. Optional — defaults to the organisation set on the dashboard. Accepts a tenantId or an exact organisation name.',
  },
};

function listSchema(extra = {}, { paged = true } = {}) {
  return {
    type: 'object',
    properties: {
      where: {
        type: 'string',
        description:
          'Xero where-filter, e.g. Status=="AUTHORISED" or Date>=DateTime(2026,07,01). Combine with AND/OR.',
      },
      order: { type: 'string', description: 'Sort expression, e.g. "Date DESC".' },
      ...(paged
        ? {
            page: { type: 'integer', description: 'Page number, 100 records per page.' },
            pageSize: { type: 'integer', description: 'Records per page (max 1000 on supported endpoints).' },
          }
        : {}),
      modifiedSince: {
        type: 'string',
        description: 'ISO 8601 timestamp. Only return records created or changed since then.',
      },
      ...extra,
      ...TENANT,
    },
    additionalProperties: false,
  };
}

function objectSchema(properties, required = []) {
  return {
    type: 'object',
    properties: { ...properties, ...TENANT },
    required,
    additionalProperties: false,
  };
}

const PAYROLL_REGION = {
  region: {
    type: 'string',
    enum: ['uk', 'nz', 'au'],
    description:
      'Payroll region. UK/NZ use the Payroll API v2, AU uses v1. Defaults to uk.',
  },
};

function payrollPath(region, resource) {
  return String(region || 'uk').toLowerCase() === 'au'
    ? `payroll.xro/1.0/${resource}`
    : `payroll.xro/2.0/${resource}`;
}

/** Shared handler for the standard "list a collection" shape. */
function listHandler(resource, { extraQuery = [], paged = true } = {}) {
  return async (args) => {
    const query = {
      where: args.where,
      order: args.order,
      ...(paged ? { page: args.page, pageSize: args.pageSize } : {}),
    };
    for (const key of extraQuery) {
      if (args[key] !== undefined) query[key] = Array.isArray(args[key]) ? args[key].join(',') : args[key];
    }
    return api({
      path: resource,
      query,
      tenantId: args.tenantId,
      headers: args.modifiedSince ? { 'If-Modified-Since': args.modifiedSince } : {},
    });
  };
}

/** Shared handler for reports under /Reports/{name}. */
function reportHandler(name, keys) {
  return async (args) => {
    const query = {};
    for (const key of keys) if (args[key] !== undefined) query[key] = args[key];
    return api({ path: `Reports/${name}`, query, tenantId: args.tenantId });
  };
}

/** Shared handler for POST/PUT of a Xero collection, e.g. { Invoices: [...] }. */
function writeHandler(resource, envelope, { method = 'POST', pathSuffix = null } = {}) {
  return async (args) => {
    const items = Array.isArray(args.records) ? args.records : [args.records];
    const path = pathSuffix ? `${resource}/${args[pathSuffix]}` : resource;
    return api({
      method,
      path,
      body: { [envelope]: items },
      query: { summarizeErrors: 'false', unitdp: args.unitdp },
      tenantId: args.tenantId,
    });
  };
}

function recordsSchema(description, extra = {}) {
  return objectSchema(
    {
      records: {
        description,
        oneOf: [{ type: 'object' }, { type: 'array', items: { type: 'object' } }],
      },
      unitdp: {
        type: 'integer',
        description: 'Set to 4 to allow 4 decimal places on unit amounts.',
      },
      ...extra,
    },
    ['records'],
  );
}

export const tools = [
  // ------------------------------------------------------------- connection
  {
    name: 'xero_list_tenants',
    title: 'List connected Xero organisations',
    description:
      'List the Xero organisations this connector is authorised for, and which one is the default. Use this first if you are unsure which organisation you are working in.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const accessToken = await getAccessToken();
      const tenants = await fetchConnections(accessToken);
      const state = await store.read();
      await store.update((s) => {
        s.tenants = tenants;
        if (!tenants.some((t) => t.tenantId === s.defaultTenantId)) {
          s.defaultTenantId = tenants[0]?.tenantId || null;
        }
        return s;
      });
      return { defaultTenantId: state.defaultTenantId, tenants };
    },
  },
  {
    name: 'xero_set_default_tenant',
    title: 'Set the default Xero organisation',
    description: 'Choose which connected Xero organisation tools use when no tenantId is supplied.',
    inputSchema: {
      type: 'object',
      properties: { tenantId: { type: 'string', description: 'tenantId or exact organisation name.' } },
      required: ['tenantId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const state = await store.read();
      const match = state.tenants.find(
        (t) => t.tenantId === args.tenantId || t.tenantName?.toLowerCase() === args.tenantId.toLowerCase(),
      );
      if (!match) {
        throw new XeroError(
          `Not a connected organisation. Available: ${state.tenants.map((t) => t.tenantName).join(', ') || 'none'}`,
        );
      }
      await store.update((s) => {
        s.defaultTenantId = match.tenantId;
        return s;
      });
      return { defaultTenantId: match.tenantId, tenantName: match.tenantName };
    },
  },
  {
    name: 'xero_get_organisation',
    title: 'Get organisation details',
    description:
      'Organisation profile: legal/trading name, country, base currency, financial year end, GST/VAT settings, timezone, edition.',
    inputSchema: objectSchema({}),
    handler: (args) => api({ path: 'Organisation', tenantId: args.tenantId }),
  },

  // ------------------------------------------------------------ chart / setup
  {
    name: 'xero_list_accounts',
    title: 'List accounts (chart of accounts)',
    description:
      'The chart of accounts, with account code, name, type, tax type, and whether each account is enabled for payments or bank feeds.',
    inputSchema: listSchema({}, { paged: false }),
    handler: listHandler('Accounts', { paged: false }),
  },
  {
    name: 'xero_create_accounts',
    title: 'Create accounts',
    description: 'Add one or more accounts to the chart of accounts.',
    inputSchema: recordsSchema(
      'Account object(s). Typical fields: Code, Name, Type (e.g. EXPENSE, REVENUE, CURRLIAB), TaxType, Description, EnablePaymentsToAccount.',
    ),
    handler: writeHandler('Accounts', 'Accounts', { method: 'PUT' }),
  },
  {
    name: 'xero_update_account',
    title: 'Update an account',
    description: 'Update an existing account. Supply AccountID inside the record.',
    inputSchema: recordsSchema('Account object including AccountID and the fields to change.'),
    handler: writeHandler('Accounts', 'Accounts'),
  },
  {
    name: 'xero_list_tax_rates',
    title: 'List tax rates',
    description: 'Tax rates available in the organisation, with their TaxType codes, effective rates and components.',
    inputSchema: listSchema({}, { paged: false }),
    handler: listHandler('TaxRates', { paged: false }),
  },
  {
    name: 'xero_list_currencies',
    title: 'List currencies',
    description: 'Currencies enabled for the organisation.',
    inputSchema: listSchema({}, { paged: false }),
    handler: listHandler('Currencies', { paged: false }),
  },
  {
    name: 'xero_list_tracking_categories',
    title: 'List tracking categories',
    description: 'Tracking categories and their options (Xero\'s equivalent of classes/departments/programs).',
    inputSchema: listSchema({ includeArchived: { type: 'boolean' } }, { paged: false }),
    handler: listHandler('TrackingCategories', { extraQuery: ['includeArchived'], paged: false }),
  },
  {
    name: 'xero_create_tracking_category',
    title: 'Create a tracking category',
    description: 'Create a new tracking category.',
    inputSchema: recordsSchema('TrackingCategory object(s), e.g. { "Name": "Program" }.'),
    handler: writeHandler('TrackingCategories', 'TrackingCategories', { method: 'PUT' }),
  },
  {
    name: 'xero_create_tracking_options',
    title: 'Create tracking options',
    description: 'Add options to an existing tracking category.',
    inputSchema: objectSchema(
      {
        trackingCategoryID: { type: 'string' },
        records: {
          description: 'TrackingOption object(s), e.g. { "Name": "Program A" }.',
          oneOf: [{ type: 'object' }, { type: 'array', items: { type: 'object' } }],
        },
      },
      ['trackingCategoryID', 'records'],
    ),
    handler: (args) =>
      api({
        method: 'PUT',
        path: `TrackingCategories/${args.trackingCategoryID}/Options`,
        body: { Options: Array.isArray(args.records) ? args.records : [args.records] },
        tenantId: args.tenantId,
      }),
  },
  {
    name: 'xero_list_branding_themes',
    title: 'List branding themes',
    description: 'Invoice/quote branding themes, needed when creating documents against a specific theme.',
    inputSchema: objectSchema({}),
    handler: (args) => api({ path: 'BrandingThemes', tenantId: args.tenantId }),
  },
  {
    name: 'xero_list_users',
    title: 'List organisation users',
    description: 'Users with access to the Xero organisation and their roles.',
    inputSchema: listSchema({}, { paged: false }),
    handler: listHandler('Users', { paged: false }),
  },

  // ----------------------------------------------------------------- contacts
  {
    name: 'xero_list_contacts',
    title: 'List contacts',
    description:
      'Customers and suppliers. Filter with where, or use searchTerm for a fuzzy name/email match. Set summaryOnly for a fast, lighter response.',
    inputSchema: listSchema({
      ids: { type: 'array', items: { type: 'string' }, description: 'Specific ContactIDs.' },
      searchTerm: { type: 'string', description: 'Fuzzy match on name, email, or account number.' },
      summaryOnly: { type: 'boolean', description: 'Faster, lighter response without nested detail.' },
      includeArchived: { type: 'boolean' },
    }),
    handler: listHandler('Contacts', {
      extraQuery: ['ids', 'searchTerm', 'summaryOnly', 'includeArchived'],
    }),
  },
  {
    name: 'xero_get_contact',
    title: 'Get one contact',
    description: 'Full detail for a single contact, including addresses, phones, payment terms and balances.',
    inputSchema: objectSchema(
      { contactId: { type: 'string', description: 'ContactID or ContactNumber.' } },
      ['contactId'],
    ),
    handler: (args) => api({ path: `Contacts/${args.contactId}`, tenantId: args.tenantId }),
  },
  {
    name: 'xero_create_contacts',
    title: 'Create contacts',
    description: 'Create one or more contacts.',
    inputSchema: recordsSchema(
      'Contact object(s). Typical fields: Name (required, must be unique), FirstName, LastName, EmailAddress, Addresses, Phones, TaxNumber, AccountNumber, IsCustomer, IsSupplier, DefaultCurrency, PaymentTerms.',
    ),
    handler: writeHandler('Contacts', 'Contacts', { method: 'PUT' }),
  },
  {
    name: 'xero_update_contact',
    title: 'Update contacts',
    description: 'Update existing contacts. Supply ContactID in each record.',
    inputSchema: recordsSchema('Contact object(s) including ContactID and the fields to change.'),
    handler: writeHandler('Contacts', 'Contacts'),
  },
  {
    name: 'xero_list_contact_groups',
    title: 'List contact groups',
    description: 'Contact groups and their members.',
    inputSchema: objectSchema({}),
    handler: (args) => api({ path: 'ContactGroups', tenantId: args.tenantId }),
  },

  // ----------------------------------------------------------------- invoices
  {
    name: 'xero_list_invoices',
    title: 'List invoices and bills',
    description:
      'Sales invoices (Type ACCREC) and bills (Type ACCPAY). Use statuses/contactIDs for common filters, or where for anything else. summaryOnly gives a much faster response without line items.',
    inputSchema: listSchema({
      ids: { type: 'array', items: { type: 'string' } },
      invoiceNumbers: { type: 'array', items: { type: 'string' } },
      contactIDs: { type: 'array', items: { type: 'string' } },
      statuses: {
        type: 'array',
        items: { type: 'string', enum: ['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID', 'VOIDED', 'DELETED'] },
      },
      summaryOnly: { type: 'boolean' },
      createdByMyApp: { type: 'boolean' },
    }),
    handler: listHandler('Invoices', {
      extraQuery: ['ids', 'invoiceNumbers', 'contactIDs', 'statuses', 'summaryOnly', 'createdByMyApp'],
    }),
  },
  {
    name: 'xero_get_invoice',
    title: 'Get one invoice',
    description: 'Full detail for a single invoice or bill, including line items, payments and allocations.',
    inputSchema: objectSchema(
      { invoiceId: { type: 'string', description: 'InvoiceID or InvoiceNumber.' } },
      ['invoiceId'],
    ),
    handler: (args) => api({ path: `Invoices/${args.invoiceId}`, tenantId: args.tenantId }),
  },
  {
    name: 'xero_create_invoices',
    title: 'Create invoices or bills',
    description:
      'Create sales invoices or bills. Set Type to ACCREC for a sales invoice or ACCPAY for a bill. Status DRAFT, SUBMITTED or AUTHORISED.',
    inputSchema: recordsSchema(
      'Invoice object(s). Typical fields: Type, Contact:{ContactID or Name}, Date, DueDate, LineAmountTypes (Exclusive/Inclusive/NoTax), Reference, Status, CurrencyCode, LineItems:[{Description, Quantity, UnitAmount, AccountCode, TaxType, ItemCode, Tracking}].',
    ),
    handler: writeHandler('Invoices', 'Invoices', { method: 'PUT' }),
  },
  {
    name: 'xero_update_invoice',
    title: 'Update, approve or void an invoice',
    description:
      'Update existing invoices. Supply InvoiceID in each record. Change Status to AUTHORISED to approve, VOIDED to void, or DELETED to delete a draft.',
    inputSchema: recordsSchema('Invoice object(s) including InvoiceID and the fields to change.'),
    handler: writeHandler('Invoices', 'Invoices'),
  },
  {
    name: 'xero_email_invoice',
    title: 'Email an invoice',
    description: 'Send an approved invoice to the contact using the organisation\'s default template.',
    inputSchema: objectSchema({ invoiceId: { type: 'string' } }, ['invoiceId']),
    handler: (args) =>
      api({ method: 'POST', path: `Invoices/${args.invoiceId}/Email`, body: {}, tenantId: args.tenantId }),
  },
  {
    name: 'xero_list_repeating_invoices',
    title: 'List repeating invoice templates',
    description: 'Repeating invoice templates and their schedules.',
    inputSchema: listSchema({}, { paged: false }),
    handler: listHandler('RepeatingInvoices', { paged: false }),
  },

  // ------------------------------------------------------------- credit notes
  {
    name: 'xero_list_credit_notes',
    title: 'List credit notes',
    description: 'Credit notes for both sales (ACCRECCREDIT) and purchases (ACCPAYCREDIT).',
    inputSchema: listSchema({ statuses: { type: 'array', items: { type: 'string' } } }),
    handler: listHandler('CreditNotes', { extraQuery: ['statuses'] }),
  },
  {
    name: 'xero_create_credit_notes',
    title: 'Create credit notes',
    description: 'Create credit notes. Type ACCRECCREDIT (sales) or ACCPAYCREDIT (purchases).',
    inputSchema: recordsSchema(
      'CreditNote object(s). Typical fields: Type, Contact, Date, LineAmountTypes, Status, LineItems.',
    ),
    handler: writeHandler('CreditNotes', 'CreditNotes', { method: 'PUT' }),
  },
  {
    name: 'xero_update_credit_note',
    title: 'Update a credit note',
    description: 'Update existing credit notes. Supply CreditNoteID in each record.',
    inputSchema: recordsSchema('CreditNote object(s) including CreditNoteID.'),
    handler: writeHandler('CreditNotes', 'CreditNotes'),
  },
  {
    name: 'xero_allocate_credit_note',
    title: 'Allocate a credit note to an invoice',
    description: 'Apply all or part of a credit note against an invoice.',
    inputSchema: objectSchema(
      {
        creditNoteId: { type: 'string' },
        records: {
          description: 'Allocation object(s): { Invoice: { InvoiceID }, Amount, Date }.',
          oneOf: [{ type: 'object' }, { type: 'array', items: { type: 'object' } }],
        },
      },
      ['creditNoteId', 'records'],
    ),
    handler: (args) =>
      api({
        method: 'PUT',
        path: `CreditNotes/${args.creditNoteId}/Allocations`,
        body: { Allocations: Array.isArray(args.records) ? args.records : [args.records] },
        tenantId: args.tenantId,
      }),
  },

  // ------------------------------------------------------------------ banking
  {
    name: 'xero_list_bank_transactions',
    title: 'List bank transactions',
    description: 'Spend money / receive money transactions on bank accounts.',
    inputSchema: listSchema({}),
    handler: listHandler('BankTransactions'),
  },
  {
    name: 'xero_get_bank_transaction',
    title: 'Get one bank transaction',
    description: 'Full detail for a single bank transaction, including line items and tracking.',
    inputSchema: objectSchema({ bankTransactionId: { type: 'string' } }, ['bankTransactionId']),
    handler: (args) => api({ path: `BankTransactions/${args.bankTransactionId}`, tenantId: args.tenantId }),
  },
  {
    name: 'xero_create_bank_transactions',
    title: 'Create bank transactions',
    description: 'Create spend money (SPEND) or receive money (RECEIVE) transactions.',
    inputSchema: recordsSchema(
      'BankTransaction object(s). Typical fields: Type (SPEND/RECEIVE), Contact, BankAccount:{Code or AccountID}, Date, Reference, LineAmountTypes, LineItems:[{Description, Quantity, UnitAmount, AccountCode, TaxType, Tracking}].',
    ),
    handler: writeHandler('BankTransactions', 'BankTransactions', { method: 'PUT' }),
  },
  {
    name: 'xero_update_bank_transaction',
    title: 'Update a bank transaction',
    description: 'Update existing bank transactions. Supply BankTransactionID in each record.',
    inputSchema: recordsSchema('BankTransaction object(s) including BankTransactionID.'),
    handler: writeHandler('BankTransactions', 'BankTransactions'),
  },
  {
    name: 'xero_list_bank_transfers',
    title: 'List bank transfers',
    description: 'Transfers between the organisation\'s bank accounts.',
    inputSchema: listSchema({}, { paged: false }),
    handler: listHandler('BankTransfers', { paged: false }),
  },
  {
    name: 'xero_create_bank_transfer',
    title: 'Create a bank transfer',
    description: 'Move money between two bank accounts.',
    inputSchema: recordsSchema(
      'BankTransfer object(s): { FromBankAccount: { Code }, ToBankAccount: { Code }, Amount, Date }.',
    ),
    handler: writeHandler('BankTransfers', 'BankTransfers', { method: 'PUT' }),
  },

  // ----------------------------------------------------------------- payments
  {
    name: 'xero_list_payments',
    title: 'List payments',
    description: 'Payments applied to invoices, bills and credit notes.',
    inputSchema: listSchema({}),
    handler: listHandler('Payments'),
  },
  {
    name: 'xero_create_payments',
    title: 'Create payments',
    description: 'Pay an invoice or bill from a bank account.',
    inputSchema: recordsSchema(
      'Payment object(s): { Invoice: { InvoiceID }, Account: { Code }, Date, Amount, Reference }.',
    ),
    handler: writeHandler('Payments', 'Payments', { method: 'PUT' }),
  },
  {
    name: 'xero_delete_payment',
    title: 'Delete (reverse) a payment',
    description: 'Reverse a payment by setting its status to DELETED.',
    inputSchema: objectSchema({ paymentId: { type: 'string' } }, ['paymentId']),
    handler: (args) =>
      api({
        method: 'POST',
        path: `Payments/${args.paymentId}`,
        body: { Payments: [{ PaymentID: args.paymentId, Status: 'DELETED' }] },
        tenantId: args.tenantId,
      }),
  },
  {
    name: 'xero_list_prepayments',
    title: 'List prepayments',
    description: 'Prepayments (customer payments received before invoicing).',
    inputSchema: listSchema({}),
    handler: listHandler('Prepayments'),
  },
  {
    name: 'xero_list_overpayments',
    title: 'List overpayments',
    description: 'Overpayments recorded against contacts.',
    inputSchema: listSchema({}),
    handler: listHandler('Overpayments'),
  },

  // ----------------------------------------------------------------- journals
  {
    name: 'xero_list_manual_journals',
    title: 'List manual journals',
    description: 'Manual journal entries.',
    inputSchema: listSchema({}),
    handler: listHandler('ManualJournals'),
  },
  {
    name: 'xero_create_manual_journals',
    title: 'Create manual journals',
    description: 'Post a manual journal. Debits and credits must balance.',
    inputSchema: recordsSchema(
      'ManualJournal object(s): { Narration, Date, Status (DRAFT/POSTED), LineAmountTypes, JournalLines: [{ LineAmount, AccountCode, Description, TaxType, Tracking }] }. Positive LineAmount is a debit, negative is a credit.',
    ),
    handler: writeHandler('ManualJournals', 'ManualJournals', { method: 'PUT' }),
  },
  {
    name: 'xero_update_manual_journal',
    title: 'Update a manual journal',
    description: 'Update existing manual journals. Supply ManualJournalID in each record.',
    inputSchema: recordsSchema('ManualJournal object(s) including ManualJournalID.'),
    handler: writeHandler('ManualJournals', 'ManualJournals'),
  },
  {
    name: 'xero_list_journals',
    title: 'List general ledger journals',
    description:
      'Read-only general ledger journal lines, the definitive posted-entry feed. Page through with offset (journal number).',
    inputSchema: objectSchema({
      offset: { type: 'integer', description: 'Return journals after this JournalNumber.' },
      paymentsOnly: { type: 'boolean' },
      modifiedSince: { type: 'string' },
    }),
    handler: (args) =>
      api({
        path: 'Journals',
        query: { offset: args.offset, paymentsOnly: args.paymentsOnly },
        headers: args.modifiedSince ? { 'If-Modified-Since': args.modifiedSince } : {},
        tenantId: args.tenantId,
      }),
  },

  // ------------------------------------------------------- items, POs, quotes
  {
    name: 'xero_list_items',
    title: 'List inventory items',
    description: 'Products and services, with their sales and purchase details.',
    inputSchema: listSchema({}, { paged: false }),
    handler: listHandler('Items', { paged: false }),
  },
  {
    name: 'xero_create_items',
    title: 'Create items',
    description: 'Create inventory or service items.',
    inputSchema: recordsSchema(
      'Item object(s): { Code, Name, Description, PurchaseDetails: { UnitPrice, AccountCode, TaxType }, SalesDetails: { UnitPrice, AccountCode, TaxType }, IsTrackedAsInventory, InventoryAssetAccountCode }.',
    ),
    handler: writeHandler('Items', 'Items', { method: 'PUT' }),
  },
  {
    name: 'xero_update_item',
    title: 'Update an item',
    description: 'Update existing items. Supply ItemID in each record.',
    inputSchema: recordsSchema('Item object(s) including ItemID.'),
    handler: writeHandler('Items', 'Items'),
  },
  {
    name: 'xero_list_purchase_orders',
    title: 'List purchase orders',
    description: 'Purchase orders, optionally filtered by status and date range.',
    inputSchema: listSchema({
      Status: { type: 'string', enum: ['DRAFT', 'SUBMITTED', 'AUTHORISED', 'BILLED', 'DELETED'] },
      DateFrom: { type: 'string' },
      DateTo: { type: 'string' },
    }),
    handler: listHandler('PurchaseOrders', { extraQuery: ['Status', 'DateFrom', 'DateTo'] }),
  },
  {
    name: 'xero_create_purchase_orders',
    title: 'Create purchase orders',
    description: 'Create purchase orders.',
    inputSchema: recordsSchema(
      'PurchaseOrder object(s): { Contact, Date, DeliveryDate, LineAmountTypes, Status, Reference, LineItems }.',
    ),
    handler: writeHandler('PurchaseOrders', 'PurchaseOrders', { method: 'PUT' }),
  },
  {
    name: 'xero_update_purchase_order',
    title: 'Update a purchase order',
    description: 'Update existing purchase orders. Supply PurchaseOrderID in each record.',
    inputSchema: recordsSchema('PurchaseOrder object(s) including PurchaseOrderID.'),
    handler: writeHandler('PurchaseOrders', 'PurchaseOrders'),
  },
  {
    name: 'xero_list_quotes',
    title: 'List quotes',
    description: 'Quotes, optionally filtered by status, contact and date range.',
    inputSchema: listSchema({
      Status: { type: 'string' },
      DateFrom: { type: 'string' },
      DateTo: { type: 'string' },
      ContactID: { type: 'string' },
      QuoteNumber: { type: 'string' },
    }),
    handler: listHandler('Quotes', {
      extraQuery: ['Status', 'DateFrom', 'DateTo', 'ContactID', 'QuoteNumber'],
    }),
  },
  {
    name: 'xero_create_quotes',
    title: 'Create quotes',
    description: 'Create quotes.',
    inputSchema: recordsSchema(
      'Quote object(s): { Contact, Date, ExpiryDate, LineAmountTypes, Status, Title, Summary, LineItems }.',
    ),
    handler: writeHandler('Quotes', 'Quotes', { method: 'PUT' }),
  },
  {
    name: 'xero_update_quote',
    title: 'Update a quote',
    description: 'Update existing quotes. Supply QuoteID in each record.',
    inputSchema: recordsSchema('Quote object(s) including QuoteID.'),
    handler: writeHandler('Quotes', 'Quotes'),
  },

  // ------------------------------------------------------------------ reports
  {
    name: 'xero_report_profit_and_loss',
    title: 'Profit and loss report',
    description: 'Profit and loss for a date range, optionally compared across periods or broken down by tracking option.',
    inputSchema: objectSchema({
      fromDate: { type: 'string', description: 'YYYY-MM-DD' },
      toDate: { type: 'string', description: 'YYYY-MM-DD' },
      periods: { type: 'integer', description: 'Number of comparison periods (1-11).' },
      timeframe: { type: 'string', enum: ['MONTH', 'QUARTER', 'YEAR'] },
      trackingCategoryID: { type: 'string' },
      trackingOptionID: { type: 'string' },
      trackingCategoryID2: { type: 'string' },
      trackingOptionID2: { type: 'string' },
      standardLayout: { type: 'boolean' },
      paymentsOnly: { type: 'boolean' },
    }),
    handler: reportHandler('ProfitAndLoss', [
      'fromDate',
      'toDate',
      'periods',
      'timeframe',
      'trackingCategoryID',
      'trackingOptionID',
      'trackingCategoryID2',
      'trackingOptionID2',
      'standardLayout',
      'paymentsOnly',
    ]),
  },
  {
    name: 'xero_report_balance_sheet',
    title: 'Balance sheet report',
    description: 'Balance sheet as at a date, optionally with comparison periods.',
    inputSchema: objectSchema({
      date: { type: 'string', description: 'YYYY-MM-DD' },
      periods: { type: 'integer' },
      timeframe: { type: 'string', enum: ['MONTH', 'QUARTER', 'YEAR'] },
      trackingOptionID: { type: 'string' },
      standardLayout: { type: 'boolean' },
      paymentsOnly: { type: 'boolean' },
    }),
    handler: reportHandler('BalanceSheet', [
      'date',
      'periods',
      'timeframe',
      'trackingOptionID',
      'standardLayout',
      'paymentsOnly',
    ]),
  },
  {
    name: 'xero_report_trial_balance',
    title: 'Trial balance report',
    description: 'Trial balance as at a date.',
    inputSchema: objectSchema({
      date: { type: 'string', description: 'YYYY-MM-DD' },
      paymentsOnly: { type: 'boolean' },
    }),
    handler: reportHandler('TrialBalance', ['date', 'paymentsOnly']),
  },
  {
    name: 'xero_report_aged_receivables',
    title: 'Aged receivables by contact',
    description: 'Aged receivables detail for one contact. Requires contactId.',
    inputSchema: objectSchema(
      {
        contactId: { type: 'string' },
        date: { type: 'string' },
        fromDate: { type: 'string' },
        toDate: { type: 'string' },
      },
      ['contactId'],
    ),
    handler: (args) =>
      api({
        path: 'Reports/AgedReceivablesByContact',
        query: { contactID: args.contactId, date: args.date, fromDate: args.fromDate, toDate: args.toDate },
        tenantId: args.tenantId,
      }),
  },
  {
    name: 'xero_report_aged_payables',
    title: 'Aged payables by contact',
    description: 'Aged payables detail for one contact. Requires contactId.',
    inputSchema: objectSchema(
      {
        contactId: { type: 'string' },
        date: { type: 'string' },
        fromDate: { type: 'string' },
        toDate: { type: 'string' },
      },
      ['contactId'],
    ),
    handler: (args) =>
      api({
        path: 'Reports/AgedPayablesByContact',
        query: { contactID: args.contactId, date: args.date, fromDate: args.fromDate, toDate: args.toDate },
        tenantId: args.tenantId,
      }),
  },
  {
    name: 'xero_report_bank_summary',
    title: 'Bank summary report',
    description: 'Opening/closing balances and cash movement per bank account for a period.',
    inputSchema: objectSchema({ fromDate: { type: 'string' }, toDate: { type: 'string' } }),
    handler: reportHandler('BankSummary', ['fromDate', 'toDate']),
  },
  {
    name: 'xero_report_executive_summary',
    title: 'Executive summary report',
    description: 'Month-on-month cash, profitability, income and performance KPIs.',
    inputSchema: objectSchema({ date: { type: 'string' } }),
    handler: reportHandler('ExecutiveSummary', ['date']),
  },
  {
    name: 'xero_report_budget_summary',
    title: 'Budget summary report',
    description: 'Budget summary for a number of periods.',
    inputSchema: objectSchema({
      date: { type: 'string' },
      periods: { type: 'integer' },
      timeframe: { type: 'integer', description: '1 = month, 3 = quarter, 12 = year.' },
    }),
    handler: reportHandler('BudgetSummary', ['date', 'periods', 'timeframe']),
  },
  {
    name: 'xero_list_reports',
    title: 'List available reports',
    description: 'Reports available to the organisation, including published custom reports.',
    inputSchema: objectSchema({}),
    handler: (args) => api({ path: 'Reports', tenantId: args.tenantId }),
  },
  {
    name: 'xero_list_budgets',
    title: 'List budgets',
    description: 'Budgets defined in the organisation.',
    inputSchema: objectSchema({ dateFrom: { type: 'string' }, dateTo: { type: 'string' } }),
    handler: (args) =>
      api({ path: 'Budgets', query: { DateFrom: args.dateFrom, DateTo: args.dateTo }, tenantId: args.tenantId }),
  },

  // ----------------------------------------------------------------- payroll
  {
    name: 'xero_list_payroll_employees',
    title: 'List payroll employees',
    description: 'Employees from the Payroll API. Choose the region matching the organisation.',
    inputSchema: objectSchema({ ...PAYROLL_REGION, page: { type: 'integer' } }),
    handler: (args) =>
      api({ path: payrollPath(args.region, 'Employees'), query: { page: args.page }, tenantId: args.tenantId }),
  },
  {
    name: 'xero_list_timesheets',
    title: 'List payroll timesheets',
    description: 'Timesheets from the Payroll API.',
    inputSchema: objectSchema({ ...PAYROLL_REGION, page: { type: 'integer' } }),
    handler: (args) =>
      api({ path: payrollPath(args.region, 'Timesheets'), query: { page: args.page }, tenantId: args.tenantId }),
  },
  {
    name: 'xero_list_pay_runs',
    title: 'List pay runs',
    description: 'Pay runs from the Payroll API.',
    inputSchema: objectSchema({ ...PAYROLL_REGION, page: { type: 'integer' } }),
    handler: (args) =>
      api({ path: payrollPath(args.region, 'PayRuns'), query: { page: args.page }, tenantId: args.tenantId }),
  },
  {
    name: 'xero_list_leave_applications',
    title: 'List leave applications',
    description: 'Leave applications from the Payroll API (AU uses LeaveApplications, UK/NZ use EmployeeLeave).',
    inputSchema: objectSchema({ ...PAYROLL_REGION, page: { type: 'integer' } }),
    handler: (args) =>
      api({
        path: payrollPath(args.region, 'LeaveApplications'),
        query: { page: args.page },
        tenantId: args.tenantId,
      }),
  },

  // -------------------------------------------------- files, assets, projects
  {
    name: 'xero_list_files',
    title: 'List files',
    description: 'Files in the organisation\'s file library.',
    inputSchema: objectSchema({ pagesize: { type: 'integer' }, page: { type: 'integer' } }),
    handler: (args) =>
      api({
        path: 'files.xro/1.0/Files',
        query: { pagesize: args.pagesize, page: args.page },
        tenantId: args.tenantId,
      }),
  },
  {
    name: 'xero_list_assets',
    title: 'List fixed assets',
    description: 'Fixed assets by status (DRAFT, REGISTERED or DISPOSED).',
    inputSchema: objectSchema({
      status: { type: 'string', enum: ['DRAFT', 'REGISTERED', 'DISPOSED'] },
      page: { type: 'integer' },
      pageSize: { type: 'integer' },
    }),
    handler: (args) =>
      api({
        path: 'assets.xro/1.0/Assets',
        query: { status: args.status || 'REGISTERED', page: args.page, pageSize: args.pageSize },
        tenantId: args.tenantId,
      }),
  },
  {
    name: 'xero_list_projects',
    title: 'List projects',
    description: 'Projects from the Xero Projects API.',
    inputSchema: objectSchema({ page: { type: 'integer' }, pageSize: { type: 'integer' }, states: { type: 'string' } }),
    handler: (args) =>
      api({
        path: 'projects.xro/2.0/Projects',
        query: { page: args.page, pageSize: args.pageSize, states: args.states },
        tenantId: args.tenantId,
      }),
  },

  // ------------------------------------------------------------- escape hatch
  {
    name: 'xero_api_request',
    title: 'Call any Xero API endpoint',
    description:
      'Direct passthrough to the Xero API for anything the named tools do not cover — other payroll endpoints, attachments, history, bank feeds, and so on. Authentication, tenant header and token refresh are handled for you.',
    inputSchema: objectSchema(
      {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'Defaults to GET.' },
        path: {
          type: 'string',
          description:
            'Either a bare Accounting API resource ("Invoices", "Contacts/{id}/History") or a fully qualified API path ("payroll.xro/2.0/Employees", "files.xro/1.0/Files").',
        },
        query: { type: 'object', description: 'Query parameters as key/value pairs.' },
        body: { type: 'object', description: 'JSON request body for POST/PUT.' },
      },
      ['path'],
    ),
    handler: (args) =>
      api({
        method: args.method || 'GET',
        path: args.path,
        query: args.query,
        body: args.body,
        tenantId: args.tenantId,
      }),
  },
];

export const toolMap = new Map(tools.map((t) => [t.name, t]));

export function publicTools() {
  return tools.map(({ name, title, description, inputSchema }) => ({
    name,
    title,
    description,
    inputSchema,
  }));
}

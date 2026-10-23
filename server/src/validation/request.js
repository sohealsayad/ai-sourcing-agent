import { z } from 'zod';

// HTML forms send "" for untouched optional fields; treat those as missing.
const optional = (schema) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());

export const CreateRequestSchema = z
  .object({
    commodity: z.string().trim().min(2, 'Commodity is required').max(200),
    specifications: optional(z.string().trim().max(2000)),
    location: z.string().trim().min(2, 'Location is required').max(200),
    quantity: z.coerce.number().positive('Quantity must be greater than 0'),
    unit: z.string().trim().min(1, 'Unit is required').max(30),
    target_price: z.coerce.number().positive('Target price must be greater than 0'),
    max_price: optional(z.coerce.number().positive()),
    currency: z.string().trim().length(3, 'Use a 3-letter currency code').toUpperCase(),
    deadline: optional(z.string().date('Use YYYY-MM-DD')),
    max_rounds: optional(z.coerce.number().int().min(1, 'At least 1 round').max(5, 'At most 5 rounds')).default(3),
    buyer_name: optional(z.string().trim().max(120)),
    buyer_email: optional(z.string().trim().email('Invalid email')),
  })
  .refine((d) => d.max_price === undefined || d.max_price >= d.target_price, {
    path: ['max_price'],
    message: 'Max price must be at least the target price',
  });

export const ApproveDealSchema = z.object({
  requestSupplierId: z.string().uuid('Choose a supplier'),
  approvedBy: z.string().trim().min(2, 'Enter the name of the person approving').max(120),
});

export const RejectDealsSchema = z.object({
  rejectedBy: z.string().trim().min(2, 'Enter your name').max(120),
  reason: optional(z.string().trim().max(500)),
});

export const InboundEmailSchema = z.object({
  from: z.string().trim().email().optional(),
  subject: z.string().max(500).default(''),
  text: z.string().min(1, 'Email text is required').max(50_000),
  messageId: z.string().max(500).optional(),
});

export const AddSupplierSchema = z.object({
  name: z.string().trim().min(2, 'Supplier name is required').max(200),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  website: optional(z.string().trim().url('Enter a full URL, e.g. https://…')),
});

/** Per-request email for one supplier; null or "" clears it (back to the supplier's own address). */
export const SupplierEmailSchema = z.object({
  email: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.string().trim().toLowerCase().email('Enter a valid email address').nullable(),
  ),
});

/** A quote typed in by the buyer when a supplier's reply could not be read automatically. */
export const ManualQuoteSchema = z.object({
  unit_price: z.coerce.number().positive('Enter a price greater than 0'),
  delivery_days: optional(z.coerce.number().int().positive('Delivery days must be a whole number')),
  payment_terms: optional(z.string().trim().max(200)),
});

export const SendProposalsSchema = z.object({
  requestSupplierIds: z.array(z.string().uuid('Invalid supplier id')).min(1, 'Select at least one supplier').max(50).optional(),
});

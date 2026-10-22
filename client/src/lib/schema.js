import { z } from 'zod';

// Mirrors server/src/validation/request.js; the server re-validates everything.
const optional = (schema) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());

export const requestSchema = z
  .object({
    commodity: z.string().trim().min(2, 'Commodity is required').max(200),
    specifications: optional(z.string().trim().max(2000)),
    location: z.string().trim().min(2, 'Location is required').max(200),
    quantity: z.coerce.number({ invalid_type_error: 'Enter a number' }).positive('Must be greater than 0'),
    unit: z.string().trim().min(1, 'Unit is required'),
    target_price: z.coerce.number({ invalid_type_error: 'Enter a number' }).positive('Must be greater than 0'),
    max_price: optional(z.coerce.number().positive('Must be greater than 0')),
    currency: z.string().length(3),
    deadline: optional(z.string()),
    max_rounds: z.coerce.number().int().min(1, 'At least 1').max(5, 'At most 5'),
    buyer_name: optional(z.string().trim().max(120)),
    buyer_email: optional(z.string().trim().email('Invalid email')),
  })
  .refine((d) => d.max_price === undefined || d.max_price >= d.target_price, {
    path: ['max_price'],
    message: 'Must be at least the target price',
  });

export const UNITS = ['kg', 'tonnes', 'litres', 'units', 'pieces', 'boxes', 'pallets', 'containers'];
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'AED', 'SGD', 'AUD', 'CNY'];

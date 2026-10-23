import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { forwardRef, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { Icon, PageHeader, Spinner } from '../components/ui.jsx';
import { formatMoney } from '../lib/format.js';
import { CURRENCIES, requestSchema, UNITS } from '../lib/schema.js';

function Field({ name, label, error, hint, required = false, children, className = '' }) {
  return (
    <div className={className}>
      <label className="field-label" htmlFor={name}>
        {label}
        {required && (
          <span className="ml-1 text-red-600" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <p id={`${name}-error`} className="field-error" role="alert">
          {error.message}
        </p>
      ) : (
        hint && (
          <p id={`${name}-hint`} className="field-hint">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

function Section({ step, title, description, children }) {
  return (
    <section className="border-b border-slate-100 px-6 py-6 last:border-0">
      <div className="flex items-start gap-3">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700 ring-1 ring-brand-100">{step}</span>
        <div>
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          <p className="mt-1 text-sm leading-relaxed text-slate-500">{description}</p>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-5">{children}</div>
    </section>
  );
}

// forwardRef: react-hook-form's register() needs the ref on the real <input> to read its value.
const PriceInput = forwardRef(function PriceInput({ currency, ...props }, ref) {
  return (
    <div className="relative">
      <input ref={ref} type="number" min="0" step="any" className="field-input tabular pr-14" {...props} />
      <span className="pointer-events-none absolute inset-y-0 right-3 grid place-items-center text-xs font-medium text-slate-400">{currency}</span>
    </div>
  );
});

const NEXT_STEPS = [
  ['search', 'AI finds suppliers', 'Matching suppliers near your delivery location.'],
  ['send', 'You send proposals', 'Pick suppliers; each gets a professional RFQ.'],
  ['activity', 'Agent negotiates', 'Bounded counter-offers within your limits.'],
  ['badgeCheck', 'You approve', 'Nothing is agreed without your approval.'],
];

export default function NewRequest() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    setError,
    watch,
    trigger,
    formState: { errors, touchedFields },
  } = useForm({
    resolver: zodResolver(requestSchema),
    defaultValues: { unit: 'tonnes', currency: 'USD', max_rounds: 3 },
    mode: 'onTouched',
    reValidateMode: 'onChange',
  });

  const mutation = useMutation({
    mutationFn: api.createRequest,
    meta: { success: 'Request created. Searching for suppliers…' },
    onSuccess: (request) => {
      queryClient.invalidateQueries({ queryKey: ['requests'] });
      navigate(`/requests/${request.id}`);
    },
    onError: (err) => {
      for (const [field, message] of Object.entries(err.fields ?? {})) setError(field, { message });
    },
  });

  const [commodity, currency, unit, quantity, target, max, rounds] = watch([
    'commodity',
    'currency',
    'unit',
    'quantity',
    'target_price',
    'max_price',
    'max_rounds',
  ]);
  const qty = Number(quantity) || 0;
  const inputProps = (name, hasHint = false) => ({
    ...register(name),
    id: name,
    'aria-invalid': errors[name] ? 'true' : undefined,
    'aria-describedby': errors[name] ? `${name}-error` : hasHint ? `${name}-hint` : undefined,
  });

  useEffect(() => {
    if (touchedFields.max_price) trigger('max_price');
  }, [target, touchedFields.max_price, trigger]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link to="/" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900">
            <Icon name="arrowLeft" /> Requests
          </Link>
        }
        title="New sourcing request"
        description="Tell us what you need. AI will find matching suppliers, then contact and negotiate with them for you."
      />

      <div className="grid grid-cols-[1fr_20rem] items-start gap-6">
        <form onSubmit={handleSubmit((data) => mutation.mutate(data))} noValidate className="card overflow-hidden">
          <Section step={1} title="What do you need?" description="Be specific; better details mean better supplier matches.">
            <Field name="commodity" label="Commodity" error={errors.commodity} required className="col-span-2">
              <input className="field-input" placeholder="e.g. 1121 Basmati rice" required minLength={2} maxLength={200} {...inputProps('commodity')} />
            </Field>
            <Field name="specifications" label="Specifications" error={errors.specifications} hint="Optional: grade, packaging, certifications, etc." className="col-span-2">
              <textarea rows={3} className="field-input resize-y" placeholder="e.g. Extra-long grain, 25 kg bags, ISO 22000 certified" maxLength={2000} {...inputProps('specifications', true)} />
            </Field>
            <Field name="quantity" label="Quantity" error={errors.quantity} required>
              <input
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                className="field-input tabular"
                placeholder="20"
                required
                {...inputProps('quantity')}
              />
            </Field>
            <Field name="unit" label="Unit" error={errors.unit} required>
              <select className="field-input" required {...inputProps('unit')}>
                {UNITS.map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </select>
            </Field>
          </Section>

          <Section step={2} title="Where & when" description="Suppliers near the delivery location are ranked higher.">
            <Field name="location" label="Delivery location" error={errors.location} required>
              <input className="field-input" placeholder="e.g. Dubai, UAE" required minLength={2} maxLength={200} {...inputProps('location')} />
            </Field>
            <Field name="deadline" label="Needed by" error={errors.deadline} hint="Optional">
              <input type="date" className="field-input" {...inputProps('deadline', true)} />
            </Field>
          </Section>

          <Section step={3} title="Price & negotiation" description="Your target price is never shown to suppliers; it guides the negotiation.">
            <Field name="currency" label="Currency" error={errors.currency} required>
              <select className="field-input" required {...inputProps('currency')}>
                {CURRENCIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
            <Field name="max_rounds" label="Negotiation rounds" error={errors.max_rounds} hint="Most counter-offers per supplier (1–5)." required>
              <select className="field-input" required {...inputProps('max_rounds', true)}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
            <Field name="target_price" label={`Target price per ${unit || 'unit'}`} error={errors.target_price} hint="The price you want to pay." required>
              <PriceInput currency={currency} placeholder="850" required inputMode="decimal" {...inputProps('target_price', true)} />
            </Field>
            <Field name="max_price" label="Maximum price" error={errors.max_price} hint="Optional: walk away above this.">
              <PriceInput
                currency={currency}
                placeholder="950"
                min={Number(target) > 0 ? Number(target) : 0}
                inputMode="decimal"
                {...inputProps('max_price', true)}
              />
            </Field>
          </Section>

          <Section step={4} title="Your details" description="Used to sign the proposals sent to suppliers.">
            <Field name="buyer_name" label="Name" error={errors.buyer_name} hint="Optional">
              <input className="field-input" placeholder="Procurement team" maxLength={120} {...inputProps('buyer_name', true)} />
            </Field>
            <Field name="buyer_email" label="Email" error={errors.buyer_email} hint="Optional">
              <input type="email" autoComplete="email" className="field-input" placeholder="you@company.com" {...inputProps('buyer_email', true)} />
            </Field>
          </Section>

          <div className="flex items-center justify-end gap-3 border-t border-slate-200/80 bg-slate-50/60 px-6 py-4">
            {mutation.isError && !mutation.error.fields && <p className="mr-auto text-sm font-medium text-red-600">{mutation.error.message}</p>}
            <button type="button" className="btn-ghost" onClick={() => navigate('/')}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={mutation.isPending}>
              {mutation.isPending ? <Spinner /> : <Icon name="search" />}
              {mutation.isPending ? 'Starting…' : 'Find suppliers'}
            </button>
          </div>
        </form>

        <aside className="sticky top-20 space-y-5">
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-slate-900">Summary</h3>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Commodity</dt>
                <dd className="truncate text-right font-medium text-slate-900">{commodity?.trim() || '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Quantity</dt>
                <dd className="tabular font-medium text-slate-900">{qty ? `${qty} ${unit}` : '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Negotiation</dt>
                <dd className="font-medium text-slate-900">
                  up to {rounds} round{Number(rounds) === 1 ? '' : 's'}
                </dd>
              </div>
            </dl>
            <div className="mt-4 space-y-3 border-t border-slate-100 pt-4 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-slate-500">Target total</span>
                <span className="tabular font-semibold text-slate-900">{qty && Number(target) ? formatMoney(qty * Number(target), currency) : '—'}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-slate-500">Maximum total</span>
                <span className="tabular font-medium text-slate-700">{qty && Number(max) ? formatMoney(qty * Number(max), currency) : '—'}</span>
              </div>
            </div>
          </div>

          <div className="card p-5">
            <h3 className="text-sm font-semibold text-slate-900">What happens next</h3>
            <ol className="mt-4 space-y-4">
              {NEXT_STEPS.map(([icon, title, text]) => (
                <li key={title} className="flex gap-3">
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
                    <Icon name={icon} className="size-3.5" />
                  </span>
                  <span>
                    <span className="block text-sm font-medium text-slate-800">{title}</span>
                    <span className="block text-xs text-slate-500">{text}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </aside>
      </div>
    </div>
  );
}

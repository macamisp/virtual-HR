'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { Eye, EyeOff, Landmark, Save, Trash2 } from 'lucide-react';
import type { BankDetails, SubcontractorProfile, SubcontractorProfileDto } from '@hrvo/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useRevealSensitive, useUpdateSubcontractorProfile } from '@/lib/subcontractor-queries';
import type { ProfileTarget } from '@/lib/subcontractor-queries';

const REVEAL_SECONDS = 60;
const EMPTY_BANK: BankDetails = { accountName: '', bankName: '', branch: '', accountNumber: '', swiftCode: '' };

function Field({ label, value, onChange, readOnly, type = 'text', maxLength, placeholder }: { label: string; value: string; onChange: (v: string) => void; readOnly?: boolean; type?: string; maxLength?: number; placeholder?: string }) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} readOnly={readOnly} maxLength={maxLength} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** One card = one small form that sends only its own fields. */
function Section({ title, description, editable, onSave, saving, children }: { title: string; description?: string; editable: boolean; onSave: () => void; saving: boolean; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle>{description ? <CardDescription>{description}</CardDescription> : null}</CardHeader>
      <CardContent>
        <form aria-label={title} className="space-y-3" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
          {children}
          {editable ? <Button type="submit" size="sm" disabled={saving}><Save aria-hidden="true" /> {saving ? 'Saving…' : `Save ${title.toLowerCase()}`}</Button> : null}
        </form>
      </CardContent>
    </Card>
  );
}

/** FR-ORG-002 (ADR 033): a subcontractor profile, for the person themselves or for HR. */
export function SubcontractorProfileView({ target, profile }: { target: ProfileTarget; profile: SubcontractorProfile }) {
  const update = useUpdateSubcontractorProfile(target);
  const reveal = useRevealSensitive(target);
  const [message, setMessage] = useState<string | null>(null);
  const [identity, setIdentity] = useState({ legalName: profile.legalName, companyName: profile.companyName, country: profile.country ?? '' });
  const [contact, setContact] = useState({ contactEmail: profile.contactEmail ?? '', contactPhone: profile.contactPhone ?? '', address: profile.address });
  const [emergency, setEmergency] = useState(profile.emergencyContact ?? { name: '', relationship: '', phone: '' });
  // Replacement values only: the form never holds the stored tax ID or bank details.
  const [taxId, setTaxId] = useState('');
  const [bank, setBank] = useState<BankDetails>(EMPTY_BANK);
  const [shown, setShown] = useState<{ taxId: string | null; bankDetails: BankDetails | null } | null>(null);
  const addressId = useId();
  useEffect(() => {
    if (!shown) return undefined;
    const t = setTimeout(() => setShown(null), REVEAL_SECONDS * 1000);
    return () => clearTimeout(t);
  }, [shown]);
  const save = (dto: SubcontractorProfileDto, done: string, after?: () => void) => update.mutate(dto, { onSuccess: () => { setMessage(done); after?.(); } });
  const nullIfEmpty = (v: string) => (v.trim() === '' ? null : v.trim());

  return (
    <div className="space-y-4">
      {message ? <Alert><AlertDescription role="status">{message}</AlertDescription></Alert> : null}
      {update.isError ? <Alert variant="destructive"><AlertDescription>{update.error.message}</AlertDescription></Alert> : null}
      <Section title="Identity" description={profile.can.editIdentity ? undefined : 'Changed by HR.'} editable={profile.can.editIdentity} saving={update.isPending}
        onSave={() => save({ legalName: identity.legalName, companyName: identity.companyName, country: nullIfEmpty(identity.country) }, 'Identity saved.')}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Legal name" value={identity.legalName} maxLength={200} readOnly={!profile.can.editIdentity} onChange={(v) => setIdentity({ ...identity, legalName: v })} />
          <Field label="Company" value={identity.companyName} maxLength={200} readOnly={!profile.can.editIdentity} onChange={(v) => setIdentity({ ...identity, companyName: v })} />
          <Field label="Country (ISO code)" value={identity.country} maxLength={2} placeholder="LK" readOnly={!profile.can.editIdentity} onChange={(v) => setIdentity({ ...identity, country: v.toUpperCase() })} />
        </div>
      </Section>

      <Section title="Contact details" editable={profile.can.editContact} saving={update.isPending}
        onSave={() => save({ contactEmail: nullIfEmpty(contact.contactEmail), contactPhone: nullIfEmpty(contact.contactPhone), address: contact.address }, 'Contact details saved.')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Contact email" type="email" value={contact.contactEmail} maxLength={255} readOnly={!profile.can.editContact} onChange={(v) => setContact({ ...contact, contactEmail: v })} />
          <Field label="Phone" type="tel" value={contact.contactPhone} maxLength={40} readOnly={!profile.can.editContact} onChange={(v) => setContact({ ...contact, contactPhone: v })} />
        </div>
        <div className="space-y-1"><Label htmlFor={addressId}>Address</Label><Textarea id={addressId} rows={2} maxLength={500} readOnly={!profile.can.editContact} value={contact.address} onChange={(e) => setContact({ ...contact, address: e.target.value })} /></div>
      </Section>

      <Section title="Emergency contact" editable={profile.can.editContact} saving={update.isPending}
        onSave={() => save({ emergencyContact: emergency.name.trim() || emergency.phone.trim() ? emergency : null }, 'Emergency contact saved.')}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name" value={emergency.name} maxLength={200} readOnly={!profile.can.editContact} onChange={(v) => setEmergency({ ...emergency, name: v })} />
          <Field label="Relationship" value={emergency.relationship} maxLength={100} readOnly={!profile.can.editContact} onChange={(v) => setEmergency({ ...emergency, relationship: v })} />
          <Field label="Emergency phone" type="tel" value={emergency.phone} maxLength={40} readOnly={!profile.can.editContact} onChange={(v) => setEmergency({ ...emergency, phone: v })} />
        </div>
      </Section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Landmark className="h-4 w-4" aria-hidden="true" /> Tax and bank details</CardTitle>
          <CardDescription>Encrypted. Shown masked; revealing them is recorded in the audit log.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-2 text-sm sm:grid-cols-2" data-testid="sensitive-masked">
            <div><dt className="text-muted-foreground">Tax ID</dt><dd>{profile.taxId.set ? `•••• ${profile.taxId.last4}` : 'Not on file'}</dd></div>
            <div><dt className="text-muted-foreground">Bank account</dt><dd>{profile.bankDetails.set ? `${profile.bankDetails.bankName ?? ''} •••• ${profile.bankDetails.last4}` : 'Not on file'}</dd></div>
          </dl>
          {profile.can.reveal && (profile.taxId.set || profile.bankDetails.set) ? (
            shown ? (
              <div className="space-y-2 rounded-md border border-warning p-3 text-sm" data-testid="sensitive-clear">
                <p><span className="text-muted-foreground">Tax ID:</span> {shown.taxId ?? 'Not on file'}</p>
                {shown.bankDetails ? <p><span className="text-muted-foreground">Bank:</span> {shown.bankDetails.accountName}, {shown.bankDetails.bankName}{shown.bankDetails.branch ? ` (${shown.bankDetails.branch})` : ''}, account {shown.bankDetails.accountNumber}{shown.bankDetails.swiftCode ? `, SWIFT ${shown.bankDetails.swiftCode}` : ''}</p> : null}
                <p className="text-xs text-muted-foreground">Hidden again after {REVEAL_SECONDS} seconds.</p>
                <Button size="sm" variant="outline" onClick={() => setShown(null)}><EyeOff aria-hidden="true" /> Hide</Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" disabled={reveal.isPending} onClick={() => reveal.mutate(undefined, { onSuccess: (v) => { setShown(v); reveal.reset(); } })}><Eye aria-hidden="true" /> Reveal tax and bank details</Button>
            )
          ) : null}
          {reveal.isError ? <Alert variant="destructive"><AlertDescription>{reveal.error.message}</AlertDescription></Alert> : null}
          {profile.can.editSensitive ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <form aria-label="Replace tax ID" className="space-y-2" onSubmit={(e) => { e.preventDefault(); save({ taxId: taxId.trim() }, 'Tax ID saved.', () => setTaxId('')); }}>
                <Field label="New tax ID" value={taxId} maxLength={40} placeholder={profile.taxId.set ? 'Enter a new value to replace it' : ''} onChange={setTaxId} />
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={update.isPending || !taxId.trim()}><Save aria-hidden="true" /> Save tax ID</Button>
                  {profile.taxId.set ? <Button type="button" size="sm" variant="ghost" disabled={update.isPending} onClick={() => save({ taxId: null }, 'Tax ID removed.')}><Trash2 aria-hidden="true" /> Remove</Button> : null}
                </div>
              </form>
              <form aria-label="Replace bank details" className="space-y-2" onSubmit={(e) => { e.preventDefault(); save({ bankDetails: bank }, 'Bank details saved.', () => setBank(EMPTY_BANK)); }}>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="Account holder" value={bank.accountName} maxLength={200} onChange={(v) => setBank({ ...bank, accountName: v })} />
                  <Field label="Bank" value={bank.bankName} maxLength={200} onChange={(v) => setBank({ ...bank, bankName: v })} />
                  <Field label="Branch" value={bank.branch} maxLength={200} onChange={(v) => setBank({ ...bank, branch: v })} />
                  <Field label="Account number" value={bank.accountNumber} maxLength={40} onChange={(v) => setBank({ ...bank, accountNumber: v })} />
                  <Field label="SWIFT/BIC (optional)" value={bank.swiftCode} maxLength={11} onChange={(v) => setBank({ ...bank, swiftCode: v.toUpperCase() })} />
                </div>
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={update.isPending || !bank.accountNumber.trim()}><Save aria-hidden="true" /> Save bank details</Button>
                  {profile.bankDetails.set ? <Button type="button" size="sm" variant="ghost" disabled={update.isPending} onClick={() => save({ bankDetails: null }, 'Bank details removed.')}><Trash2 aria-hidden="true" /> Remove</Button> : null}
                </div>
              </form>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {profile.rates !== undefined ? (
        <Card>
          <CardHeader><CardTitle className="text-base">Rates</CardTitle><CardDescription>Set on the <Link className="underline" href="/timesheets/rates">rates</Link> screen.</CardDescription></CardHeader>
          <CardContent className="text-sm" data-testid="rates">
            {profile.rates ? `${profile.rates.rateType.toLowerCase()} ${profile.rates.currency} ${profile.rates.rate}, overtime × ${profile.rates.overtimeMultiplier}${profile.rates.weeklyHoursCap ? `, weekly cap ${profile.rates.weeklyHoursCap} h` : ''}` : 'No rates yet.'}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

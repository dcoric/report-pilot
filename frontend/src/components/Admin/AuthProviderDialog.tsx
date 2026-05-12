import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import type { components } from '../../lib/api/types';

export type AuthProvider = components['schemas']['AuthProvider'];

export interface AuthProviderFormValues {
    id?: string;
    type: 'oidc';
    name: string;
    display_name?: string | null;
    issuer: string;
    client_id: string;
    client_secret?: string | null;
    scopes: string[];
    redirect_uri: string;
    claims_mapping: { email?: string; display_name?: string };
    enabled: boolean;
}

interface Props {
    isOpen: boolean;
    initial: AuthProvider | null;
    defaultRedirectUri: string;
    onClose: () => void;
    onSubmit: (values: AuthProviderFormValues) => Promise<{ ok: boolean; message?: string }>;
}

type FieldErrors = Partial<Record<keyof AuthProviderFormValues | 'scopes_input', string>>;

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const URL_PATTERN = /^https?:\/\//i;

function defaultValues(initial: AuthProvider | null, defaultRedirectUri: string): AuthProviderFormValues {
    if (!initial) {
        return {
            type: 'oidc',
            name: '',
            display_name: '',
            issuer: '',
            client_id: '',
            client_secret: '',
            scopes: ['openid', 'email', 'profile'],
            redirect_uri: defaultRedirectUri,
            claims_mapping: {},
            enabled: true,
        };
    }
    return {
        id: initial.id,
        type: 'oidc',
        name: initial.name ?? '',
        display_name: initial.display_name ?? '',
        issuer: initial.issuer ?? '',
        client_id: initial.client_id ?? '',
        client_secret: '',
        scopes: initial.scopes ?? ['openid', 'email', 'profile'],
        redirect_uri: initial.redirect_uri ?? defaultRedirectUri,
        claims_mapping: initial.claims_mapping ?? {},
        enabled: initial.enabled ?? true,
    };
}

function validate(values: AuthProviderFormValues, isEdit: boolean): FieldErrors {
    const errors: FieldErrors = {};
    if (!values.name.trim()) {
        errors.name = 'Name is required.';
    } else if (!NAME_PATTERN.test(values.name.trim())) {
        errors.name = 'Use only letters, digits, underscore, or dash.';
    } else if (values.name.length > 64) {
        errors.name = 'Name cannot exceed 64 characters.';
    }
    if (!values.issuer.trim()) {
        errors.issuer = 'Issuer URL is required.';
    } else if (!URL_PATTERN.test(values.issuer.trim())) {
        errors.issuer = 'Issuer must be an http(s) URL.';
    }
    if (!values.client_id.trim()) {
        errors.client_id = 'Client ID is required.';
    }
    if (!values.redirect_uri.trim()) {
        errors.redirect_uri = 'Redirect URI is required.';
    } else if (!URL_PATTERN.test(values.redirect_uri.trim())) {
        errors.redirect_uri = 'Redirect URI must be an http(s) URL.';
    }
    if (!isEdit && (!values.client_secret || !values.client_secret.trim())) {
        // Public PKCE clients can omit. We surface a hint but don't block.
        // No error set.
    }
    if (values.scopes.length === 0) {
        errors.scopes_input = 'At least one scope is required.';
    }
    return errors;
}

export function AuthProviderDialog(props: Props) {
    if (!props.isOpen) return null;
    return <AuthProviderDialogInner {...props} key={props.initial?.id ?? 'new'} />;
}

function AuthProviderDialogInner({ initial, defaultRedirectUri, onClose, onSubmit }: Props) {
    const isEdit = Boolean(initial);
    const [values, setValues] = useState<AuthProviderFormValues>(() => defaultValues(initial, defaultRedirectUri));
    const [errors, setErrors] = useState<FieldErrors>({});
    const [serverError, setServerError] = useState<string | null>(null);
    const [scopesInput, setScopesInput] = useState<string>(values.scopes.join(' '));
    const [submitting, setSubmitting] = useState(false);

    const setField = <K extends keyof AuthProviderFormValues>(key: K, value: AuthProviderFormValues[K]) => {
        setValues((prev) => ({ ...prev, [key]: value }));
    };
    const setClaim = (key: 'email' | 'display_name', value: string) => {
        setValues((prev) => ({
            ...prev,
            claims_mapping: { ...prev.claims_mapping, [key]: value.trim() || undefined },
        }));
    };

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (submitting) return;
        const scopes = scopesInput.split(/\s+/).map((s) => s.trim()).filter(Boolean);
        const normalized: AuthProviderFormValues = {
            ...values,
            name: values.name.trim(),
            issuer: values.issuer.trim(),
            client_id: values.client_id.trim(),
            redirect_uri: values.redirect_uri.trim(),
            display_name: values.display_name?.trim() || null,
            client_secret: values.client_secret && values.client_secret.length > 0 ? values.client_secret : null,
            scopes,
        };
        const found = validate(normalized, isEdit);
        if (Object.keys(found).length > 0) {
            setErrors(found);
            return;
        }
        setSubmitting(true);
        setErrors({});
        setServerError(null);
        const result = await onSubmit(normalized);
        setSubmitting(false);
        if (!result.ok) {
            setServerError(result.message || 'Failed to save provider.');
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
            <div className="w-full max-w-2xl rounded-lg bg-white shadow-xl">
                <div className="flex items-center justify-between border-b p-4">
                    <h2 className="text-lg font-semibold">{isEdit ? 'Edit auth provider' : 'Add auth provider'}</h2>
                    <button onClick={onClose} className="text-gray-500 hover:text-gray-700" aria-label="Close">
                        <X size={20} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4 p-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="mb-1 block text-sm font-medium text-gray-700">Name</label>
                            <input
                                type="text"
                                value={values.name}
                                onChange={(e) => setField('name', e.target.value)}
                                disabled={isEdit}
                                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oxblood disabled:bg-gray-50"
                                placeholder="okta"
                            />
                            {errors.name && <p className="mt-1 text-xs text-red-600">{errors.name}</p>}
                            {!errors.name && (
                                <p className="mt-1 text-xs text-gray-500">URL-safe identifier. Cannot be changed after create.</p>
                            )}
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-gray-700">Display name</label>
                            <input
                                type="text"
                                value={values.display_name ?? ''}
                                onChange={(e) => setField('display_name', e.target.value)}
                                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                                placeholder="Okta SSO"
                            />
                        </div>
                    </div>

                    <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Issuer URL</label>
                        <input
                            type="url"
                            value={values.issuer}
                            onChange={(e) => setField('issuer', e.target.value)}
                            className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                            placeholder="https://example.okta.com"
                        />
                        {errors.issuer && <p className="mt-1 text-xs text-red-600">{errors.issuer}</p>}
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="mb-1 block text-sm font-medium text-gray-700">Client ID</label>
                            <input
                                type="text"
                                value={values.client_id}
                                onChange={(e) => setField('client_id', e.target.value)}
                                className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                            />
                            {errors.client_id && <p className="mt-1 text-xs text-red-600">{errors.client_id}</p>}
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-gray-700">
                                Client secret {isEdit && <span className="text-gray-400">(blank = keep existing)</span>}
                            </label>
                            <input
                                type="password"
                                value={values.client_secret ?? ''}
                                onChange={(e) => setField('client_secret', e.target.value)}
                                autoComplete="new-password"
                                className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                            />
                            <p className="mt-1 text-xs text-gray-500">Leave blank for public (PKCE-only) clients.</p>
                        </div>
                    </div>

                    <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Redirect URI</label>
                        <input
                            type="url"
                            value={values.redirect_uri}
                            onChange={(e) => setField('redirect_uri', e.target.value)}
                            className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                        />
                        {errors.redirect_uri && <p className="mt-1 text-xs text-red-600">{errors.redirect_uri}</p>}
                        {!errors.redirect_uri && (
                            <p className="mt-1 text-xs text-gray-500">Register this exact URL with the IdP.</p>
                        )}
                    </div>

                    <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Scopes</label>
                        <input
                            type="text"
                            value={scopesInput}
                            onChange={(e) => setScopesInput(e.target.value)}
                            className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                            placeholder="openid email profile"
                        />
                        {errors.scopes_input && <p className="mt-1 text-xs text-red-600">{errors.scopes_input}</p>}
                        {!errors.scopes_input && (
                            <p className="mt-1 text-xs text-gray-500">Space-separated. `openid` is added automatically.</p>
                        )}
                    </div>

                    <fieldset className="rounded-md border border-gray-200 p-3">
                        <legend className="px-2 text-xs font-medium uppercase tracking-wider text-gray-500">Claim mapping</legend>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="mb-1 block text-xs text-gray-600">Email claim</label>
                                <input
                                    type="text"
                                    value={values.claims_mapping.email ?? ''}
                                    onChange={(e) => setClaim('email', e.target.value)}
                                    placeholder="email"
                                    className="w-full rounded-md border border-gray-300 px-3 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                                />
                            </div>
                            <div>
                                <label className="mb-1 block text-xs text-gray-600">Display name claim</label>
                                <input
                                    type="text"
                                    value={values.claims_mapping.display_name ?? ''}
                                    onChange={(e) => setClaim('display_name', e.target.value)}
                                    placeholder="name"
                                    className="w-full rounded-md border border-gray-300 px-3 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                                />
                            </div>
                        </div>
                        <p className="mt-2 text-xs text-gray-500">Empty fields fall back to the OIDC standard claim names.</p>
                    </fieldset>

                    <label className="flex items-center gap-2 text-sm text-gray-700">
                        <input
                            type="checkbox"
                            checked={values.enabled}
                            onChange={(e) => setField('enabled', e.target.checked)}
                            className="h-4 w-4 rounded border-gray-300 text-oxblood focus:ring-oxblood"
                        />
                        Enabled (visible on the login page)
                    </label>

                    {serverError && (
                        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                            {serverError}
                        </div>
                    )}

                    <div className="flex items-center justify-end gap-2 border-t pt-3">
                        <button
                            type="button"
                            onClick={onClose}
                            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={submitting}
                            className="rounded-md bg-oxblood px-3 py-2 text-sm font-medium text-white hover:bg-oxblood-deep disabled:opacity-60"
                        >
                            {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create provider'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

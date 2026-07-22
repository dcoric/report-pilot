import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import type { components } from '../../lib/api/types';

export type AuthProvider = components['schemas']['AuthProvider'];

export interface AuthProviderFormValues {
    id?: string;
    type: 'oidc' | 'saml' | 'ldap' | 'ad' | 'pd';
    name: string;
    display_name?: string | null;
    issuer: string;
    client_id: string;
    client_secret?: string | null;
    scopes: string[];
    redirect_uri: string;
    claims_mapping: { email?: string; display_name?: string };
    enabled: boolean;
    // AUTH-012 mapping rules + AUTH-015 email-verified gate. Persisted by a
    // separate POST to /v1/admin/auth-providers/{id}/mapping-rules after the
    // main upsert.
    mapping_rules: {
        auto_link_by_email: boolean;
        jit_enabled: boolean;
        jit_default_role: string;
        jit_allowed_domains: string[];
        require_email_verified: boolean;
    };
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
const DOMAIN_PATTERN = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

const DEFAULT_MAPPING_RULES = {
    auto_link_by_email: true,
    jit_enabled: false,
    jit_default_role: 'viewer',
    jit_allowed_domains: [] as string[],
    require_email_verified: true,
};

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
            mapping_rules: { ...DEFAULT_MAPPING_RULES },
        };
    }
    return {
        id: initial.id,
        type: initial.type as 'oidc' | 'saml' | 'ldap' | 'ad' | 'pd',
        name: initial.name ?? '',
        display_name: initial.display_name ?? '',
        issuer: initial.issuer ?? '',
        client_id: initial.client_id ?? '',
        client_secret: '',
        scopes: initial.scopes ?? ['openid', 'email', 'profile'],
        redirect_uri: initial.redirect_uri ?? defaultRedirectUri,
        claims_mapping: initial.claims_mapping ?? {},
        enabled: initial.enabled ?? true,
        mapping_rules: {
            auto_link_by_email: initial.auto_link_by_email ?? true,
            jit_enabled: initial.jit_enabled ?? false,
            jit_default_role: initial.jit_default_role ?? 'viewer',
            jit_allowed_domains: initial.jit_allowed_domains ?? [],
            require_email_verified: initial.require_email_verified ?? true,
        },
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
    const [domainsInput, setDomainsInput] = useState<string>(values.mapping_rules.jit_allowed_domains.join(' '));
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
        const domains = domainsInput
            .split(/[\s,]+/)
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
        const invalidDomain = domains.find((d) => !DOMAIN_PATTERN.test(d));
        if (invalidDomain) {
            setErrors({ name: undefined });
            setServerError(`Invalid domain in allowlist: '${invalidDomain}'.`);
            return;
        }
        const normalized: AuthProviderFormValues = {
            ...values,
            name: values.name.trim(),
            issuer: values.issuer.trim(),
            client_id: values.client_id.trim(),
            redirect_uri: values.redirect_uri.trim(),
            display_name: values.display_name?.trim() || null,
            client_secret: values.client_secret && values.client_secret.length > 0 ? values.client_secret : null,
            scopes,
            mapping_rules: {
                auto_link_by_email: values.mapping_rules.auto_link_by_email,
                jit_enabled: values.mapping_rules.jit_enabled,
                jit_default_role: values.mapping_rules.jit_default_role.trim().toLowerCase() || 'viewer',
                jit_allowed_domains: Array.from(new Set(domains)),
                require_email_verified: values.mapping_rules.require_email_verified,
            },
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

    function setRule<K extends keyof AuthProviderFormValues['mapping_rules']>(
        key: K,
        value: AuthProviderFormValues['mapping_rules'][K]
    ) {
        setValues((prev) => ({ ...prev, mapping_rules: { ...prev.mapping_rules, [key]: value } }));
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

                    <fieldset className="rounded-md border border-gray-200 p-3">
                        <legend className="px-2 text-xs font-medium uppercase tracking-wider text-gray-500">
                            Account linking &amp; JIT
                        </legend>
                        <label className="flex items-start gap-2 text-sm text-gray-700">
                            <input
                                type="checkbox"
                                checked={values.mapping_rules.auto_link_by_email}
                                onChange={(e) => setRule('auto_link_by_email', e.target.checked)}
                                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-oxblood focus:ring-oxblood"
                            />
                            <span>
                                Auto-link by email
                                <span className="block text-xs text-gray-500">
                                    When an SSO login email matches an existing local user, attach the external identity automatically. Disable for IdPs that don&apos;t verify email ownership.
                                </span>
                            </span>
                        </label>
                        <label className="mt-3 flex items-start gap-2 text-sm text-gray-700">
                            <input
                                type="checkbox"
                                checked={values.mapping_rules.require_email_verified}
                                onChange={(e) => setRule('require_email_verified', e.target.checked)}
                                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-oxblood focus:ring-oxblood"
                            />
                            <span>
                                Require <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">email_verified</code> claim
                                <span className="block text-xs text-gray-500">
                                    Refuse auto-link and JIT when the IdP says the email isn&apos;t verified. Keep on unless you trust this IdP to never assert unverified emails.
                                </span>
                            </span>
                        </label>
                        <label className="mt-3 flex items-start gap-2 text-sm text-gray-700">
                            <input
                                type="checkbox"
                                checked={values.mapping_rules.jit_enabled}
                                onChange={(e) => setRule('jit_enabled', e.target.checked)}
                                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-oxblood focus:ring-oxblood"
                            />
                            <span>
                                Just-in-time provisioning
                                <span className="block text-xs text-gray-500">
                                    Create a local user on first successful SSO when no email matches. Off by default.
                                </span>
                            </span>
                        </label>
                        {values.mapping_rules.jit_enabled && (
                            <div className="mt-3 grid grid-cols-2 gap-4">
                                <div>
                                    <label className="mb-1 block text-xs text-gray-600">Default role</label>
                                    <input
                                        type="text"
                                        value={values.mapping_rules.jit_default_role}
                                        onChange={(e) => setRule('jit_default_role', e.target.value)}
                                        placeholder="viewer"
                                        className="w-full rounded-md border border-gray-300 px-3 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                                    />
                                    <p className="mt-1 text-xs text-gray-500">Role assigned to JIT-created users.</p>
                                </div>
                                <div>
                                    <label className="mb-1 block text-xs text-gray-600">Allowed email domains</label>
                                    <input
                                        type="text"
                                        value={domainsInput}
                                        onChange={(e) => setDomainsInput(e.target.value)}
                                        placeholder="example.com other.org"
                                        className="w-full rounded-md border border-gray-300 px-3 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                                    />
                                    <p className="mt-1 text-xs text-gray-500">Space- or comma-separated. Empty allows all.</p>
                                </div>
                            </div>
                        )}
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

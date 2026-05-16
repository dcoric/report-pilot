import { Variable } from 'lucide-react';
import type { components } from '../../lib/api/types';

type QueryParameter = components['schemas']['QueryParameter'];

export type ParamValues = Record<string, unknown>;

interface SavedQueryParamsPanelProps {
    parameters: QueryParameter[];
    values: ParamValues;
    errors: Record<string, string> | null;
    onChange: (values: ParamValues) => void;
}

function inputTypeForParam(type: QueryParameter['type']) {
    if (type === 'integer' || type === 'decimal') return 'number';
    if (type === 'date') return 'date';
    if (type === 'timestamp') return 'datetime-local';
    return 'text';
}

function placeholderForParam(param: QueryParameter) {
    if (param.default !== null && param.default !== undefined) {
        return `default: ${String(param.default)}`;
    }
    return param.required ? 'required' : 'optional';
}

function toInputValue(value: unknown) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return String(value);
}

export function SavedQueryParamsPanel({
    parameters,
    values,
    errors,
    onChange,
}: SavedQueryParamsPanelProps) {
    if (parameters.length === 0) {
        return null;
    }

    const updateValue = (name: string, next: unknown) => {
        onChange({ ...values, [name]: next });
    };

    return (
        <div className="flex-shrink-0 border-b border-outline-variant bg-white px-4 py-3">
            <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                <Variable size={12} className="text-oxblood" />
                Parameters
                <span className="font-normal normal-case tracking-normal text-slate-400">
                    ({parameters.length})
                </span>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                {parameters.map((param) => {
                    const errorMessage = errors?.[param.name];
                    const fieldId = `saved-query-param-${param.name}`;
                    const allowed = Array.isArray(param.allowed_values) ? param.allowed_values : null;

                    return (
                        <div key={param.name} className="flex flex-col">
                            <label
                                htmlFor={fieldId}
                                className="mb-1 flex items-center justify-between text-[11px] font-medium text-slate-600"
                            >
                                <span>
                                    {param.name}
                                    {param.required && <span className="ml-0.5 text-oxblood">*</span>}
                                </span>
                                <span className="text-[10px] font-normal text-slate-400">{param.type}</span>
                            </label>
                            {param.type === 'boolean' ? (
                                <select
                                    id={fieldId}
                                    value={toInputValue(values[param.name])}
                                    onChange={(event) => {
                                        const next = event.target.value;
                                        updateValue(param.name, next === '' ? null : next === 'true');
                                    }}
                                    className={[
                                        'rounded-md border bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-1',
                                        errorMessage
                                            ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-200'
                                            : 'border-outline-variant focus:border-oxblood focus:ring-oxblood',
                                    ].join(' ')}
                                >
                                    {!param.required && <option value="">—</option>}
                                    <option value="true">true</option>
                                    <option value="false">false</option>
                                </select>
                            ) : allowed && allowed.length > 0 ? (
                                <select
                                    id={fieldId}
                                    value={toInputValue(values[param.name])}
                                    onChange={(event) => {
                                        const next = event.target.value;
                                        updateValue(param.name, next === '' ? null : next);
                                    }}
                                    className={[
                                        'rounded-md border bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-1',
                                        errorMessage
                                            ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-200'
                                            : 'border-outline-variant focus:border-oxblood focus:ring-oxblood',
                                    ].join(' ')}
                                >
                                    {!param.required && <option value="">—</option>}
                                    {allowed.map((value) => (
                                        <option key={String(value)} value={String(value)}>
                                            {String(value)}
                                        </option>
                                    ))}
                                </select>
                            ) : (
                                <input
                                    id={fieldId}
                                    type={inputTypeForParam(param.type)}
                                    value={toInputValue(values[param.name])}
                                    placeholder={placeholderForParam(param)}
                                    onChange={(event) => {
                                        const raw = event.target.value;
                                        updateValue(param.name, raw === '' ? null : raw);
                                    }}
                                    className={[
                                        'rounded-md border px-2 py-1.5 text-sm placeholder-slate-400 focus:outline-none focus:ring-1',
                                        errorMessage
                                            ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-200'
                                            : 'border-outline-variant focus:border-oxblood focus:ring-oxblood',
                                    ].join(' ')}
                                />
                            )}
                            {errorMessage && (
                                <span className="mt-1 text-[10px] text-rose-600">{errorMessage}</span>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

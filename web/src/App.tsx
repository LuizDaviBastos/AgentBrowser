import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { cancelJob, createJob, deleteJob, fetchJob, fetchJobs, fetchOpenApi, retryJob, runJob, updateJob, waitJob } from './api';
import type { JobRecord, JsonSchemaObject } from './types';
import './styles.css';

type View = 'dashboard' | 'jobs' | 'history' | 'endpoints';

const presets = {
  login: {
    name: 'Login job',
    instruction: 'Open the target site, sign in with the provided credentials, and return the resulting session data or profile fields requested by the user.',
    outputExample: { username: 'LuizDavi', password: 'LuizDavi23' },
    timeoutMs: 300000,
    requiredFields: ['username', 'password'],
  },
  create_test: {
    name: 'Create Test',
    instruction: 'Access https://painel.digitalplus.top/dashboard/, login with the provided credentials, create a new test with 6H, and return the submitted credentials in the response.',
    outputExample: { username: 'LuizDavi', password: 'LuizDavi23' },
    timeoutMs: 300000,
    requiredFields: ['username', 'password'],
  },
  scrape: {
    name: 'Scrape data',
    instruction: 'Open the target site, extract the requested structured data, and return it as JSON.',
    outputExample: { title: 'Example title', url: 'https://example.com', done: true },
    timeoutMs: 180000,
    requiredFields: ['title'],
  },
};

function inferSchema(value: unknown): JsonSchemaObject {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) return { type: 'array', items: value.length ? inferSchema(value[0]) : {} };
  switch (typeof value) {
    case 'string': return { type: 'string' };
    case 'number': return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
    case 'boolean': return { type: 'boolean' };
    case 'object': {
      const props: Record<string, JsonSchemaObject> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) props[k] = inferSchema(v);
      return { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false };
    }
    default:
      return {};
  }
}

function schemaExample(schema?: JsonSchemaObject): unknown {
  if (!schema) return {};
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (type === 'null') return null;
  if (type === 'string') return 'string';
  if (type === 'integer') return 1;
  if (type === 'number') return 1.5;
  if (type === 'boolean') return true;
  if (type === 'array') return [schemaExample((schema.items as JsonSchemaObject) || {})];
  if (type === 'object' || schema.properties) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(schema.properties || {})) result[key] = schemaExample(child);
    return result;
  }
  return {};
}

function prettyJson(value: unknown, fallback = 'No example yet.') {
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildRunCurl(baseUrl: string, job: JobRecord, token: string) {
  const auth = token ? ` -H "authorization: ${token.startsWith('Bearer ') ? token : `Bearer ${token}`}"` : '';
  return `curl -X POST ${JSON.stringify(`${baseUrl}/jobs/${encodeURIComponent(job.id)}/run`)} -H "content-type: application/json"${auth}`;
}

function responseExampleForJob(job?: JobRecord | null) {
  if (job.output !== undefined && job.output !== null) return job.output;
  if (job.outputExample !== undefined && job.outputExample !== null) return job.outputExample;
  if (job.outputSchema) return schemaExample(job.outputSchema);
  return {};
}

function buildRequestBody(job: JobRecord) {
  return {
    name: job.name || undefined,
    instruction: job.instruction,
    outputExample: job.outputExample ?? responseExampleForJob(job),
    outputSchema: job.outputSchema || undefined,
    examples: job.examples || [],
    requiredFields: job.requiredFields || [],
    strict: !!job.strict,
    timeoutMs: job.timeoutMs || undefined,
    metadata: job.metadata || undefined,
    idempotencyKey: job.idempotencyKey || undefined,
  };
}

export function App() {
  const [view, setView] = useState<View>('dashboard');
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone?: 'good' | 'bad' | 'warn' | 'muted' }>({ text: '' });
  const [apiKey, setApiKey] = useState(localStorage.getItem('agent-browser-api-key') || '');
  const [openApi, setOpenApi] = useState<unknown>(null);
  const loadedEditJobId = useRef<string | null>(null);

  const [form, setForm] = useState({
    name: '',
    instruction: '',
    outputExample: JSON.stringify({ username: 'LuizDavi', password: 'LuizDavi23' }, null, 2),
    outputSchema: '',
    examples: '[]',
    requiredFields: 'username,password',
    strict: false,
    timeoutMs: '300000',
    metadata: '',
    idempotencyKey: '',
  });

  const baseUrl = useMemo(() => window.location.origin, []);
  const selectedJob = jobs.find(job => job.id === selectedJobId) || null;
  const authToken = useMemo(() => apiKey.trim(), [apiKey]);

  const selectedRunCurl = useMemo(() => selectedJob ? buildRunCurl(baseUrl, selectedJob, authToken) : '', [baseUrl, selectedJob, authToken]);
  const inferredSchema = useMemo(() => {
    try {
      const parsed = JSON.parse(form.outputExample);
      return form.outputSchema.trim() ? JSON.parse(form.outputSchema) : inferSchema(parsed);
    } catch {
      return form.outputSchema.trim() ? (() => { try { return JSON.parse(form.outputSchema); } catch { return null; } })() : null;
    }
  }, [form.outputExample, form.outputSchema]);

  const headers = {
    'content-type': 'application/json',
    ...(authToken ? { authorization: authToken.startsWith('Bearer ') ? authToken : `Bearer ${authToken}` } : {}),
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const items = await fetchJobs();
      setJobs(items);
      if (!selectedJobId && items[0]) setSelectedJobId(items[0].id);
      if (selectedJobId && !items.find(j => j.id === selectedJobId)) {
        setSelectedJobId(items[0]?.id || null);
      }
      setStatus({ text: 'Jobs loaded.', tone: 'muted' });
    } catch (err) {
      setStatus({ text: err instanceof Error ? err.message : 'Failed to load jobs', tone: 'bad' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    localStorage.setItem('agent-browser-api-key', apiKey);
  }, [apiKey]);

  useEffect(() => {
    void refresh();
    void fetchOpenApi().then(setOpenApi).catch(() => {});
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selectedJobId) return;
    void fetchJob(selectedJobId).then(job => {
      setSelectedJobId(job.id);
      setStatus({ text: `Loaded job ${job.id}.`, tone: 'muted' });
    }).catch(() => {});
  }, [selectedJobId]);

  const loadJobIntoForm = (job: JobRecord) => {
    setForm({
      name: job.name || '',
      instruction: job.instruction || '',
      outputExample: prettyJson(job.outputExample ?? responseExampleForJob(job), ''),
      outputSchema: job.outputSchema ? prettyJson(job.outputSchema, '') : '',
      examples: prettyJson(job.examples || [], '[]'),
      requiredFields: (job.requiredFields || []).join(','),
      strict: !!job.strict,
      timeoutMs: String(job.timeoutMs || 300000),
      metadata: prettyJson(job.metadata || {}, ''),
      idempotencyKey: job.idempotencyKey || '',
    });
    loadedEditJobId.current = job.id;
  };

  useEffect(() => {
    if (!editingJobId) {
      loadedEditJobId.current = null;
      return;
    }
    if (loadedEditJobId.current === editingJobId) return;
    const job = jobs.find(item => item.id === editingJobId);
    if (!job) return;
    loadJobIntoForm(job);
  }, [editingJobId, jobs]);

  const saveJob = async (event: FormEvent) => {
    event.preventDefault();
    let outputExample: unknown = null;
    let outputSchema: JsonSchemaObject | undefined;
    let examples: unknown[] = [];
    let metadata: Record<string, unknown> | undefined;
    try {
      outputExample = form.outputExample.trim() ? JSON.parse(form.outputExample) : undefined;
      outputSchema = form.outputSchema.trim() ? JSON.parse(form.outputSchema) : undefined;
      examples = form.examples.trim() ? JSON.parse(form.examples) : [];
      metadata = form.metadata.trim() ? JSON.parse(form.metadata) : undefined;
    } catch {
      setStatus({ text: 'Invalid JSON in one of the form fields.', tone: 'bad' });
      return;
    }

    const payload = {
      name: form.name || undefined,
      instruction: form.instruction,
      outputExample,
      outputSchema,
      examples,
      requiredFields: form.requiredFields.split(',').map(s => s.trim()).filter(Boolean),
      strict: form.strict,
      timeoutMs: Number(form.timeoutMs || 0) || undefined,
      metadata,
      idempotencyKey: form.idempotencyKey || undefined,
    };

    try {
      const job = editingJobId ? await updateJob(editingJobId, payload) : await createJob(payload);
      setStatus({ text: `${editingJobId ? 'Updated' : 'Created'} job ${job.id}.`, tone: 'good' });
      setEditingJobId(null);
      loadedEditJobId.current = null;
      setSelectedJobId(job.id);
      await refresh();
    } catch (err) {
      setStatus({ text: err instanceof Error ? err.message : 'Failed to save job', tone: 'bad' });
    }
  };

  const onPreset = (preset: keyof typeof presets) => {
    const p = presets[preset];
    setForm({
      name: p.name,
      instruction: p.instruction,
      outputExample: JSON.stringify(p.outputExample, null, 2),
      outputSchema: '',
      examples: '[]',
      requiredFields: (p.requiredFields || []).join(','),
      strict: false,
      timeoutMs: String(p.timeoutMs || 300000),
      metadata: '',
      idempotencyKey: '',
    });
    setView('jobs');
  };

  const runSelected = async () => {
    if (!selectedJobId) return;
    try {
      await runJob(selectedJobId);
      setStatus({ text: 'Run started and completed successfully.', tone: 'good' });
      await refresh();
    } catch (err) {
      setStatus({ text: err instanceof Error ? err.message : 'Run failed', tone: 'bad' });
    }
  };

  const copy = async (text: string, ok = 'Copied.') => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus({ text: ok, tone: 'good' });
    } catch {
      setStatus({ text: text, tone: 'warn' });
    }
  };

  const withSelectedJob = (jobId: string, fn: (id: string) => Promise<unknown>) => async () => {
    setSelectedJobId(jobId);
    try {
      await fn(jobId);
      await refresh();
    } catch (err) {
      setStatus({ text: err instanceof Error ? err.message : 'Request failed', tone: 'bad' });
    }
  };

  const removeSelectedJob = async (jobId: string) => {
    if (!window.confirm('Delete this job? This cannot be undone.')) return;
    try {
      await deleteJob(jobId);
      if (selectedJobId === jobId) setSelectedJobId(null);
      if (editingJobId === jobId) {
        setEditingJobId(null);
        loadedEditJobId.current = null;
      }
      setStatus({ text: 'Job deleted.', tone: 'good' });
      await refresh();
    } catch (err) {
      setStatus({ text: err instanceof Error ? err.message : 'Failed to delete job', tone: 'bad' });
    }
  };

  const jobCards = jobs.map(job => {
    const responseExample = prettyJson(responseExampleForJob(job));
    const runCurl = buildRunCurl(baseUrl, job, authToken);
    const requestBody = prettyJson(buildRequestBody(job));
    return (
      <article key={job.id} className={`job-card ${selectedJobId === job.id ? 'selected' : ''}`}>
        <button className="job-summary" type="button" onClick={() => { setSelectedJobId(job.id); setView('history'); }}>
          <div className="job-summary-top">
            <div>
              <div className="job-title">{job.name || job.instruction.slice(0, 80) || 'Untitled job'}</div>
              <div className="mono muted">{job.id}</div>
            </div>
            <span className={`tag status-${job.status}`}>{job.status}</span>
          </div>
          <div className="job-meta">
            <span className="tag">attempts {job.attempts || 0}</span>
            <span className="tag">runs {job.executions?.length || 0}</span>
            <span className="tag">timeout {job.timeoutMs || '-'}</span>
          </div>
          <p className="job-instruction">{job.instruction}</p>
        </button>
        <div className="job-actions">
          <button onClick={() => { setSelectedJobId(job.id); void runSelected(); }}>Run</button>
          <button className="ghost" onClick={withSelectedJob(job.id, cancelJob)}>Cancel</button>
          <button className="ghost" onClick={withSelectedJob(job.id, retryJob)}>Retry</button>
          <button className="ghost" onClick={withSelectedJob(job.id, waitJob)}>Wait</button>
          <button className="ghost" onClick={() => { setSelectedJobId(job.id); void copy(runCurl, 'Run curl copied.'); }}>Copy curl</button>
          <button className="ghost" onClick={() => { setSelectedJobId(job.id); void copy(responseExample, 'Response example copied.'); }}>Copy response</button>
          <button className="ghost" onClick={() => { setSelectedJobId(job.id); setEditingJobId(job.id); loadJobIntoForm(job); setView('jobs'); }}>Edit</button>
          <button className="ghost danger" onClick={() => void removeSelectedJob(job.id)}>Delete</button>
        </div>
        <details className="collapsible">
          <summary>Run curl</summary>
          <pre>{runCurl}</pre>
        </details>
        <details className="collapsible">
          <summary>Response example</summary>
          <pre>{responseExample}</pre>
        </details>
        <details className="collapsible">
          <summary>Request body example</summary>
          <pre>{requestBody}</pre>
        </details>
      </article>
    );
  });

  const historyPanel = selectedJob ? (
    <div className="history-layout">
      <section className="card">
        <div className="section-head">
          <h2>Selected Job</h2>
          <div className="action-row">
            <button className="ghost" onClick={() => { setEditingJobId(selectedJob.id); loadJobIntoForm(selectedJob); setView('jobs'); }}>Edit in form</button>
            <button className="ghost" onClick={runSelected}>Run manually</button>
            <button className="ghost" onClick={() => void copy(selectedRunCurl, 'Run curl copied.')}>Copy curl</button>
            <button className="ghost danger" onClick={() => void removeSelectedJob(selectedJob.id)}>Delete job</button>
          </div>
        </div>
        <pre>{prettyJson({
          id: selectedJob.id,
          name: selectedJob.name,
          status: selectedJob.status,
          endpoint: `${baseUrl}/jobs/${selectedJob.id}`,
          runEndpoint: `${baseUrl}/jobs/${selectedJob.id}/run`,
          logsEndpoint: `${baseUrl}/jobs/${selectedJob.id}/logs`,
          runCurl: selectedRunCurl,
        })}</pre>
      </section>
      <section className="card">
        <h2>Response Example</h2>
        <details open className="collapsible">
          <summary>Final response</summary>
          <pre>{prettyJson(selectedJob.output ?? selectedJob.outputExample ?? schemaExample(selectedJob.outputSchema), 'No output yet.')}</pre>
        </details>
        <details className="collapsible">
          <summary>Logs</summary>
          <pre>{selectedJob.logs?.length ? selectedJob.logs.map(log => `[${log.ts}] ${log.level.toUpperCase()} ${log.message}${log.data ? ` ${JSON.stringify(log.data)}` : ''}`).join('\n\n') : 'No logs yet.'}</pre>
        </details>
      </section>
      <section className="card">
        <h2>Execution History</h2>
        <div className="history-list">
          {(selectedJob.executions || []).slice().reverse().map(exec => (
            <div key={`${exec.attempt}-${exec.startedAt || ''}`} className="history-item">
              <div className="section-head">
                <strong>Attempt {exec.attempt}</strong>
                <span className={`tag status-${exec.status}`}>{exec.status}</span>
              </div>
              <div className="muted tiny">{exec.startedAt || '-'} → {exec.finishedAt || '-'}</div>
              {exec.resultSummary ? <div className="tag">{exec.resultSummary}</div> : null}
              {exec.error ? <div className="tag bad">Error: {exec.error}</div> : null}
              <div className="history-grid">
                <div>
                  <div className="tiny">Output</div>
                  <pre>{prettyJson(exec.output, 'No output.')}</pre>
                </div>
                <div>
                  <div className="tiny">Logs</div>
                  <pre>{exec.logs?.length ? exec.logs.map(log => `[${log.ts}] ${log.level.toUpperCase()} ${log.message}${log.data ? ` ${JSON.stringify(log.data)}` : ''}`).join('\n\n') : 'No logs.'}</pre>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  ) : (
    <section className="card"><div className="muted">No job selected.</div></section>
  );

  return (
    <div className="shell">
      <header className="topbar card">
        <div>
          <h1>Bah Browser API</h1>
          <p className="sub">React + Vite frontend for browser-agent jobs.</p>
        </div>
        <div className="pill-row">
          <span className="pill"><strong>Base URL</strong> <span className="mono">{baseUrl}</span></span>
          <span className="pill"><strong>Auth</strong> <span>{apiKey ? 'Bearer token set' : 'none'}</span></span>
          <span className="pill"><strong>Jobs</strong> <span>{jobs.length}</span></span>
        </div>
      </header>

      <nav className="tabs card">
        {(['dashboard', 'jobs', 'history', 'endpoints'] as View[]).map(item => (
          <button key={item} className={view === item ? 'active' : ''} onClick={() => setView(item)}>{item}</button>
        ))}
      </nav>

      <section className={`view ${view === 'dashboard' ? 'active' : ''}`}>
        <div className="grid dashboard-grid">
          <section className="card">
            <h2>Start here</h2>
            <p className="sub">Create browser jobs by pasting a real JSON example, then watch output and history update live.</p>
            <div className="action-row">
              <button onClick={() => void refresh()} disabled={loading}>Refresh jobs</button>
              <button className="ghost" onClick={() => setView('jobs')}>Go to jobs</button>
              <button className="ghost" onClick={() => onPreset('create_test')}>Load example job</button>
            </div>
            <div className={`status ${status.tone || ''}`}>{status.text}</div>
          </section>
          <section className="card">
            <h2>Endpoints</h2>
            <pre>{prettyJson(openApi, 'Loading OpenAPI...')}</pre>
          </section>
        </div>
      </section>

      <section className={`view ${view === 'jobs' ? 'active' : ''}`}>
        <div className="grid jobs-layout">
          <section className="card">
            <div className="section-head">
              <h2>{editingJobId ? 'Edit Job' : 'New Job'}</h2>
              <div className="action-row">
                <button className="ghost" onClick={() => onPreset('login')}>Login</button>
                <button className="ghost" onClick={() => onPreset('create_test')}>Create Test</button>
                <button className="ghost" onClick={() => onPreset('scrape')}>Scrape</button>
                <button className="ghost" onClick={() => {
                  setEditingJobId(null);
                  setForm({
                    name: '',
                    instruction: '',
                    outputExample: JSON.stringify({ username: 'LuizDavi', password: 'LuizDavi23' }, null, 2),
                    outputSchema: '',
                    examples: '[]',
                    requiredFields: '',
                    strict: false,
                    timeoutMs: '300000',
                    metadata: '',
                    idempotencyKey: '',
                  });
                }}>Clear</button>
              </div>
            </div>
            <form onSubmit={saveJob} className="form-grid">
              <label>
                API key
                <input value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Bearer token if required" />
              </label>
              <label>
                Job name
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
              </label>
              <label className="span-2">
                Instruction
                <textarea value={form.instruction} onChange={e => setForm({ ...form, instruction: e.target.value })} rows={6} />
              </label>
              <label className="span-2">
                Output example JSON
                <textarea value={form.outputExample} onChange={e => setForm({ ...form, outputExample: e.target.value })} rows={8} />
              </label>
              <label className="span-2">
                Inferred schema
                <pre>{prettyJson(inferredSchema, 'Paste a JSON example to infer the schema.')}</pre>
              </label>
              <label className="span-2">
                Force schema manually
                <textarea value={form.outputSchema} onChange={e => setForm({ ...form, outputSchema: e.target.value })} rows={8} placeholder='{"type":"object","properties":{"username":{"type":"string"}}}' />
              </label>
              <label>
                Examples JSON
                <textarea value={form.examples} onChange={e => setForm({ ...form, examples: e.target.value })} rows={4} />
              </label>
              <label>
                Required fields
                <input value={form.requiredFields} onChange={e => setForm({ ...form, requiredFields: e.target.value })} />
              </label>
              <label>
                Timeout ms
                <input value={form.timeoutMs} onChange={e => setForm({ ...form, timeoutMs: e.target.value })} type="number" />
              </label>
              <label>
                Metadata JSON
                <input value={form.metadata} onChange={e => setForm({ ...form, metadata: e.target.value })} />
              </label>
              <label>
                Idempotency key
                <input value={form.idempotencyKey} onChange={e => setForm({ ...form, idempotencyKey: e.target.value })} />
              </label>
              <label className="checkbox">
                <input checked={form.strict} onChange={e => setForm({ ...form, strict: e.target.checked })} type="checkbox" />
                Strict schema
              </label>
              <div className="span-2 action-row">
                <button type="submit">{editingJobId ? 'Update Job' : 'Create Job'}</button>
                <button type="button" className="ghost" onClick={() => void copy(`curl -X POST ${JSON.stringify(`${baseUrl}/jobs`)} -H "content-type: application/json" -d ${JSON.stringify(JSON.stringify({
                  name: form.name || 'example-job',
                  instruction: form.instruction || 'open google.com and collect data',
                  outputExample: (() => { try { return JSON.parse(form.outputExample); } catch { return null; } })(),
                }))}`)}>Copy create curl</button>
              </div>
            </form>
          </section>
          <section className="card">
            <h2>Jobs</h2>
            <div className="tiny">Desktop uses a grid. Mobile collapses into cards.</div>
            <div className="jobs-grid">{jobCards}</div>
          </section>
        </div>
      </section>

      <section className={`view ${view === 'history' ? 'active' : ''}`}>
        {historyPanel}
      </section>

      <section className={`view ${view === 'endpoints' ? 'active' : ''}`}>
        <div className="card">
          <h2>Endpoints</h2>
          <pre>{prettyJson(openApi, 'Loading OpenAPI...')}</pre>
        </div>
      </section>
    </div>
  );
}

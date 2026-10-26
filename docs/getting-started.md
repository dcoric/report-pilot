# Run Report Pilot locally

This guide starts the application, creates an administrator, and connects the included DVD Rental sample database. It uses Docker for PostgreSQL and runs the API and frontend on your machine.

## Prerequisites

- Node.js 22 and npm, matching the repository's `.nvmrc`.
- Docker with Docker Compose v2.
- A supported LLM provider account, or a reachable OpenAI-compatible local model, for natural-language generation.

## 1. Install and configure

```bash
git clone https://github.com/dcoric/report-pilot.git
cd report-pilot
npm run setup
cp .env.example .env
docker compose up -d db
```

Add this line to `.env` for the default local metadata database:

```dotenv
DATABASE_URL=postgresql://aidb:aidb@localhost:5433/aidb
```

`DATABASE_URL` connects the API to Report Pilot's own application storage: configuration, notes, RAG documents, history, and saved reports. It does not choose the database your reports query. Add each reporting database separately in **Datasets** (step 6); those connections can point to other servers and to a different database engine.

If you change `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, or `POSTGRES_PORT`, update the URL to match. These default credentials are for local development.

For external embeddings, set `OPENAI_API_KEY` or `GEMINI_API_KEY` in the same file. For a setup without embedding API calls, set `RAG_EMBED_PROVIDER=local`. See [RAG setup](rag.md#4-choose-embeddings-separately-from-sql-generation).

`.env` is ignored by Git. Do not put provider secrets in committed documentation or screenshots.

## 2. Start the API

In the first terminal:

```bash
node --env-file=.env --import tsx app/src/start.ts
```

The API applies metadata migrations at startup and listens on port `8080` by default. `APP_PORT` configures the Compose setup; a host-run API uses `PORT` if you need a different port.

Check readiness:

```bash
curl http://localhost:8080/ready
```

## 3. Create your administrator

After migrations complete, use a second terminal in the repository:

```bash
node --env-file=.env --import tsx scripts/create-user.ts \
  --email admin@example.com \
  --display-name 'Local Admin' \
  --role admin
```

The command prompts for a password. There is no bundled default application login.

## 4. Start the frontend

```bash
npm --prefix frontend run dev
```

Open the local URL printed by Vite, normally `http://localhost:5173`, and sign in. With the default configuration, Vite proxies API requests to `http://localhost:8080`.

If you set `VITE_API_BASE_URL` for a custom API port, use the same hostname for the UI and API. Mixing `localhost` and `127.0.0.1` causes cross-site session-cookie problems.

## 5. Configure a model

Open `/llm-providers` in the application and choose **Add Provider**:

1. Choose OpenAI, Gemini, DeepSeek, OpenRouter, or **Custom (OpenAI-compatible)**.
2. Enter the provider's secret API key in **API Key Reference**, or use a reference such as `env:OPENAI_API_KEY` when the key is already in the backend environment.
3. Enter a model ID available to your account and supported by the provider's endpoint.
4. Keep **Enable provider immediately** checked and save.

For custom providers, also supply a unique provider ID and a base URL ending in the provider's API prefix, such as `http://localhost:11434/v1`. The current custom adapter requires a nonempty API key reference even for a local server that does not check authentication.

The provider health indicator checks configuration; it does not establish that a key has credit or that a selected model accepts every request parameter. Test an actual query.

## 6. Load a sample reporting database

Start only the database service from the fixture Compose file:

```bash
docker compose -f test-data/docker-compose.yml up -d db
```

The fixture restores the bundled DVD Rental dataset and shifts its dates on first initialization so the latest rental and payment occur around yesterday. Its records are sample data, not customer production data. Reusing an existing Docker volume does not rerun initialization.

In **Datasets → Add Data Source**, choose PostgreSQL and use:

```text
postgresql://postgres:postgres@localhost:5440/dvdrental
```

This is the fixture's local administrator connection. For real reporting, create a read-only database account with only the schema access the application needs. The [screenshot walkthrough](examples/dvd-rental.md) uses a separate read-only account.

Choose **Introspect Schema**, then review the discovered objects. Add the revenue and date conventions from the [RAG guide](rag.md), and open **New Query**.

Try:

```text
Show monthly collected revenue, payment count, and average payment amount
for all available payment history, ordered by month.
```

Inspect the generated SQL, execute it, and review the results. Save a useful query and try an export. Use a known reference query to verify business correctness before treating a report as authoritative.

## Email and scheduled reports

Exports support JSON, CSV, TSV, Excel, and Parquet. Email delivery needs a working SMTP configuration. Configure the `SMTP_*` variables in `.env`, then restart the API.

To run saved-query schedules, also set:

```dotenv
SCHEDULE_DISPATCHER_ENABLED=true
SCHEDULE_DISPATCHER_INTERVAL_MS=60000
```

Scheduling is disabled by default. The current dispatcher assumes a single API process; multiple replicas need coordinated job claiming to avoid duplicate deliveries.

## Other entry points

- API reference: `http://localhost:8080/docs`
- OpenAPI schema: `http://localhost:8080/openapi.yaml`
- Liveness: `GET /health`
- Readiness: `GET /ready`
- [SQL Server fixture and DDL import instructions](../test-data/README.md)
- [Development and evaluation commands](development.md)

The repository also includes a multi-stage Dockerfile and `docker compose up --build` for the API, built frontend, and metadata database. For deployment, configure HTTPS, secure cookies, secrets, SMTP, and the worker environment explicitly. The host-run development steps above make initial user creation and model configuration easier to inspect.

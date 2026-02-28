# Test Data Setup

This folder contains local test database assets for Report Pilot.

## dvdrental (PostgreSQL via Docker)

Start the fixture:

```bash
docker compose -f test-data/docker-compose.yml up -d
```

Default connection strings:

- From host/WSL:
  - `postgresql://postgres:postgres@localhost:5440/dvdrental`
- From another container:
  - `postgresql://postgres:postgres@host.docker.internal:5440/dvdrental`
- Docker bridge gateway (Linux, usually):
  - `postgresql://postgres:postgres@172.17.0.1:5440/dvdrental`

Find the bridge gateway if needed:

```bash
docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'
```

## AdventureWorks2022 (Windows SQL Server Express + WSL)

Use this when SQL Server is running on Windows and the app is in WSL.

1. Configure `SQLEXPRESS`:
   - Enable TCP/IP.
   - Set fixed port (example `1433`).
   - Enable mixed auth mode.
   - Restart SQL Server service.
   - Open firewall inbound TCP rule for the SQL Server port.
2. Create login/user:

```sql
USE master;
CREATE LOGIN report_pilot WITH PASSWORD = 'UseAStrongPasswordHere!';

USE AdventureWorks2022;
CREATE USER report_pilot FOR LOGIN report_pilot;
ALTER ROLE db_datareader ADD MEMBER report_pilot;
GRANT VIEW DEFINITION TO report_pilot;
```

3. Install `sqlcmd` in WSL (Ubuntu 24.04 helper):

```bash
./test-data/install-mssql-tools.sh
```

4. Verify from WSL:

```bash
WIN_IP=$(ip route | awk '/default/ {print $3}')
sqlcmd -S "$WIN_IP,1433" -U report_pilot -P 'UseAStrongPasswordHere!' -d AdventureWorks2022 -C -Q "SELECT TOP 1 name FROM sys.tables"
```

5. Connection string for this app:

```text
Server=172.28.64.1,1433;Database=AdventureWorks2022;User Id=report_pilot;Password=UseAStrongPasswordHere!;Encrypt=True;TrustServerCertificate=True;
```

Replace `172.28.64.1` with your actual Windows host IP from:

```bash
ip route | awk '/default/ {print $3}'
```

Do not paste `<WIN_IP>` literally into the connection string.

Note: `Trusted_Connection=True` is not supported in this Linux runtime flow.

## Exporting MSSQL Schema via SSMS (for Import)

Large databases can be slow to introspect over the network. Use SSMS
**Generate Scripts** to export the schema as a `.sql` file, then import it
into Report Pilot.

1. In SSMS Object Explorer, right-click your database (e.g.
   `AdventureWorks2022`) → **Tasks** → **Generate Scripts…**
2. On the **Choose Objects** page select **Script entire database and all
   database objects**, or pick specific tables/views.
3. On the **Set Scripting Options** page:
   - Set output type to **Save to file** (single file).
   - Click **Advanced** and configure:
     - **Types of data to script** → `Schema only`
     - **Script Indexes** → `True`
     - **Script Primary Keys** → `True`
     - **Script Foreign Keys** → `True`
     - **Script Unique Keys** → `True`
   - Leave other advanced options at their defaults.
4. Finish the wizard. The output `.sql` file will contain `CREATE TABLE`,
   `ALTER TABLE … ADD FOREIGN KEY`, `CREATE INDEX`, etc.
5. In Report Pilot, add a new MSSQL data source and select **Import schema
   (upload DDL file)**, then choose the exported `.sql` file. Alternatively,
   use the Upload button on an existing data source row.

# Medplum On-Prem Deployment Notes

This note captures deployment options and trade-offs for bringing a
Medplum-based integration stack to an on-prem hospital site.

## Quick navigation

- [Deployment question](#deployment-question)
- [On-prem deployment model](#on-prem-deployment-model)
- [Why containers are useful on-prem](#why-containers-are-useful-on-prem)
- [What should not be shared with the hospital environment](#what-should-not-be-shared-with-the-hospital-environment)
- [Runtime topology example](#runtime-topology-example)
- [Docker Compose deployment option](#docker-compose-deployment-option)
- [Agent placement options](#agent-placement-options)
- [Windows hospital environments](#windows-hospital-environments)
- [Persistence and backup expectations](#persistence-and-backup-expectations)
- [Security and networking considerations](#security-and-networking-considerations)
- [What this means for our spike conclusion](#what-this-means-for-our-spike-conclusion)
- [Recommended next step](#recommended-next-step)

## Deployment question

How should Medplum be deployed on-prem in a way that stays operationally
simple, compatible with hospital IT constraints, and flexible across
Linux/Windows environments?

The main reason is isolation: Medplum needs its own application services and
stateful dependencies, and these should not interfere with existing hospital
systems already running on the same site. Running the Medplum stack in
containers avoids conflicts with local PostgreSQL, Redis, Node.js, or other
runtime dependencies already present in the hospital environment.

## On-prem deployment model

The Medplum platform stack (server, app, database, cache) runs as a single
deployment unit via Docker Compose. The agent is a separate decision point.

Core platform stack via Docker Compose:

1. Medplum server (Node.js app)
2. Medplum web app (Node.js app)
3. PostgreSQL (container)
4. Redis (container)
5. Optional: reverse proxy / TLS termination (container)

Agent placement options:

- In the same Compose file as a sixth service (simpler for hospital IT)
- On a separate dedicated host or container (cleaner network isolation)

Separation of concerns:

- All Medplum platform pieces run together in one Compose file
- Hospital source systems send HL7 only to the agent
- Downstream apps talk only to Medplum FHIR APIs

This gives a clean boundary between:

- hospital HL7 senders
- normalization/mapping logic
- app-facing FHIR consumption

The key advantage: one `docker-compose up` brings the whole platform to life,
and one `docker-compose down` removes it cleanly without interfering with
hospital systems.

## Why containers are useful on-prem

Benefits:

1. Avoid dependency conflicts with existing hospital software
   - no shared PostgreSQL installation
   - no shared Redis installation
   - no shared Node runtime assumptions
2. Easier repeatable installation across hospitals
   - same compose stack or deployment manifests at every site
3. Cleaner upgrade path
   - replace container images instead of hand-patching hosts
4. Better isolation for troubleshooting
   - logs and service boundaries are explicit
5. Easier rollback
   - revert image version or compose change set

## What should not be shared with the hospital environment

Recommended:

- Do not reuse an existing hospital PostgreSQL instance for Medplum
- Do not reuse an existing hospital Redis instance for Medplum
- Do not install Medplum runtime dependencies directly into shared system paths

Instead:

- run Medplum Postgres in its own container with its own data volume
- run Redis in its own container with its own config
- expose only the ports that are actually needed

This reduces the chance that an unrelated hospital system breaks the Medplum
stack or vice versa.

## Runtime topology example

A practical hospital-site deployment can look like this:

**Single Docker Compose stack (brings up all platform pieces):**

1. `postgres` service with persistent volume
2. `redis` service with persistent volume
3. `medplum-server` service
4. `medplum-app` service
5. `reverse-proxy` service for HTTPS and routing (optional but recommended)
6. `medplum-agent` service (optional: can run here or separately)

**Agent placement (hospital choice):**

- Option A: Include agent in the same Compose file (one deploy, one host)
- Option B: Run agent separately or on a different host (cleaner isolation)

Traffic flow:

1. HIS sends HL7 v2 over MLLP to the agent
2. Agent securely connects to Medplum
3. Bot transforms HL7 into FHIR resources
4. Apps read normalized FHIR resources from Medplum API

## Docker Compose deployment option

Docker Compose is a practical deployment model for many hospital sites.

Why Compose often fits well:

1. All platform components in one file: simple to understand and version-control
2. Easy to package and hand over to hospital ops teams
3. Works well for pilot and production deployments
4. Matches the current Medplum developer setup where Compose is already used
5. Hospital IT teams are usually familiar with Compose

Typical Compose stack:

```yaml
services:
  postgres: # data persistence
  redis: # caching and queues
  server: # Medplum FHIR API
  app: # Medplum web UI
  reverse-proxy: # TLS termination, optional
  agent: # MLLP listener, optional (can be separate)
```

For larger or more complex hospital rollouts, the same stack design can later
move to Kubernetes or another orchestrator without architectural changes.

## Agent placement options

The hospital chooses where the agent runs based on their network and approval
process.

### Option A: Agent in the same Compose stack

**Use when:**

- Docker networking is straightforward for inbound MLLP
- Hospital IT wants one simple deployment: `docker-compose up`
- no network/firewall complications for the agent container

**Pros:**

- all pieces in one file and one command
- easier upgrades (one image set)
- simple for pilot/smaller deployments

**Cons:**

- agent and platform scale together (may not be ideal if agent load differs)
- single host failure takes everything down

### Option B: Agent on a separate host or VM

**Use when:**

- Hospital IT wants clear separation: interface listener on its own machine
- the HIS network segment or firewall approval requires it
- agent load or uptime requirements differ from the platform

**Pros:**

- cleaner network isolation
- often easier for hospital IT and network teams to approve
- agent can be restarted independently of the platform

**Cons:**

- two deployment units to manage
- slightly more complex ops workflow

**Decision guidance:** Do not force a single default. Pick the agent placement based
on hospital network policy and operations model:

- Prefer Option A when one-host deployment and simpler operations are the top
  priority
- Prefer Option B when network segregation, firewall controls, or independent
  agent lifecycle are required

Either way, the agent remains the only system directly exposed to hospital HL7
senders.

## Windows hospital environments

Some hospitals run primarily on Windows infrastructure. In that case, keep the
same architecture but adjust runtime placement:

### Common production pattern

1. Run the Medplum platform stack (server/app/postgres/redis/reverse-proxy) on
   a Linux host or Linux VM using Docker Compose
2. Run the agent either:
   - in that same Linux Compose stack, or
   - on a separate Windows host using the official Medplum Agent installer
     (MSI/executable), entering required base URL, client ID, client secret,
     and agent ID during install (or using equivalent run-time env
     vars/parameters)

Why this pattern is common:

- Medplum platform dependencies are most predictable in Linux container runtime
- Hospital IT can still keep interface connectivity close to Windows-based HIS
  segments by placing the agent on Windows if needed

### Windows-specific operational notes

- Prefer the official Medplum Windows installer (MSI/executable) for
  production-friendly service installation and startup behavior
- The installer creates a Windows service named "Medplum Agent"
- Avoid using Docker Desktop as a production runtime
- Keep MLLP ingress only on the agent endpoint (Windows or Linux)
- Keep postgres and redis internal to the platform network
- Use the same bot code and FHIR model regardless of whether the agent runs on
  Windows or Linux

## Persistence and backup expectations

The stateful parts are:

1. PostgreSQL data
2. Redis data/config depending on operational setup
3. Medplum configuration and deployment artifacts

Minimum recommendation:

- persistent Docker volumes for PostgreSQL
- persistent config storage for server/app settings
- backup plan for PostgreSQL data
- version-controlled deployment manifests and bot source

Agent configuration note:

The required connectivity settings can be provided at install/run time. Hospital
IT can configure the agent via:

- Windows installer input (base URL, client ID, client secret, agent ID)
- Environment variables (e.g., `MEDPLUM_BASE_URL`, `AGENT_ID`, `CLIENT_SECRET`)
- Command-line parameters
- Docker Compose environment sections or `.env` files
- Kubernetes ConfigMaps or Secrets (if running on K8s later)

The `agent.properties` file is optional. It is mainly needed when you want
advanced logger configuration (for example separate main/channel log levels,
custom log directories, or rotation settings).

## Security and networking considerations

Common network model:

1. Expose HTTPS for Medplum app/API
2. Expose MLLP only on the agent side
3. Keep PostgreSQL and Redis internal to the deployment network
4. Use separate credentials for:
   - admin/ops access
   - hospital agent
   - downstream apps

Common access model:

- hospital sender never talks directly to Medplum server
- downstream apps never read raw HL7
- project-specific access policies should limit app/client scope where possible

## What this means for our spike conclusion

The spike suggests the following deployment strategy is realistic:

1. Use Medplum as the on-prem normalization and persistence layer
2. Run Medplum and its dependencies in isolated containers
3. Use project-specific bots to normalize hospital-specific HL7 differences
4. Let downstream apps consume only normalized FHIR resources from Medplum

This matches the original design goal: different hospitals may send different
HL7 details, but our apps should still see one consistent FHIR model.

## Recommended next step

For implementation planning, define a first deployment package containing:

1. container images to use/build
2. Docker Compose file for the platform stack
3. environment/config files for server/app
4. agent deployment decision: container vs dedicated host
5. backup, logging, and TLS handling

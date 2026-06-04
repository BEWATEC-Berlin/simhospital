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
- [Agent placement note](#agent-placement-note)
- [Windows hospital environments](#windows-hospital-environments)
- [Persistence and backup expectations](#persistence-and-backup-expectations)
- [Security and networking considerations](#security-and-networking-considerations)
- [Patient-facing app access boundary](#patient-facing-app-access-boundary)
- [Deployment takeaway](#deployment-takeaway)
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

Medplum commonly uses an on-prem agent that connects to a Medplum server run
outside the hospital environment.

For this project, an additional deployment model is important: run the Medplum
server and data stack in a hospital-controlled environment as well, so the data
remains on-prem or is only exposed through controlled application access.

That hospital-controlled model can be packaged as a single Docker Compose
deployment including server, database, cache, and agent, with app added when
needed.

Core platform stack via Docker Compose:

1. Medplum server (Node.js app)
2. Optional: Medplum web app (Node.js app)
3. PostgreSQL (container)
4. Redis (container)
5. Optional: reverse proxy / TLS termination (container)
6. Medplum Agent (container)

Admin access options when `medplum-app` is omitted:

- Use Medplum CLI from an admin workstation
- Use API-based admin automation from trusted tooling
- Use a centrally hosted Medplum web app (outside the hospital site) only if
  secure network access and access-control policy permit it
- Outside-hospital administration is possible through a controlled remote
  access path (for example VPN/private connectivity or restricted HTTPS ingress
  with strong authentication and allow-listing)

Separation of concerns:

- In the hospital-controlled model, all Medplum pieces run together in one
  Compose file
- Hospital source systems send HL7 only to the agent
- Downstream apps talk only to Medplum FHIR APIs

If hospital IT or infrastructure policy requires it, the agent can also run
separately while keeping the same Bot and FHIR flow.

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
4. optional `medplum-app` service
5. `reverse-proxy` service for HTTPS and routing (optional but recommended)
6. `medplum-agent` service (optional: can run here or separately)

If required by hospital infrastructure rules, the agent can instead run on a
separate host or container.

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
  app: # optional Medplum web UI
  reverse-proxy: # TLS termination, optional
  agent: # MLLP listener, optional (can be separate)
```

For larger or more complex hospital rollouts, the same stack design can later
move to Kubernetes or another orchestrator without architectural changes.

## Agent placement note

This note focuses on the all-in-one Compose model because it matches the
hospital-controlled deployment needed here.

If hospital IT requires a separate interface component, the agent can run on a
dedicated host or in a separate container while the rest of the Medplum stack
stays unchanged.

In all cases, the agent remains the only component exposed to hospital HL7
senders.

## Windows hospital environments

Some hospitals run primarily on Windows infrastructure. In that case, keep the
same architecture but adjust runtime placement:

### Common production pattern

1. Run the full Medplum stack in containers, typically on a Linux host or Linux
   VM using Docker Compose, when the server and data also need to stay in a
   hospital-controlled environment
2. If required, run the agent separately on Windows using the official Medplum
   Agent installer (MSI/executable)

Why this pattern is common:

- Medplum platform dependencies are predictable in a Linux container runtime
- Windows-based hospital environments can still keep the interface endpoint
  close to local systems when needed

### Windows-specific operational notes

- Prefer the official Medplum Windows installer (MSI/executable) for
  production-friendly service installation and startup behavior
- The installer creates a Windows service named "Medplum Agent"
- Avoid using Docker Desktop as a production runtime
- Other production-friendly choices can include a Linux VM running Docker
  Compose or another hospital-approved container platform/runtime
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

If a centrally hosted UI is used to administer multiple hospital projects,
restrict access with organization policy controls (for example VPN/private
network paths, IP allow-lists, and role-based client credentials).

## Patient-facing app access boundary

For patient apps, a useful boundary model is:

1. Keep Medplum runtime and data in a hospital-controlled environment.
2. Expose only a controlled app/API entrypoint for patient access.
3. Avoid broad direct FHIR access from mobile apps.
4. Return only app-relevant admission context (for example current bed location, insurance type, only needed user and case data).

Authentication/authorization patterns can include:

- Standard user auth (for example Keycloak) with project-scoped roles.
- Short-lived, signed code/token exchange flows for simplified login journeys.
- Strict token lifetime, replay protection, and scope limits.

For outside-hospital device access, keep the same boundary and enforce secure
remote controls (TLS, strong auth, allow-listing, and policy-based access).

## Deployment takeaway

This note supports the following deployment approach:

1. Use Medplum as the normalization layer and as a persistence layer for app-relevant integration data in a hospital-controlled environment
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

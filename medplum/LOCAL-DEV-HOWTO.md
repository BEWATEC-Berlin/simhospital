# Medplum Local Dev HOWTO (Agent + Bot)

This guide explains a practical local development setup for Medplum and how to
prepare a project to use an Agent and a Bot with SimHospital HL7 test traffic.

It intentionally keeps installation short and points to the official Medplum
contributor docs.

## Official references

- Local dev setup: https://www.medplum.com/docs/contributing/local-dev-setup
- Run the stack: https://www.medplum.com/docs/contributing/run-the-stack
- Agent setup: https://www.medplum.com/docs/agent
- Medplum CLI: https://www.medplum.com/docs/cli
- Agent UI walkthrough video: https://youtu.be/MmE3Dn939B4

## 1) Install and run Medplum locally (short version)

Follow the official local setup guide above for full details.

Key points from "Run the stack" (Docker path, recommended):

1. Prerequisites
   - Git
   - Node.js (check the current supported range in the Medplum repo root
     package.json `engines.node`, then install a matching version)
   - Docker

2. Clone Medplum

```bash
git clone https://github.com/medplum/medplum.git
cd medplum
```

3. Install dependencies and build

```bash
npm ci
npm run build
```

Quick-start alternative:

```bash
npm run build:fast
```

Use build:fast when you want a faster initial setup. It can skip parts of a
full build graph in some situations, so if you run into missing package/build
artifacts (for example around agent-related packages), run npm run build.

4. Start background services with Docker (Postgres + Redis)

```bash
docker compose up
# or: docker-compose up
```

5. In a new terminal, run Medplum server

```bash
cd packages/server
npm run dev
```

6. In another terminal, run Medplum app UI

```bash
cd packages/app
npm run dev
```

7. Verify
   - Health check: http://localhost:8103/healthcheck
   - App UI: http://localhost:3000

Local default login created by the dev server:

- Email: admin@example.com
- Password: medplum_admin

## 2) Create the required Medplum resources (UI method)

In the Medplum App, create these resources in this order:

These resources define the full message path. `Endpoint` is where HL7/MLLP
messages arrive, `Bot` contains your processing logic, and `Agent` links input
to processing. `ClientApplication` provides credentials so the agent host can
authenticate securely.

1. Endpoint
   - Resource type: Endpoint
   - Status: active
   - Connection type: HL7 v2 MLLP (`hl7v2-mllp`)
   - Address: `mllp://0.0.0.0:56000`
2. Bot
   - Note: Bots must be enabled first in project features before Bot resources
     can be created/deployed (edit the project in Super Admin, click
     "Add features", then enable "Bots").
   - Create/open a Bot in the Bot editor
   - Paste this repo's bot code from `medplum/simhospital-adt-bot.ts`
   - Save and Deploy

3. Agent
   - Resource type: Agent
   - Status: active
   - Add a channel that references:
     - Endpoint: the Endpoint above
     - Target reference: the Bot above
4. ClientApplication
   - Create a dedicated client app for the Agent
   - Save the generated `clientId` and `clientSecret`

Record these values for the host installation step:

- Base URL (for local stack usually http://localhost:8103)
- Client ID
- Client Secret
- Agent ID

## 3) Run an Agent host locally

### Option A: Run from source (good for local dev)

From Medplum repo root:

```bash
npm ci
cd packages/agent
npm run agent <base_url> <client_id> <client_secret> <agent_id>
```

Example:

```bash
npm run agent http://localhost:8103 <client_id> <client_secret> <agent_id>
```

Keep the terminal open so you can watch logs.

Use `agent.properties` for an easier local start:

If you do not want to type credentials each time, create an `agent.properties`
file in `packages/agent` and keep your values there.

Example:

```properties
baseUrl=http://localhost:8103/
clientId=<client-id>
clientSecret=<client_secret>
agentId=<agent_id>

# Optional: set log level (e.g. DEBUG, INFO, WARN, ERROR)
# logLevel=INFO
```

Available fields used by this local start pattern:

- `baseUrl`: Medplum base URL
- `clientId`: ClientApplication client ID
- `clientSecret`: ClientApplication client secret
- `agentId`: Agent resource ID
- `logLevel` (optional): Global log level for main + channel logs

Start command using this file:

```bash
cd packages/agent
npm run agent
```

The agent reads values from `agent.properties` when started this way.

### Option B: Use released binary

Use the install options documented on the Agent page for Linux/Windows hosts.
For local dev, Option A is usually easiest.

## 4) Bot deployment and updates with CLI

You can manage bot save/deploy from CLI.

1. Install CLI

```bash
npm install --global @medplum/cli
```

2. Login

```bash
medplum login
medplum whoami
```

3. Create `medplum.config.json` in your bot workspace and map your existing Bot
   ID to source files:

```json
{
  "bots": [
    {
      "name": "simhospital-adt-bot",
      "id": "<bot-id>",
      "source": "medplum/simhospital-adt-bot.ts"
    }
  ]
}
```

4. Save and deploy

```bash
npx medplum bot save simhospital-adt-bot
npx medplum bot deploy simhospital-adt-bot
```

## 5) Optional: Create Endpoint/Agent using CLI (FHIR JSON + POST)

If you prefer CLI over UI for resource creation, use `medplum post` with FHIR
JSON payloads.

Create Endpoint:

```bash
medplum post Endpoint '{
  "resourceType": "Endpoint",
  "status": "active",
  "name": "SimHospital MLLP Endpoint",
  "connectionType": {
    "system": "http://terminology.hl7.org/CodeSystem/endpoint-connection-type",
    "code": "hl7v2-mllp",
    "display": "HL7 v2 MLLP"
  },
  "payloadType": [
    {
      "coding": [
        {
          "system": "http://terminology.hl7.org/CodeSystem/endpoint-payload-type",
          "code": "any",
          "display": "Any"
        }
      ]
    }
  ],
  "address": "mllp://0.0.0.0:56000"
}'
```

Create Agent (replace IDs):

```bash
medplum post Agent '{
  "resourceType": "Agent",
  "name": "SimHospital Local Agent",
  "status": "active",
  "channel": [
    {
      "name": "ADT Channel",
      "endpoint": {
        "reference": "Endpoint/<endpoint-id>"
      },
      "targetReference": {
        "reference": "Bot/<bot-id>"
      }
    }
  ]
}'
```

Tip: Creating the ClientApplication is often easier in the UI because you can
copy credentials immediately.

## 6) End-to-end test

1. Ensure Agent is running and listening on MLLP port 56000.
2. Send an HL7 test message with Medplum CLI:

```bash
medplum hl7 send localhost 56000 --generate-example
```

3. Or run SimHospital against the Agent:

```bash
./simulator --local_path=$(pwd) --output=mllp --mllp_destination=localhost:56000
```

4. Confirm processing in Medplum App:
   - Bot -> Events tab
   - Agent -> Events tab
   - New/updated Patient, Encounter, Location resources

## Troubleshooting quick notes

- If Medplum server cannot connect to Postgres (`role "medplum" does not exist`),
  verify you do not have another local Postgres instance conflicting with Docker.
- If agent cannot connect, re-check `base_url`, `client_id`, `client_secret`, and
  `agent_id`.
- If messages are accepted but nothing is transformed, verify the Agent channel
  points to the correct Bot and that the Bot is deployed.

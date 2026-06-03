# Medplum On-Prem CLI HOWTO

This guide describes a CLI-first setup for an on-prem Medplum deployment used
by a hospital integration project.

For deployment strategy notes on how to run the Medplum stack at a hospital site
using containers, see [ON-PREM-DEPLOYMENT-NOTES.md](./ON-PREM-DEPLOYMENT-NOTES.md).

The target operating model is:

1. Medplum runs on-prem or in a controlled customer environment.
2. A project-specific bot normalizes hospital HL7 into a stable FHIR model.
3. A Medplum Agent runs near the hospital interface and receives HL7 over MLLP.
4. Our apps read the stored FHIR resources from Medplum through the FHIR API.

## Quick navigation

- [What this guide covers](#what-this-guide-covers)
- [Recommended deployment model](#recommended-deployment-model)
- [Prerequisites](#prerequisites)
- [1) Provision hospital integration resources with CLI](#1-provision-hospital-integration-resources-with-cli)
- [2) Configure the hospital-side agent host](#2-configure-the-hospital-side-agent-host)
- [3) Connect the hospital HL7 sender](#3-connect-the-hospital-hl7-sender)
- [4) Verify ingestion](#4-verify-ingestion)
- [5) How our apps access stored resources](#5-how-our-apps-access-stored-resources)
- [6) Design guidance for multiple hospitals](#6-design-guidance-for-multiple-hospitals)
- [Troubleshooting](#troubleshooting)

## What this guide covers

- Configure an on-prem Medplum instance from an external admin machine
- Provision ClientApplication, Bot, Endpoint, and Agent via CLI
- Configure the agent host with `agent.properties`
- Show how downstream apps access stored resources through FHIR API

## Recommended deployment model

For each hospital integration project, keep a separate project-level
configuration in Medplum:

- One Medplum project or integration scope per hospital/customer
- One bot per sender profile or mapping variant
- One agent per hospital site or environment
- Separate client credentials for:
  - hospital agent host
  - admin/ops automation
  - downstream apps

This keeps sender-specific HL7 mapping isolated while preserving a stable
app-facing FHIR shape.

## Prerequisites

You need:

- Reachable Medplum base URL, for example `https://medplum.your-domain.example`
- Admin access to the target Medplum project
- Node.js and Medplum CLI on the admin machine
- Bot source code, for example `medplum/simhospital-adt-bot.ts`
- Network path from hospital sender to the agent host MLLP port

Install CLI:

```bash
npm install --global @medplum/cli
```

Set the target Medplum base URL:

```bash
export MEDPLUM_BASE_URL=https://medplum.your-domain.example
```

Authenticate from the admin machine.

Interactive admin login:

```bash
medplum login
medplum whoami
```

For automation, you can instead export:

```bash
export MEDPLUM_CLIENT_ID=<admin-client-id>
export MEDPLUM_CLIENT_SECRET=<admin-client-secret>
```

Confirm project context:

```bash
medplum project list
medplum project switch <project-id>
medplum project current
```

## 1) Provision hospital integration resources with CLI

Recommended order:

1. Create ClientApplication for the hospital agent
2. Create Bot
3. Create Endpoint
4. Create Agent

### 1.1 Create ClientApplication for the agent host

Get the project ID:

```bash
medplum project current
```

Create the client:

```bash
medplum post admin/projects/<project-id>/client '{
  "name": "Hospital Agent Client",
  "description": "Client credentials used by the on-prem Medplum Agent"
}'
```

Save the returned values:

- `id` -> `clientId`
- `secret` -> `clientSecret`

If you already use access policies, you can attach an `accessPolicy` reference
in the same payload.

### 1.2 Create Bot

Create an empty bot resource:

```bash
medplum post Bot '{
  "resourceType": "Bot",
  "name": "Hospital ADT Bot"
}'
```

Take the returned Bot `id` and create a local `medplum.config.json`:

```json
{
  "bots": [
    {
      "name": "hospital-adt-bot",
      "id": "<bot-id>",
      "source": "medplum/simhospital-adt-bot.ts"
    }
  ]
}
```

Save and deploy bot code:

```bash
npx medplum bot save hospital-adt-bot
npx medplum bot deploy hospital-adt-bot
```

### 1.3 Create Endpoint

The Endpoint represents the hospital-side feed connection the agent will expose.

```bash
medplum post Endpoint '{
  "resourceType": "Endpoint",
  "status": "active",
  "name": "Hospital ADT MLLP Endpoint",
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

Save the returned Endpoint `id`.

### 1.4 Create Agent

Create the Agent and link it to the Endpoint and Bot:

```bash
medplum post Agent '{
  "resourceType": "Agent",
  "name": "Hospital Site Agent",
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

Save the returned Agent `id`.

At this point you have the four main values needed on the hospital host:

- `baseUrl`
- `clientId`
- `clientSecret`
- `agentId`

## 2) Configure the hospital-side agent host

The agent host is the machine inside the hospital network that accepts HL7 and
forwards it securely to Medplum.

Create `agent.properties` in the agent installation directory:

```properties
baseUrl=https://medplum.your-domain.example/
clientId=<client-id>
clientSecret=<client-secret>
agentId=<agent-id>

# Optional
# logLevel=INFO
```

If you run from source:

```bash
cd packages/agent
npm run agent
```

If you run a released Linux binary:

```bash
./medplum-agent-linux
```

The agent reads configuration from `agent.properties` when started this way.

## 3) Connect the hospital HL7 sender

Point the hospital HL7 sender to the agent host MLLP port defined by the
Endpoint, for example:

- Host: the hospital agent machine
- Port: `56000`
- Protocol: HL7 v2 over MLLP

For local testing with SimHospital:

```bash
./simulator --local_path=$(pwd) --output=mllp --mllp_destination=localhost:56000
```

## 4) Verify ingestion

Check all three layers:

1. Agent logs show successful connection to Medplum and incoming HL7 traffic.
2. Bot events show executions in Medplum.
3. FHIR resources appear in Medplum: Patient, Encounter, Location, Coverage.

Simple HL7 test with CLI:

```bash
medplum hl7 send localhost 56000 --generate-example
```

## 5) How our apps access stored resources

The purpose of this setup is not only ingestion, but also a stable read model
for downstream apps.

Recommended pattern:

1. Use a dedicated ClientApplication for each app or service.
2. Give that client only the access it needs.
3. Read normalized FHIR resources from Medplum, not raw HL7.

Create an app client:

```bash
medplum post admin/projects/<project-id>/client '{
  "name": "Hospital App Client",
  "description": "Client credentials for downstream app access"
}'
```

The app then authenticates against the same Medplum base URL and reads FHIR
resources from the project.

Typical app queries:

Get active encounter with patient and current location by case/visit number:

```http
GET /fhir/R4/Encounter?identifier=urn:oid:patient-visit-number|<caseId>&status=in-progress&_include=Encounter:patient&_include=Encounter:location
```

Get active encounter with insurance/payor context:

```http
GET /fhir/R4/Encounter?identifier=urn:oid:patient-visit-number|<caseId>&status=in-progress&_include=Encounter:patient&_include=Encounter:location&_revinclude:iterate=Coverage:beneficiary&_include:iterate=Coverage:payor
```

Resolve a patient directly by MRN:

```http
GET /fhir/R4/Patient?identifier=urn:oid:patient-mrn|<mrn>
```

CLI examples from an external machine:

```bash
export MEDPLUM_BASE_URL=https://medplum.your-domain.example
export MEDPLUM_CLIENT_ID=<app-client-id>
export MEDPLUM_CLIENT_SECRET=<app-client-secret>

medplum get 'Encounter?identifier=urn:oid:patient-visit-number|CASE123&status=in-progress&_include=Encounter:patient&_include=Encounter:location'
medplum get 'Patient?identifier=urn:oid:patient-mrn|MRN12345'
```

This is the key architecture point: hospital-specific HL7 differences are
handled in the bot, while apps consume one stable FHIR model.

## 6) Design guidance for multiple hospitals

Different hospitals may populate HL7 differently even when all claim to send
ADT. Common differences include:

- case/visit identifier location
- PV1 location semantics
- insurance/public-private encoding

Recommended approach:

1. Keep hospital-specific mapping in the project bot.
2. Normalize into the same FHIR shape for apps.
3. Keep identifiers stable so upserts remain idempotent.

## Troubleshooting

- If the agent cannot connect, verify `baseUrl`, `clientId`, `clientSecret`, and `agentId`.
- If HL7 arrives but no resources are created, verify Agent channel wiring to the correct Bot.
- If app reads fail, verify the app client has access to the project/resources it needs.
- If local Postgres conflicts with Docker-based Medplum, stop the other Postgres instance.

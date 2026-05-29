# Medplum ADT Bot

This folder contains a [Medplum](https://www.medplum.com/) bot that consumes
HL7v2 ADT messages produced by SimHospital and stores them as FHIR R4 resources.

## What it does

The bot receives ADT messages via a Medplum MLLP Agent (TCP listener) and
creates or updates the following FHIR resources for each message:

| HL7v2 event              | Action                                                        |
| ------------------------ | ------------------------------------------------------------- |
| A01 Admit / A04 Register | Create/update **Patient** + **Location** + open **Encounter** |
| A02 Transfer             | Move **Encounter** to new **Location**                        |
| A03 Discharge            | Close **Encounter** (status = `finished`)                     |
| A08 Update patient       | Update **Patient** demographics                               |
| A11 Cancel admit         | Cancel **Encounter** (status = `cancelled`)                   |
| A12 Cancel transfer      | Revert **Encounter** location                                 |
| A13 Cancel discharge     | Re-open **Encounter** (status = `in-progress`)                |

Insurance data from the `IN1` segment is stored as a **Coverage** resource
linked to an **Organization** (the payor).

## Architecture

```
SimHospital  ──MLLP──►  Medplum Agent  ──►  Medplum Bot (this file)
                         (TCP listener)        │
                                               ├─► Patient
                                               ├─► Location
                                               ├─► Encounter
                                               ├─► Organization  (payor)
                                               └─► Coverage      (insurance)
```

## Files

| File                     | Purpose                                          |
| ------------------------ | ------------------------------------------------ |
| `simhospital-adt-bot.ts` | Bot source code — deploy this to Medplum         |
| `package.json`           | Dev dependencies for local type-checking only    |
| `tsconfig.json`          | TypeScript compiler config for local IDE support |

## Local setup (type-checking / IDE support only)

The bot does **not** need to be compiled locally — Medplum bundles it
server-side on deploy. The npm packages here are only needed so VS Code
resolves the `@medplum/core` and `@medplum/fhirtypes` types without errors.

```shell
cd medplum
npm install
```

After `npm install`, all type errors in `simhospital-adt-bot.ts` will resolve.
To verify the file is type-correct:

```shell
npx tsc --noEmit
```

## Deploying to Medplum

1. Open the [Medplum App](https://app.medplum.com/) and navigate to **Bots**.
2. Create a new Bot (or open the existing one).
3. Paste the contents of `simhospital-adt-bot.ts` into the bot editor.
4. Click **Save** and then **Deploy**.

## Connecting SimHospital via MLLP

Start the Medplum Agent so it is listening on a port (e.g. `56000`), then start
SimHospital pointing at it:

```shell
./simulator --local_path=$(pwd) \
  --output=mllp \
  --mllp_destination=localhost:56000
```

See [docs/run-with-go.md](../docs/run-with-go.md) for full MLLP options
(keep-alive reconnect, file buffering, etc.).

## Querying the resulting FHIR resources

Primary app flow should query by current medical case ID (visit number), because
in-hospital patients are tracked by their active visit.

```http
# Full in-hospital context in one call (preferred)
GET /fhir/R4/Encounter?identifier=urn:oid:patient-visit-number|<caseId>&status=in-progress&_include=Encounter:patient&_include=Encounter:location&_revinclude:iterate=Coverage:beneficiary&_include:iterate=Coverage:payor
```

Returns active Encounter + Patient + current Location + Coverage + payor.

If iterative include is not supported:

```http
# 1) Encounter + patient + location
GET /fhir/R4/Encounter?identifier=urn:oid:patient-visit-number|<caseId>&status=in-progress&_include=Encounter:patient&_include=Encounter:location

# 2) Coverage (+ payor) for the resolved patient (same Medplum Patient/<patientResourceId>)
GET /fhir/R4/Coverage?beneficiary=Patient/<patientResourceId>&_include=Coverage:payor
```

Optional less strict variant (only if caseId values are globally unique):

```http
GET /fhir/R4/Encounter?identifier=<caseId>&status=in-progress&_include=Encounter:patient&_include=Encounter:location
```

### MRN queries: useful for identity lookup, not current in-hospital context

MRN helps find the patient record, but by itself it does not guarantee active
encounter context (current location and active case insurance).

```http
# Preferred MRN query
GET /fhir/R4/Patient?identifier=urn:oid:patient-mrn|<mrnValue>

# Fallback MRN query without system (less strict)
GET /fhir/R4/Patient?identifier=<mrnValue>
```

### Patient resource ID queries: internal/testing only

`Patient/<patientResourceId>` is the Medplum system resource ID. External hospital systems
typically do not know this ID, so these queries are mainly for internal tools,
debugging, or follow-up calls after you already resolved a patient in Medplum.

```http
# Direct patient resource lookup
GET /fhir/R4/Patient/<patientResourceId>

# Active context for known Medplum patient ID
GET /fhir/R4/Encounter?patient=<patientResourceId>&status=in-progress&_include=Encounter:patient&_include=Encounter:location

# Encounter history for known Medplum patient ID
GET /fhir/R4/Encounter?patient=<patientResourceId>&_include=Encounter:patient&_include=Encounter:location

# Coverage (+ payor) for known Medplum patient ID
GET /fhir/R4/Coverage?beneficiary=Patient/<patientResourceId>&_include=Coverage:payor

# Coverage + beneficiary + payor in one call
GET /fhir/R4/Coverage?beneficiary=Patient/<patientResourceId>&_include=Coverage:beneficiary&_include=Coverage:payor
```

### Sender-dependent option

Some senders expose visit number as a Patient identifier, but this is less
reliable than Encounter-by-caseId queries:

```http
GET /fhir/R4/Patient?identifier=urn:oid:patient-visit-number|<caseId>
```

## Insurance field handling

The bot writes insurance data in two places:

- Canonical case insurance in `Coverage` (linked to patient via `Coverage.beneficiary` and payor via `Coverage.payor`)
- Convenience mirror on `Patient.extension` with URL `urn:insurance-type`

Why the Patient extension exists:

- Fast/simple patient-centric reads (for lightweight UI displays)
- Easier debugging when opening a single Patient resource

Caveats and implications:

- The Patient extension is a summary convenience value, not the full insurance model
- A patient can have multiple encounters/cases over time, with different insurance contexts
- If payer or plan details are needed, `Coverage` is the authoritative source

Recommendation for app logic:

1. Start from the active case (`Encounter` by caseId / visit number).
2. Use included/revincluded `Coverage` (+ payor Organization) for eligibility and service decisions.
3. Treat `Patient.extension[urn:insurance-type]` as informational fallback only.

## Identifier systems used

These URI systems are shared integration contracts, not bot-local constants.
The table below shows the current defaults used in this spike/bot setup.

For multi-hospital setups, use source-scoped naming (see section below) so
identifiers stay unique per hospital/source. Keep all URI values aligned with
your canonical identifier catalog and change them only in a coordinated rollout.

| Constant                    | System URI                       | Description            |
| --------------------------- | -------------------------------- | ---------------------- |
| `SYSTEM_MRN`                | `urn:oid:patient-mrn`            | Patient MRN            |
| `SYSTEM_VISIT`              | `urn:oid:patient-visit-number`   | Visit/encounter number |
| `SYSTEM_LOCATION`           | `urn:oid:location-id`            | Ward/bed identifier    |
| `SYSTEM_INSURANCE_PAYOR`    | `urn:oid:insurance-payor-id`     | Insurance company      |
| `SYSTEM_INSURANCE_COVERAGE` | `urn:oid:insurance-coverage-key` | Coverage record key    |

### Multi-hospital naming strategy (recommended)

If one Medplum project stores data for multiple hospitals/sources, use
source-scoped system URIs to avoid identifier collisions.

Required pattern for multi-hospital setups:

- `urn:oid:<HospitalName/ID>-patient-visit-number`

Examples:

- `urn:oid:simhospital-patient-visit-number`
- `urn:oid:DRKBerlin-patient-visit-number`

The same idea can be applied to MRN, location, and insurance identifier
systems when those values may overlap across hospitals.

Implications by deployment model:

- Multiple hospitals in one Medplum project:
  source-scoped `Identifier.system` values are strongly recommended.
  Otherwise, identical case/MRN values from different hospitals can collide.
- One Medplum server per hospital integration project (current spike setup):
  cross-hospital collisions are naturally isolated by deployment, so simpler
  generic system URIs can work. Source-scoped URIs are still useful if you may
  consolidate data later.

Recommendation:

1. Decide and document a stable URI naming convention per source/hospital.
2. Query identifiers using `system|value` (not unscoped value) in app logic.
3. Avoid renaming system URIs frequently; changes require migration planning.

## Location ID construction

Location resources are upserted from PV1-3 fields and use a stable composite
identifier so repeated messages map to the same Location.

Current location ID formula:

- Source fields: Facility (PV1-3.4), Building (PV1-3.7), Point of Care/Ward (PV1-3.1), Room (PV1-3.2), Bed (PV1-3.3)
- Construction: join all non-empty parts with a dash
- Example: `MAIN-B1-ICU-201-1`

Note: this is a practical default for this project. Other hospital projects may
construct location IDs differently depending on which PV1-3 parts are reliably
provided (for example, building missing, or department info being sent in
facility while Point of Care is empty).

This identifier is written as `Location.identifier` with system
`urn:oid:location-id`, and is also used to find/update existing Location
resources.

If you change this formula later, consider the migration impact for your
project scope:

- Existing Location resources may no longer match new messages
- Encounter location history may split across old/new Location IDs
- Downstream apps may lose continuity if they key by location identifier

In many setups this is project-specific and can be handled incrementally,
rather than requiring a single all-locations migration across all systems.

Recommended rollout for formula changes:

1. Define a project-appropriate canonical rule (aligned with shared URI standards).
2. Add a backward-compatible lookup path (old ID and new ID) during transition.
3. Backfill or map historical Locations where needed before removing legacy support.

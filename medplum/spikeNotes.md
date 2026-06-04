# Spike conclusion aligned to original ticket

**Execution note**

- The ticket scope names OpenMRS as source.
- For spike execution, SimHospital was used as a practical OpenMRS substitute to generate repeatable HL7 ADT pathways faster.
- The intent and acceptance checks stayed the same: HL7 v2 in, FHIR in Medplum out, FHIR read-back proven.

**What we wanted to achieve**

1. Collect patient + location context data from an HL7 v2 HIS feed.
2. Store translated data in Medplum as FHIR resources.
3. Prove downstream services can read that context back via FHIR API.

**Scope (as executed)**

1. Source: SimHospital-generated HL7 v2 ADT (stand-in for OpenMRS HL7 v2).
2. Target: Medplum with persisted resources.
3. Consumption: FHIR API read-back from Medplum.

**Out of scope (unchanged)**

1. Authentication/login flows.
2. Accounting/billing/payment.
3. Clinical data beyond minimal dataset.
4. Full multi-HIS rollout implementation.

**Definition of Done result**

1. Ingestion feasibility
   Status: Achieved.
   - HL7 ADT messages are ingested through Medplum Agent over MLLP.
   - Bot logic transforms and persists via Medplum FHIR APIs.
   - No manual database edits were needed.

2. Field coverage
   Status: Achieved at spike depth (with known variance points).
   Mapped and persisted:
   - Patient ID/MRN, case/visit identifier, name, DOB, gender.
   - Address fields when present in HL7.
   - Location context (building/department/room/bed) as provided.
   - Insurance/public-private best-effort when IN1 content is present.
     Known unstable/missing-by-sender areas:
   - Where case/visit number is populated.
   - Which PV1 location subfield carries department vs facility semantics.
   - Insurance coding/completeness and private/public signaling.

3. Idempotency approach
   Status: Defined.
   - Patient upsert by MRN identifier system/value.
   - Encounter upsert by visit/case identifier system/value.
   - Location upsert by deterministic location identifier derived from PV1 components.
   - Coverage/payor upsert by deterministic insurance/payor keys.
   - Rule: identifier-based upserts only (no blind creates).

4. FHIR read-back works
   Status: Achieved.
   Example query 1 (active encounter + patient + location):

```http
GET /fhir/R4/Encounter?identifier=urn:oid:patient-visit-number|CASE123&status=in-progress&_include=Encounter:patient&_include=Encounter:location
```

Example query 2 (active context + coverage + payor):

```http
GET /fhir/R4/Encounter?identifier=urn:oid:patient-visit-number|CASE123&status=in-progress&_include=Encounter:patient&_include=Encounter:location&_revinclude:iterate=Coverage:beneficiary&_include:iterate=Coverage:payor
```

Example query 3 (patient by MRN):

```http
GET /fhir/R4/Patient?identifier=urn:oid:patient-mrn|MRN12345
```

5. Portability notes (design guidance for future HIS providers)
   - Case number location in HL7 can vary by hospital/vendor profile.
   - Location semantics can be distributed differently across PV1 subfields.
   - Insurance/private-public representation can differ or be incomplete.

**Design conclusion for upcoming HIS interface work**

Medplum is viable as a reusable normalization/persistence layer for HL7-to-FHIR context data. The scaling mechanism is project-specific bot mapping per HIS profile, while keeping a stable FHIR shape for app consumption.

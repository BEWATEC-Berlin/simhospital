// SPDX-License-Identifier: Apache-2.0
//
// ADT Bot — parses HL7 v2 ADT messages from SimHospital and persists:
//   - Patient  (PID segment)
//   - Location (PV1-3 segment)
//   - Encounter (links Patient ↔ Location, tracks admission/discharge)
//   - Coverage (IN1 segment, links insurance to Patient)
//   - Organization (insurance payor from IN1)
//
// Supported message events:
//   A01 Admit          → create/update Patient + Location + open Encounter
//   A02 Transfer       → move Encounter to new Location
//   A03 Discharge      → close Encounter (status = finished)
//   A04 Register       → same as A01
//   A08 Update patient → update Patient demographics only
//   A11 Cancel admit   → cancel Encounter
//   A12 Cancel transfer→ revert location change
//   A13 Cancel discharge → re-open Encounter
//   IN1 present         → create/update Coverage (+ payor Organization)

// Primary query pattern (recommended for in-hospital apps):
// - Full context by current case ID (visit number) in one call:
//   GET /fhir/R4/Encounter?identifier=urn:oid:patient-visit-number|<caseId>&status=in-progress&_include=Encounter:patient&_include=Encounter:location&_revinclude:iterate=Coverage:beneficiary&_include:iterate=Coverage:payor
//   Returns active encounter + patient + current location + insurance coverage + payor.

// Fallback if your server/search setup does not support iterative include:
// 1) GET /fhir/R4/Encounter?identifier=urn:oid:patient-visit-number|<caseId>&status=in-progress&_include=Encounter:patient&_include=Encounter:location
// 2) GET /fhir/R4/Coverage?beneficiary=Patient/<patientResourceId>&_include=Coverage:payor

// Additional query options:
// - Scoped caseId encounter query (strict, preferred over unscoped):
//   GET /fhir/R4/Encounter?identifier=urn:oid:patient-visit-number|<caseId>&status=in-progress&_include=Encounter:patient&_include=Encounter:location
// - Unscoped caseId encounter query (less strict):
//   GET /fhir/R4/Encounter?identifier=<caseId>&status=in-progress&_include=Encounter:patient&_include=Encounter:location
//
// - Resolve patient by MRN:
//   GET /fhir/R4/Patient?identifier=urn:oid:patient-mrn|<mrnValue>
// - MRN fallback without system (not recommended if multiple systems exist):
//   GET /fhir/R4/Patient?identifier=<mrnValue>
//
// - Resolve patient by visit number on Patient (optional sender-dependent path):
//   GET /fhir/R4/Patient?identifier=urn:oid:patient-visit-number|<caseId>
//   Note: this can be less reliable than Encounter queries if senders do not
//   consistently populate Patient identifiers for visit numbers.

// Direct Patient resource lookup (debug/testing convenience):
//   GET /fhir/R4/Patient/<patientResourceId>
// Queries for a known Patient resource ID (debug/testing convenience):
// - Active context for known patient system resource ID:
//   GET /fhir/R4/Encounter?patient=<patientResourceId>&status=in-progress&_include=Encounter:patient&_include=Encounter:location
// - Encounter history for a known patient:
//   GET /fhir/R4/Encounter?patient=<patientResourceId>&_include=Encounter:patient&_include=Encounter:location
// - Coverage (+ payor) for a known patient:
//   GET /fhir/R4/Coverage?beneficiary=Patient/<patientResourceId>&_include=Coverage:payor
// - Coverage + beneficiary + payor in one call:
//   GET /fhir/R4/Coverage?beneficiary=Patient/<patientResourceId>&_include=Coverage:beneficiary&_include=Coverage:payor

import type { BotEvent, Hl7Message, MedplumClient } from '@medplum/core';
import type {
  Coding,
  Coverage,
  Encounter,
  Identifier,
  Location,
  Organization,
  Patient,
} from '@medplum/fhirtypes';

// ─── System URIs ─────────────────────────────────────────────────────────────
// These identifiers are integration-level URI namespaces, not bot-specific IDs.
// Keep them aligned with the shared/canonical URI set used across your apps,
// pipelines, and downstream services so cross-system lookups stay stable.
const SYSTEM_MRN = 'urn:oid:patient-mrn';
const SYSTEM_VISIT = 'urn:oid:patient-visit-number';
const SYSTEM_LOCATION = 'urn:oid:location-id';
const SYSTEM_INSURANCE_PAYOR = 'urn:oid:insurance-payor-id';
const SYSTEM_INSURANCE_COVERAGE = 'urn:oid:insurance-coverage-key';

// ─── Entry point ─────────────────────────────────────────────────────────────
export async function handler(
  medplum: MedplumClient,
  event: BotEvent,
): Promise<Hl7Message> {
  const msg = event.input as Hl7Message;

  const messageType = msg.getSegment('MSH')?.getField(9)?.getComponent(1);
  const eventType = msg.getSegment('MSH')?.getField(9)?.getComponent(2);

  if (messageType !== 'ADT') {
    return msg.buildAck();
  }

  console.log(`Processing ADT^${eventType}`);

  try {
    // Patient upsert is done for all ADT events
    const patient = await upsertPatient(medplum, msg);
    console.log(`Patient: ${patient.id}`);

    // Insurance upsert from IN1 is best-effort and independent of ADT event subtype
    await upsertCoverageFromIn1(medplum, msg, patient);

    // Encounter/Location management depends on event type
    switch (eventType) {
      case 'A01': // Admit
      case 'A04': // Register
        await handleAdmit(medplum, msg, patient);
        break;
      case 'A02': // Transfer
        await handleTransfer(medplum, msg, patient);
        break;
      case 'A03': // Discharge
        await handleDischarge(medplum, msg, patient);
        break;
      case 'A11': // Cancel admit
        await handleCancelAdmit(medplum, msg, patient);
        break;
      case 'A13': // Cancel discharge → re-open
        await handleAdmit(medplum, msg, patient);
        break;
      case 'A08': // Update patient info only — already handled above
        break;
      default:
        console.log(`Unhandled ADT event: ${eventType}`);
    }
  } catch (err) {
    // Always ACK the sender — log the error internally so SimHospital doesn't time out
    console.error(
      `Error processing ADT^${eventType}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  return msg.buildAck();
}

// ─── Patient ─────────────────────────────────────────────────────────────────

async function upsertPatient(
  medplum: MedplumClient,
  msg: Hl7Message,
): Promise<Patient> {
  const pid = msg.getSegment('PID');

  // PID-3: repeating field — find MRN (type MR) and visit number (type VN/FN)
  // The visit number is used as a fallback identifier for patient lookup if MRN is not present,
  // and is also stored as an encounter identifier for more reliable querying by case ID.
  // The visit number is often the only stable identifier across multiple messages for the same patient in a given admission,
  // since some senders put the MRN only in the initial admit message and omit it in subsequent updates,
  // while the visit number is consistently present in all messages.
  // This means the visit number might not be contained in the patient resource as an identifier,
  // but it is still useful for reliably linking encounters to the same patient across messages.
  const { mrn, visitNumber } = extractPid3Identifiers(pid);

  if (!mrn) {
    throw new Error('PID-3 contains no usable patient identifier');
  }

  // Demographics
  const familyName = pid?.getField(5)?.getComponent(1) || undefined;
  const givenName = pid?.getField(5)?.getComponent(2) || undefined;
  const dob = parseDateString(pid?.getField(7)?.getComponent(1) || undefined);
  const gender = mapGender(pid?.getField(8)?.getComponent(1) || undefined);

  // PID-11: address
  const addrStreet = pid?.getField(11)?.getComponent(1) || undefined;
  const addrStreetNo = pid?.getField(11)?.getComponent(2) || undefined;
  const addrCity = pid?.getField(11)?.getComponent(3) || undefined;
  const addrState = pid?.getField(11)?.getComponent(4) || undefined;
  const addrPostal = pid?.getField(11)?.getComponent(5) || undefined;
  const addrCountry = pid?.getField(11)?.getComponent(6) || undefined;
  const streetLine =
    [addrStreet, addrStreetNo].filter(Boolean).join(' ') || undefined;

  // Insurance: IN1 segment (best-effort)
  const insuranceType = extractInsuranceType(msg);

  // Build identifier list
  const identifiers: Identifier[] = [{ system: SYSTEM_MRN, value: mrn }];
  if (visitNumber) {
    identifiers.push({ system: SYSTEM_VISIT, value: visitNumber });
  }

  const existing = await medplum.searchOne(
    'Patient',
    `identifier=${SYSTEM_MRN}|${mrn}`,
  );

  const patientResource: Patient = {
    ...(existing ?? { resourceType: 'Patient' }),
    identifier: identifiers,
    name: [{ family: familyName, given: givenName ? [givenName] : undefined }],
    ...(dob ? { birthDate: dob } : {}),
    ...(gender ? { gender } : {}),
    address:
      streetLine || addrCity || addrPostal
        ? [
            {
              line: streetLine ? [streetLine] : undefined,
              city: addrCity,
              state: addrState,
              postalCode: addrPostal,
              country: addrCountry,
            },
          ]
        : undefined,
    // Convenience mirror for quick Patient reads.
    // Canonical insurance data is stored as Coverage, linked to this patient via Coverage.beneficiary = Patient/<patientResourceId>,
    // with insurance typing on Coverage.type.
    ...(insuranceType
      ? {
          extension: [
            { url: 'urn:insurance-type', valueString: insuranceType },
          ],
        }
      : {}),
  };

  return existing
    ? medplum.updateResource<Patient>(patientResource)
    : medplum.createResource<Patient>(patientResource);
}

// ─── Location ─────────────────────────────────────────────────────────────────

/**
 * Upsert a Location resource from PV1-3 components.
 * PV1-3: Point of Care ^ Room ^ Bed ^ Facility ^ ^ ^ Building
 */
async function upsertLocation(
  medplum: MedplumClient,
  msg: Hl7Message,
): Promise<Location | undefined> {
  const pv1 = msg.getSegment('PV1');
  if (!pv1) return undefined;

  // PV1-3 is a composite field with subcomponents for point of care, room, bed, etc.
  // This mapping is based on common HL7 conventions but may need adjustment for specific senders.
  // Some senders provide only one location subcomponent (e.g., only bed or facility) and still
  // expect it to identify a unique location, so we accept partial payloads.
  const pointOfCare = pv1.getField(3)?.getComponent(1) || undefined; // ward / department
  const room = pv1.getField(3)?.getComponent(2) || undefined;
  const bed = pv1.getField(3)?.getComponent(3) || undefined;
  const facility = pv1.getField(3)?.getComponent(4) || undefined;
  const building = pv1.getField(3)?.getComponent(7) || undefined;

  if (!pointOfCare && !room && !bed && !facility && !building) return undefined;

  // Stable location ID: combine all non-empty parts
  const locationId = [facility, building, pointOfCare, room, bed]
    .filter(Boolean)
    .join('-');
  const displayName = [facility, building, pointOfCare, room, bed]
    .filter(Boolean)
    .join(' / ');

  const existing = await medplum.searchOne(
    'Location',
    `identifier=${SYSTEM_LOCATION}|${locationId}`,
  );

  const locationResource: Location = {
    ...(existing ?? { resourceType: 'Location' }),
    identifier: [{ system: SYSTEM_LOCATION, value: locationId }],
    name: displayName,
    status: 'active',
    description: [
      facility ? `Facility: ${facility}` : '',
      building ? `Building: ${building}` : '',
      pointOfCare ? `Ward/Dept: ${pointOfCare}` : '',
      room ? `Room: ${room}` : '',
      bed ? `Bed: ${bed}` : '',
    ]
      .filter(Boolean)
      .join(', '),
    physicalType: bed
      ? {
          coding: [
            {
              system:
                'http://terminology.hl7.org/CodeSystem/location-physical-type',
              code: 'bd',
              display: 'Bed',
            },
          ],
        }
      : {
          coding: [
            {
              system:
                'http://terminology.hl7.org/CodeSystem/location-physical-type',
              code: 'ro',
              display: 'Room',
            },
          ],
        },
  };

  return existing
    ? medplum.updateResource<Location>(locationResource)
    : medplum.createResource<Location>(locationResource);
}

// ─── Encounter management ─────────────────────────────────────────────────────

async function handleAdmit(
  medplum: MedplumClient,
  msg: Hl7Message,
  patient: Patient,
): Promise<void> {
  const location = await upsertLocation(medplum, msg);
  const visitNumber = extractVisitNumber(msg);
  const admitDate = extractAdmitDate(msg);
  const patientClass = mapPatientClass(
    msg.getSegment('PV1')?.getField(2)?.getComponent(1) || undefined,
  );

  // Check for existing open encounter by visit number or open status
  const existingEncounter = visitNumber
    ? await medplum.searchOne(
        'Encounter',
        `identifier=${SYSTEM_VISIT}|${visitNumber}`,
      )
    : await medplum.searchOne(
        'Encounter',
        `patient=${patient.id}&status=in-progress`,
      );

  const encounter: Encounter = {
    ...(existingEncounter ?? { resourceType: 'Encounter' }),
    status: 'in-progress',
    class: patientClass,
    identifier: visitNumber
      ? [{ system: SYSTEM_VISIT, value: visitNumber }]
      : existingEncounter?.identifier,
    subject: { reference: `Patient/${patient.id}` },
    period: { start: admitDate ?? new Date().toISOString() },
    ...(location
      ? {
          location: [
            {
              location: { reference: `Location/${location.id}` },
              status: 'active',
              period: { start: admitDate ?? new Date().toISOString() },
            },
          ],
        }
      : {}),
  };

  if (existingEncounter) {
    await medplum.updateResource<Encounter>(encounter);
  } else {
    await medplum.createResource<Encounter>(encounter);
  }
  console.log(
    `Encounter ${existingEncounter ? 'updated' : 'created'} for patient ${patient.id}`,
  );
}

async function handleTransfer(
  medplum: MedplumClient,
  msg: Hl7Message,
  patient: Patient,
): Promise<void> {
  const newLocation = await upsertLocation(medplum, msg);
  const visitNumber = extractVisitNumber(msg);
  const transferDate = extractAdmitDate(msg) ?? new Date().toISOString();

  const encounter = visitNumber
    ? await medplum.searchOne(
        'Encounter',
        `identifier=${SYSTEM_VISIT}|${visitNumber}`,
      )
    : await medplum.searchOne(
        'Encounter',
        `patient=${patient.id}&status=in-progress`,
      );

  if (!encounter) {
    console.warn('Transfer: no open encounter found, creating one');
    await handleAdmit(medplum, msg, patient);
    return;
  }

  // Close current location period and add new one
  const updatedLocations: Encounter['location'] = (
    encounter.location ?? []
  ).map((loc) =>
    loc.status === 'active'
      ? {
          ...loc,
          status: 'completed',
          period: { ...loc.period, end: transferDate },
        }
      : loc,
  );

  if (newLocation) {
    updatedLocations.push({
      location: { reference: `Location/${newLocation.id}` },
      status: 'active',
      period: { start: transferDate },
    });
  }

  await medplum.updateResource<Encounter>({
    ...encounter,
    location: updatedLocations,
  });
  console.log(`Encounter transfer recorded for patient ${patient.id}`);
}

async function handleDischarge(
  medplum: MedplumClient,
  msg: Hl7Message,
  patient: Patient,
): Promise<void> {
  const visitNumber = extractVisitNumber(msg);
  const dischargeDate =
    msg.getSegment('PV1')?.getField(45)?.getComponent(1) ||
    new Date().toISOString();

  const encounter = visitNumber
    ? await medplum.searchOne(
        'Encounter',
        `identifier=${SYSTEM_VISIT}|${visitNumber}`,
      )
    : await medplum.searchOne(
        'Encounter',
        `patient=${patient.id}&status=in-progress`,
      );

  if (!encounter) {
    console.warn('Discharge: no open encounter found');
    return;
  }

  const updatedLocations: Encounter['location'] = (
    encounter.location ?? []
  ).map((loc) =>
    loc.status === 'active'
      ? {
          ...loc,
          status: 'completed',
          period: { ...loc.period, end: dischargeDate },
        }
      : loc,
  );

  await medplum.updateResource<Encounter>({
    ...encounter,
    status: 'finished',
    location: updatedLocations,
    period: { ...encounter.period, end: dischargeDate },
  });
  console.log(`Encounter discharged for patient ${patient.id}`);
}

async function handleCancelAdmit(
  medplum: MedplumClient,
  msg: Hl7Message,
  patient: Patient,
): Promise<void> {
  const visitNumber = extractVisitNumber(msg);

  const encounter = visitNumber
    ? await medplum.searchOne(
        'Encounter',
        `identifier=${SYSTEM_VISIT}|${visitNumber}`,
      )
    : await medplum.searchOne(
        'Encounter',
        `patient=${patient.id}&status=in-progress`,
      );

  if (!encounter) return;

  await medplum.updateResource<Encounter>({
    ...encounter,
    status: 'cancelled',
  });
  console.log(`Encounter cancelled for patient ${patient.id}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Iterates all repetitions of PID-3 to extract MRN and visit number.
 * Repetitions in an Hl7Field are stored in field.components[rep].
 * Component indices within each repetition are 0-based in the raw array.
 *   components[rep][0] = ID value (PID-3.1)
 *   components[rep][4] = ID type code (PID-3.5)
 */
function extractPid3Identifiers(
  pid: import('@medplum/core').Hl7Segment | undefined,
): {
  mrn: string | undefined;
  visitNumber: string | undefined;
} {
  let mrn: string | undefined;
  let visitNumber: string | undefined;

  if (!pid) return { mrn, visitNumber };

  const field = pid.getField(3);
  for (const repetition of field.components) {
    const idValue = repetition[0];
    if (!idValue) continue;
    const idType = repetition[4]?.toUpperCase();
    if (idType === 'MR' || idType === 'MRN') {
      mrn = idValue;
    } else if (idType === 'VN' || idType === 'FN' || idType === 'FALLNR') {
      visitNumber = idValue;
    } else if (!mrn) {
      mrn = idValue; // fallback: first ID becomes MRN
    }
  }

  return { mrn, visitNumber };
}

function extractVisitNumber(msg: Hl7Message): string | undefined {
  // PV1-19 is the primary visit number (Fallnr.)
  const pv119 = msg.getSegment('PV1')?.getField(19)?.getComponent(1);
  if (pv119) return pv119;
  // Fallback: look in PID-3 for type VN
  return extractPid3Identifiers(msg.getSegment('PID')).visitNumber;
}

function extractAdmitDate(msg: Hl7Message): string | undefined {
  // PV1-44: admit date/time
  const raw = msg.getSegment('PV1')?.getField(44)?.getComponent(1);
  return raw ? parseDateTimeString(raw) : undefined;
}

/**
 * Parse HL7 date: YYYYMMDD → YYYY-MM-DD
 */
function parseDateString(raw: string | undefined): string | undefined {
  if (!raw || raw.length < 8) return undefined;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

/**
 * Parse HL7 datetime: YYYYMMDDHHMMSS → ISO string
 */
function parseDateTimeString(raw: string | undefined): string | undefined {
  if (!raw || raw.length < 8) return undefined;
  const year = raw.slice(0, 4);
  const month = raw.slice(4, 6);
  const day = raw.slice(6, 8);
  const hour = raw.slice(8, 10) || '00';
  const min = raw.slice(10, 12) || '00';
  const sec = raw.slice(12, 14) || '00';
  return `${year}-${month}-${day}T${hour}:${min}:${sec}`;
}

function mapGender(hl7Gender: string | undefined): Patient['gender'] {
  switch (hl7Gender?.toUpperCase()) {
    case 'M':
      return 'male';
    case 'F':
      return 'female';
    case 'O':
      return 'other';
    default:
      return 'unknown';
  }
}

function mapPatientClass(hl7Class: string | undefined): Coding {
  // V3 ActCode values used by FHIR Encounter.class (Coding, not CodeableConcept)
  const map: Record<string, { code: string; display: string }> = {
    I: { code: 'IMP', display: 'inpatient encounter' },
    O: { code: 'AMB', display: 'ambulatory' },
    E: { code: 'EMER', display: 'emergency' },
    P: { code: 'PRENC', display: 'pre-admission' },
    R: { code: 'AMB', display: 'ambulatory' },
  };
  const mapped = map[hl7Class?.toUpperCase() ?? ''] ?? {
    code: 'AMB',
    display: 'ambulatory',
  };
  return {
    system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
    code: mapped.code,
    display: mapped.display,
  };
}

/**
 * Best-effort insurance type from IN1 segment.
 * IN1-2.1: insurance plan ID / type code.
 * German conventions: GKV = public, PKV = private, SB = self-pay.
 */
function extractInsuranceType(msg: Hl7Message): string | undefined {
  const in1 = msg.getSegment('IN1');
  if (!in1) return undefined;
  const code = (in1.getField(2)?.getComponent(1) || undefined)?.toUpperCase();
  if (!code) return undefined;
  if (code.includes('GKV') || code === 'PUBLIC') return 'public';
  if (code.includes('PKV') || code === 'PRIVATE') return 'private';
  if (code === 'SB' || code === 'SP') return 'self-pay';
  return code; // return raw if not recognized
}

interface In1InsuranceInfo {
  readonly planCode?: string;
  readonly payorId?: string;
  readonly payorName?: string;
  readonly policyNumber?: string;
  readonly effectiveDate?: string;
  readonly expiryDate?: string;
}

/**
 * Parse IN1 details for creating Coverage and payor Organization resources.
 * Field mapping (best-effort):
 * IN1-2 = plan code, IN1-3 = company id, IN1-4 = company name,
 * IN1-12 = plan effective date, IN1-13 = plan expiration date, IN1-36 = policy number.
 */
function extractIn1InsuranceInfo(
  msg: Hl7Message,
): In1InsuranceInfo | undefined {
  const in1 = msg.getSegment('IN1');
  if (!in1) return undefined;

  const planCode = in1.getField(2)?.getComponent(1) || undefined;
  const payorId = in1.getField(3)?.getComponent(1) || undefined;
  const payorName = in1.getField(4)?.getComponent(1) || undefined;
  const effectiveDate = parseDateString(
    in1.getField(12)?.getComponent(1) || undefined,
  );
  const expiryDate = parseDateString(
    in1.getField(13)?.getComponent(1) || undefined,
  );
  const policyNumber = in1.getField(36)?.getComponent(1) || undefined;

  if (!planCode && !payorId && !payorName && !policyNumber) {
    return undefined;
  }

  return {
    planCode,
    payorId,
    payorName,
    policyNumber,
    effectiveDate,
    expiryDate,
  };
}

async function upsertCoverageFromIn1(
  medplum: MedplumClient,
  msg: Hl7Message,
  patient: Patient,
): Promise<void> {
  if (!patient.id) return;

  const insurance = extractIn1InsuranceInfo(msg);
  if (!insurance) return;

  const coverageKey = [
    insurance.planCode,
    insurance.payorId,
    insurance.policyNumber,
  ]
    .filter(Boolean)
    .join('|');
  if (!coverageKey) return;

  const existingCoverage = await medplum.searchOne(
    'Coverage',
    `identifier=${SYSTEM_INSURANCE_COVERAGE}|${encodeURIComponent(coverageKey)}`,
  );

  const payor = await upsertInsurancePayor(medplum, insurance);
  const insuranceType = extractInsuranceType(msg);
  const payorReference = payor
    ? { reference: `Organization/${payor.id}` }
    : { reference: `Patient/${patient.id}` };

  const coverage: Coverage = {
    ...(existingCoverage ?? { resourceType: 'Coverage' }),
    status: 'active',
    identifier: [{ system: SYSTEM_INSURANCE_COVERAGE, value: coverageKey }],
    beneficiary: { reference: `Patient/${patient.id}` },
    subscriberId: insurance.policyNumber,
    ...(insuranceType
      ? {
          type: {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
                code: insuranceType.toUpperCase(),
                display: insuranceType,
              },
            ],
            text: insuranceType,
          },
        }
      : {}),
    ...(insurance.planCode
      ? {
          class: [
            {
              type: {
                coding: [
                  {
                    system:
                      'http://terminology.hl7.org/CodeSystem/coverage-class',
                    code: 'plan',
                  },
                ],
              },
              value: insurance.planCode,
            },
          ],
        }
      : {}),
    ...(insurance.effectiveDate || insurance.expiryDate
      ? {
          period: { start: insurance.effectiveDate, end: insurance.expiryDate },
        }
      : {}),
    payor: [payorReference],
  };

  if (existingCoverage) {
    await medplum.updateResource<Coverage>(coverage);
  } else {
    await medplum.createResource<Coverage>(coverage);
  }
  console.log(
    `Coverage ${existingCoverage ? 'updated' : 'created'} for patient ${patient.id}`,
  );
}

async function upsertInsurancePayor(
  medplum: MedplumClient,
  insurance: In1InsuranceInfo,
): Promise<Organization | undefined> {
  const payorId = insurance.payorId?.trim();
  const payorName = insurance.payorName?.trim();

  if (!payorId && !payorName) {
    return undefined;
  }

  const existing = payorId
    ? await medplum.searchOne(
        'Organization',
        `identifier=${SYSTEM_INSURANCE_PAYOR}|${encodeURIComponent(payorId)}`,
      )
    : await medplum.searchOne(
        'Organization',
        `name=${encodeURIComponent(payorName ?? '')}`,
      );

  const organization: Organization = {
    ...(existing ?? { resourceType: 'Organization' }),
    active: true,
    name: payorName ?? existing?.name ?? 'Unknown Payor',
    identifier: payorId
      ? [{ system: SYSTEM_INSURANCE_PAYOR, value: payorId }]
      : existing?.identifier,
    type: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/organization-type',
            code: 'ins',
            display: 'Insurance Company',
          },
        ],
      },
    ],
  };

  return existing
    ? medplum.updateResource<Organization>(organization)
    : medplum.createResource<Organization>(organization);
}

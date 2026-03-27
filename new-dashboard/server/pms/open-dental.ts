/**
 * Open Dental PMS Adapter
 *
 * Implements PMSAdapter using Open Dental's MySQL database.
 * All queries are scoped by ClinicNum (multi-tenant isolation).
 * All dates use OD convention: NULL dates stored as '0001-01-01'.
 *
 * IMPORTANT: This adapter connects directly to the Open Dental MySQL database.
 * In production, all MySQL access goes through the on-premises connector service.
 * This adapter is used by the connector service itself.
 *
 * Open Dental date conventions:
 *   - NULL dates stored as '0001-01-01' (never SQL NULL)
 *   - AptStatus: 1=Scheduled, 2=Complete, 3=UnschedList, 5=Broken, 6=Planned
 *   - Confirmed: DefNum (FK to definition table, NOT a boolean)
 */

import type {
  CreateAppointmentInput,
  PMSAdapter,
  PMSAppointment,
  PMSOperatory,
  PMSPatient,
  PMSProvider,
  UpdateAppointmentInput,
} from "./adapter.js";
import type { DateRange, SlotSearchParams, SyncResult, TimeSlot } from "../scheduling/types.js";
import { ProviderType } from "../scheduling/types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpenDentalConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  clinicNum: number;
}

// ---------------------------------------------------------------------------
// MySQL connection (lazy init, uses mysql2/promise)
// ---------------------------------------------------------------------------

// mysql2 is imported dynamically so the adapter can be loaded without it
// when the PMS type is not OPEN_DENTAL.
type MySQLPool = {
  execute(sql: string, params: unknown[]): Promise<[unknown[], unknown[]]>;
  end(): Promise<void>;
};

async function createPool(config: OpenDentalConfig): Promise<MySQLPool> {
  // Dynamic import so other PMS types don't require mysql2
  const mysql = await import("mysql2/promise");
  return mysql.createPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionLimit: 10,
    timezone: "local",
  }) as unknown as MySQLPool;
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

const OD_NULL_DATE = "0001-01-01";

function isOdNullDate(val: string | null | undefined): boolean {
  return !val || val.startsWith(OD_NULL_DATE);
}

function odTimeToHourMinute(odTime: string): { hour: number; minute: number } {
  // OD stores time as seconds since midnight
  const secs = parseInt(odTime, 10);
  if (isNaN(secs)) return { hour: 0, minute: 0 };
  return { hour: Math.floor(secs / 3600), minute: Math.floor((secs % 3600) / 60) };
}

function buildDateTime(dateStr: string, startTimeSeconds: string): string {
  const { hour, minute } = odTimeToHourMinute(startTimeSeconds);
  const d = new Date(dateStr);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function minutesToOdSeconds(minutes: number): number {
  return minutes * 60;
}

function dateTimeToOdDate(isoDateTime: string): string {
  return isoDateTime.split("T")[0]!;
}

function dateTimeToOdSeconds(isoDateTime: string): number {
  const d = new Date(isoDateTime);
  return d.getHours() * 3600 + d.getMinutes() * 60;
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface AptRow {
  AptNum: number | bigint;
  PatNum: number | bigint;
  ProvNum: number | bigint;
  Op: number | bigint;
  AptDateTime: string;
  Pattern: string;
  AptStatus: number;
  ProcDescript: string;
  Note: string;
  ClinicNum: number | bigint;
  DateTimeConfirmed: string;
}

interface PatientRow {
  PatNum: number | bigint;
  FName: string;
  LName: string;
  Preferred: string;
  Birthdate: string;
  Language: string;
  WirelessPhone: string;
  HmPhone: string;
  WkPhone: string;
  Email: string;
  PriProv: number | bigint;
  ClinicNum: number | bigint;
}

interface ProviderRow {
  ProvNum: number | bigint;
  FName: string;
  LName: string;
  Abbr: string;
  IsHidden: number;
  IsHygienist: number;
  ClinicNum: number | bigint;
}

interface OperatoryRow {
  OperatoryNum: number | bigint;
  OpName: string;
  Abbrev: string;
  IsHidden: number;
  IsHygiene: number;
  ClinicNum: number | bigint;
  ItemOrder: number;
}

interface ScheduleRow {
  ScheduleNum: number | bigint;
  SchedDate: string;
  StartTime: string;
  StopTime: string;
  ProvNum: number | bigint;
  Op: number | bigint;
  SchedType: number;
}

// ---------------------------------------------------------------------------
// Slot building from provider schedules
// ---------------------------------------------------------------------------

function patternToDurationMinutes(pattern: string): number {
  // OD Pattern: each char = 5 minutes, X = blocked, / = available
  // For available slot finding we ignore pattern and use schedule blocks
  return pattern.length * 5;
}

function buildSlotsFromSchedule(
  scheduleRow: ScheduleRow,
  providers: PMSProvider[],
  operatories: PMSOperatory[],
  bookedSlots: AptRow[],
  durationMinutes: number,
  clinicNum: number
): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const dateStr = scheduleRow.SchedDate.split("T")[0]!;
  const startSecs = parseInt(String(scheduleRow.StartTime), 10);
  const stopSecs = parseInt(String(scheduleRow.StopTime), 10);
  const slotStepSecs = 15 * 60; // 15-minute increments
  const durationSecs = durationMinutes * 60;

  const provider = providers.find((p) => p.id === Number(scheduleRow.ProvNum));
  const operatory = operatories.find((o) => o.id === Number(scheduleRow.Op));

  if (!provider || !operatory || provider.isHidden || operatory.isHidden) return [];

  // Walk through the schedule block in 15-min increments
  for (let t = startSecs; t + durationSecs <= stopSecs; t += slotStepSecs) {
    const slotStart = t;
    const slotEnd = t + durationSecs;
    const dateTime = buildDateTime(dateStr, String(slotStart));

    // Check for conflicts with booked appointments
    const hasConflict = bookedSlots.some((apt) => {
      if (Number(apt.Op) !== operatory.id && Number(apt.ProvNum) !== provider.id) {
        return false;
      }
      const aptDateTime = new Date(apt.AptDateTime);
      const aptStart = aptDateTime.getHours() * 3600 + aptDateTime.getMinutes() * 60;
      const aptDuration = patternToDurationMinutes(apt.Pattern);
      const aptEnd = aptStart + aptDuration * 60;
      // Check operatory conflict
      if (Number(apt.Op) === operatory.id) {
        return slotStart < aptEnd && aptStart < slotEnd;
      }
      // Check provider conflict
      if (Number(apt.ProvNum) === provider.id) {
        return slotStart < aptEnd && aptStart < slotEnd;
      }
      return false;
    });

    if (!hasConflict) {
      slots.push({
        dateTime,
        duration: durationMinutes,
        providerId: provider.id,
        providerName: provider.name,
        operatoryId: operatory.id,
        operatoryName: operatory.name,
        clinicNum,
      });
    }
  }

  return slots;
}

// ---------------------------------------------------------------------------
// OpenDentalAdapter implementation
// ---------------------------------------------------------------------------

export class OpenDentalAdapter implements PMSAdapter {
  private pool: MySQLPool | null = null;
  private readonly config: OpenDentalConfig;

  constructor(config: OpenDentalConfig) {
    this.config = config;
  }

  private async getPool(): Promise<MySQLPool> {
    if (!this.pool) {
      this.pool = await createPool(this.config);
    }
    return this.pool;
  }

  private async query<T>(sql: string, params: unknown[]): Promise<T[]> {
    const pool = await this.getPool();
    const [rows] = await pool.execute(sql, params);
    return rows as T[];
  }

  async getPatient(patientId: string): Promise<PMSPatient> {
    const rows = await this.query<PatientRow>(
      `SELECT PatNum, FName, LName, Preferred, Birthdate, Language,
              WirelessPhone, HmPhone, WkPhone, Email, PriProv, ClinicNum
       FROM patient
       WHERE PatNum = ? AND ClinicNum = ?`,
      [patientId, this.config.clinicNum]
    );
    const r = rows[0];
    if (!r) throw new Error(`Patient ${patientId} not found`);
    return {
      id: String(r.PatNum),
      firstName: r.FName,
      lastName: r.LName,
      preferred: r.Preferred || undefined,
      dateOfBirth: isOdNullDate(r.Birthdate) ? undefined : r.Birthdate,
      language: r.Language || undefined,
      wirelessPhone: r.WirelessPhone || undefined,
      hmPhone: r.HmPhone || undefined,
      wkPhone: r.WkPhone || undefined,
      email: r.Email || undefined,
      priProv: r.PriProv ? Number(r.PriProv) : undefined,
      clinicNum: Number(r.ClinicNum),
    };
  }

  async searchPatients(query: string): Promise<PMSPatient[]> {
    const like = `%${query}%`;
    const rows = await this.query<PatientRow>(
      `SELECT PatNum, FName, LName, Preferred, Birthdate, Language,
              WirelessPhone, HmPhone, WkPhone, Email, PriProv, ClinicNum
       FROM patient
       WHERE ClinicNum = ?
         AND (FName LIKE ? OR LName LIKE ? OR WirelessPhone LIKE ? OR HmPhone LIKE ?)
         AND PatStatus != 4
       LIMIT 20`,
      [this.config.clinicNum, like, like, like, like]
    );
    return rows.map((r) => ({
      id: String(r.PatNum),
      firstName: r.FName,
      lastName: r.LName,
      preferred: r.Preferred || undefined,
      dateOfBirth: isOdNullDate(r.Birthdate) ? undefined : r.Birthdate,
      language: r.Language || undefined,
      wirelessPhone: r.WirelessPhone || undefined,
      hmPhone: r.HmPhone || undefined,
      wkPhone: r.WkPhone || undefined,
      email: r.Email || undefined,
      priProv: r.PriProv ? Number(r.PriProv) : undefined,
      clinicNum: Number(r.ClinicNum),
    }));
  }

  async getProviders(): Promise<PMSProvider[]> {
    const rows = await this.query<ProviderRow>(
      `SELECT ProvNum, FName, LName, Abbr, IsHidden, IsHygienist, ClinicNum
       FROM provider
       WHERE ClinicNum = ? AND IsHidden = 0`,
      [this.config.clinicNum]
    );
    return rows.map((r) => ({
      id: Number(r.ProvNum),
      name: `${r.FName} ${r.LName}`.trim() || r.Abbr,
      abbr: r.Abbr || undefined,
      isHygienist: Boolean(r.IsHygienist),
      isHidden: Boolean(r.IsHidden),
      clinicNum: Number(r.ClinicNum),
    }));
  }

  async getOperatories(): Promise<PMSOperatory[]> {
    const rows = await this.query<OperatoryRow>(
      `SELECT OperatoryNum, OpName, Abbrev, IsHidden, IsHygiene, ClinicNum, ItemOrder
       FROM operatory
       WHERE ClinicNum = ?`,
      [this.config.clinicNum]
    );
    return rows.map((r) => ({
      id: Number(r.OperatoryNum),
      name: r.OpName,
      abbr: r.Abbrev || undefined,
      isHygiene: Boolean(r.IsHygiene),
      isHidden: Boolean(r.IsHidden),
      clinicNum: Number(r.ClinicNum),
      itemOrder: r.ItemOrder,
    }));
  }

  async getAvailableSlots(params: SlotSearchParams): Promise<TimeSlot[]> {
    const { startDate, endDate, durationMinutes, providerType } = params;

    // Fetch provider schedules for the date range
    const scheduleRows = await this.query<ScheduleRow>(
      `SELECT s.ScheduleNum, s.SchedDate, s.StartTime, s.StopTime,
              s.ProvNum, so.OperatoryNum AS Op, s.SchedType
       FROM schedule s
       JOIN scheduleop so ON so.ScheduleNum = s.ScheduleNum
       WHERE s.ClinicNum = ?
         AND s.SchedDate >= ?
         AND s.SchedDate <= ?
         AND s.SchedType = 1
         AND s.StartTime != s.StopTime`,
      [this.config.clinicNum, startDate, endDate]
    );

    // Fetch already booked appointments in this range to detect conflicts
    const bookedRows = await this.query<AptRow>(
      `SELECT AptNum, PatNum, ProvNum, Op, AptDateTime, Pattern,
              AptStatus, ProcDescript, Note, ClinicNum, DateTimeConfirmed
       FROM appointment
       WHERE ClinicNum = ?
         AND DATE(AptDateTime) >= ?
         AND DATE(AptDateTime) <= ?
         AND AptStatus = 1`,
      [this.config.clinicNum, startDate, endDate]
    );

    // Fetch providers and operatories for enrichment
    const [providers, operatories] = await Promise.all([
      this.getProviders(),
      this.getOperatories(),
    ]);

    // Filter providers by type if needed
    const filteredProviders = providers.filter((p) => {
      if (providerType === ProviderType.HYGIENIST) return p.isHygienist;
      if (providerType === ProviderType.DENTIST) return !p.isHygienist;
      return true;
    });

    const filteredProviderIds = new Set(filteredProviders.map((p) => p.id));

    // Build slots from schedule blocks
    const allSlots: TimeSlot[] = [];
    for (const sched of scheduleRows) {
      if (!filteredProviderIds.has(Number(sched.ProvNum))) continue;
      const slots = buildSlotsFromSchedule(
        sched,
        filteredProviders,
        operatories,
        bookedRows,
        durationMinutes,
        this.config.clinicNum
      );
      allSlots.push(...slots);
    }

    // Sort by datetime
    allSlots.sort((a, b) => a.dateTime.localeCompare(b.dateTime));

    return allSlots;
  }

  async createAppointment(input: CreateAppointmentInput): Promise<PMSAppointment> {
    const dateStr = dateTimeToOdDate(input.dateTime);
    const startSecs = dateTimeToOdSeconds(input.dateTime);
    const stopSecs = startSecs + minutesToOdSeconds(input.duration);
    // Pattern: 'X' per 5-min block (required by OD)
    const patternLen = Math.ceil(input.duration / 5);
    const pattern = "X".repeat(patternLen);

    const [result] = await this.query<{ insertId: number }>(
      `INSERT INTO appointment
         (PatNum, ProvNum, Op, AptDateTime, Pattern, AptStatus, ProcDescript,
          Note, ClinicNum, DateTStamp)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, NOW())`,
      [
        input.patientId ?? 0,
        input.providerId,
        input.operatoryId,
        `${dateStr} ${String(Math.floor(startSecs / 3600)).padStart(2, "0")}:${String(Math.floor((startSecs % 3600) / 60)).padStart(2, "0")}:00`,
        pattern,
        input.type ?? "Appointment",
        input.note ?? "",
        this.config.clinicNum,
      ]
    );

    return {
      id: String((result as unknown as { insertId: number }).insertId),
      patientId: String(input.patientId ?? 0),
      providerId: input.providerId,
      operatoryId: input.operatoryId,
      dateTime: input.dateTime,
      duration: input.duration,
      status: "scheduled",
      type: input.type,
      note: input.note,
      clinicNum: this.config.clinicNum,
    };
  }

  async updateAppointment(
    appointmentId: string,
    updates: UpdateAppointmentInput
  ): Promise<PMSAppointment> {
    const setParts: string[] = [];
    const values: unknown[] = [];

    if (updates.providerId !== undefined) {
      setParts.push("ProvNum = ?");
      values.push(updates.providerId);
    }
    if (updates.operatoryId !== undefined) {
      setParts.push("Op = ?");
      values.push(updates.operatoryId);
    }
    if (updates.dateTime !== undefined) {
      setParts.push("AptDateTime = ?");
      const dateStr = dateTimeToOdDate(updates.dateTime);
      const startSecs = dateTimeToOdSeconds(updates.dateTime);
      values.push(
        `${dateStr} ${String(Math.floor(startSecs / 3600)).padStart(2, "0")}:${String(Math.floor((startSecs % 3600) / 60)).padStart(2, "0")}:00`
      );
    }
    if (updates.status !== undefined) {
      setParts.push("AptStatus = ?");
      // Map status string to OD AptStatus number
      const statusMap: Record<string, number> = {
        scheduled: 1, complete: 2, unschedlist: 3, broken: 5, planned: 6,
      };
      values.push(statusMap[updates.status] ?? 1);
    }
    if (updates.note !== undefined) {
      setParts.push("Note = ?");
      values.push(updates.note);
    }

    if (setParts.length > 0) {
      setParts.push("DateTStamp = NOW()");
      values.push(appointmentId, this.config.clinicNum);
      await this.query(
        `UPDATE appointment SET ${setParts.join(", ")} WHERE AptNum = ? AND ClinicNum = ?`,
        values
      );
    }

    // Fetch and return updated
    const rows = await this.query<AptRow>(
      `SELECT AptNum, PatNum, ProvNum, Op, AptDateTime, Pattern,
              AptStatus, ProcDescript, Note, ClinicNum, DateTimeConfirmed
       FROM appointment WHERE AptNum = ? AND ClinicNum = ?`,
      [appointmentId, this.config.clinicNum]
    );
    const r = rows[0];
    if (!r) throw new Error(`Appointment ${appointmentId} not found`);

    const statusReverseMap: Record<number, string> = {
      1: "scheduled", 2: "complete", 3: "unschedlist", 5: "broken", 6: "planned",
    };

    return {
      id: String(r.AptNum),
      patientId: String(r.PatNum),
      providerId: Number(r.ProvNum),
      operatoryId: Number(r.Op),
      dateTime: r.AptDateTime,
      duration: patternToDurationMinutes(r.Pattern),
      status: statusReverseMap[r.AptStatus] ?? "scheduled",
      type: r.ProcDescript || undefined,
      note: r.Note || undefined,
      clinicNum: Number(r.ClinicNum),
      confirmedAt: isOdNullDate(r.DateTimeConfirmed) ? undefined : r.DateTimeConfirmed,
    };
  }

  async cancelAppointment(appointmentId: string, reason: string): Promise<void> {
    // OD: set AptStatus = 5 (Broken) and append reason to note
    await this.query(
      `UPDATE appointment
       SET AptStatus = 5,
           Note = CONCAT(IFNULL(Note, ''), '\nCancelled: ', ?),
           DateTStamp = NOW()
       WHERE AptNum = ? AND ClinicNum = ?`,
      [reason, appointmentId, this.config.clinicNum]
    );
  }

  async syncSchedule(dateRange: DateRange): Promise<SyncResult> {
    // Read schedule data for the range — return count of schedules synced
    const rows = await this.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM schedule
       WHERE ClinicNum = ? AND SchedDate >= ? AND SchedDate <= ?`,
      [this.config.clinicNum, dateRange.startDate, dateRange.endDate]
    );
    const count = rows[0]?.cnt ?? 0;
    return {
      success: true,
      appointmentsSynced: Number(count),
      errors: [],
      syncedAt: new Date().toISOString(),
    };
  }
}

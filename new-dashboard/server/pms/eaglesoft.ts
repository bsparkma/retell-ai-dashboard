/**
 * Eaglesoft PMS Adapter — Stub
 *
 * TODO: Implement via NexHealth middleware integration.
 * NexHealth provides a unified API layer for Eaglesoft scheduling data.
 *
 * Reference: https://docs.nexhealth.com/
 *
 * All methods throw NotImplementedError until the NexHealth integration
 * is built. The factory will never select this adapter without explicit
 * PMSType.EAGLESOFT configuration.
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

class NotImplementedError extends Error {
  constructor(method: string) {
    super(`EaglesoftAdapter.${method} is not yet implemented. Requires NexHealth middleware integration.`);
    this.name = "NotImplementedError";
  }
}

export class EaglesoftAdapter implements PMSAdapter {
  constructor(
    // TODO: NexHealth API key + practice ID
    _config: { nexhealthApiKey: string; practiceId: string; clinicNum: number }
  ) {
    // TODO: Initialize NexHealth client
  }

  async getPatient(_patientId: string): Promise<PMSPatient> {
    throw new NotImplementedError("getPatient");
  }

  async searchPatients(_query: string): Promise<PMSPatient[]> {
    throw new NotImplementedError("searchPatients");
  }

  async getAvailableSlots(_params: SlotSearchParams): Promise<TimeSlot[]> {
    throw new NotImplementedError("getAvailableSlots");
    // TODO: GET /availability/slots via NexHealth
    // Map NexHealth slot shape → TimeSlot
  }

  async createAppointment(_appointment: CreateAppointmentInput): Promise<PMSAppointment> {
    throw new NotImplementedError("createAppointment");
    // TODO: POST /appointments via NexHealth
  }

  async updateAppointment(
    _appointmentId: string,
    _updates: UpdateAppointmentInput
  ): Promise<PMSAppointment> {
    throw new NotImplementedError("updateAppointment");
    // TODO: PATCH /appointments/:id via NexHealth
  }

  async cancelAppointment(_appointmentId: string, _reason: string): Promise<void> {
    throw new NotImplementedError("cancelAppointment");
    // TODO: DELETE /appointments/:id via NexHealth
  }

  async getProviders(): Promise<PMSProvider[]> {
    throw new NotImplementedError("getProviders");
    // TODO: GET /providers via NexHealth
  }

  async getOperatories(): Promise<PMSOperatory[]> {
    throw new NotImplementedError("getOperatories");
    // TODO: GET /operatories via NexHealth (if available)
  }

  async syncSchedule(_dateRange: DateRange): Promise<SyncResult> {
    throw new NotImplementedError("syncSchedule");
    // TODO: Trigger NexHealth schedule sync webhook
  }
}

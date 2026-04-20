export const TURSO_URL = Deno.env.get("TURSO_URL") || "";
export const TURSO_AUTH_TOKEN = Deno.env.get("TURSO_AUTH_TOKEN") || "";

type TursoStatement = {
  q: string;
  params?: unknown[];
};

type TursoRowResult = {
  rows?: unknown[][];
  columns?: string[];
  error?: unknown;
};

type TursoRootPayload = {
  error?: unknown;
  results?: TursoRowResult[] | TursoRowResult;
};

type MeetingParticipantRecord = {
  uid: string;
  meetingUid: string;
  nick: string;
  localSchedule: string[];
  utcSchedule: string[];
  updatedAtLocal: string;
  updatedAtUTC: string;
  timezone: string;
  recoveryEmail: string | null;
};

type MeetingRecord = {
  uid: string;
  title: string;
  createdAtUTC: string;
  scheduledAtUTC: string | null;
};

type EnrichedMeetingRecord = MeetingRecord & {
  participantUid: string;
  nick: string;
};

function unwrapTursoPayload(payload: unknown) {
  return Array.isArray(payload) ? payload[0] : payload;
}

function getTursoError(payload: unknown): string | null {
  const root = unwrapTursoPayload(payload) as { error?: unknown; results?: Array<{ error?: unknown }> } | null;
  if (!root) return "Respuesta vacia de Turso";
  if (root.error) return String(root.error);
  if (Array.isArray(root.results)) {
    const withError = root.results.find((result) => result?.error);
    if (withError?.error) return String(withError.error);
  }
  return null;
}

function getFirstResult(root: TursoRootPayload): TursoRowResult | null {
  if (!root.results) return null;
  if (Array.isArray(root.results)) return root.results[0] || null;
  return root.results;
}

function normalizeString(value: unknown) {
  return String(value ?? "").trim();
}

function parseSchedule(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
    } catch {
      return [];
    }
  }

  return [];
}

function rowsToObjects(result: TursoRowResult | null): Array<Record<string, unknown>> {
  if (!result?.rows?.length || !result.columns?.length) return [];

  return result.rows.map((row) => {
    const record: Record<string, unknown> = {};
    result.columns?.forEach((column, index) => {
      record[column] = row[index];
    });
    return record;
  });
}

function normalizeEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

async function tryExecuteStatement(statement: TursoStatement, ignoreSubstrings: string[]) {
  try {
    await executeStatements([statement]);
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (ignoreSubstrings.some((needle) => message.includes(needle.toLowerCase()))) {
      return;
    }
    throw error;
  }
}

async function executeStatements(statements: TursoStatement[]) {
  if (!TURSO_URL || !TURSO_AUTH_TOKEN) {
    throw new Error("Variables de entorno de Turso no configuradas");
  }

  const response = await fetch(TURSO_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TURSO_AUTH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ statements }),
  });

  const text = await response.text();
  let payload: unknown = null;

  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Respuesta invalida de Turso");
  }

  const error = getTursoError(payload);
  if (!response.ok || error) {
    throw new Error(error || `Error HTTP ${response.status}`);
  }

  return unwrapTursoPayload(payload) as TursoRootPayload;
}

let schemaPromise: Promise<void> | null = null;

async function ensureSchema() {
  if (schemaPromise) {
    return schemaPromise;
  }

  schemaPromise = (async () => {
    await executeStatements([
      {
        q: `
          CREATE TABLE IF NOT EXISTS meetings (
            uid TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at_utc TEXT NOT NULL
          )
        `,
      },
      {
        q: `
          CREATE TABLE IF NOT EXISTS meeting_participants (
            uid TEXT PRIMARY KEY,
            meeting_uid TEXT NOT NULL,
            nick TEXT NOT NULL,
            local_schedule TEXT NOT NULL DEFAULT '[]',
            utc_schedule TEXT NOT NULL DEFAULT '[]',
            timezone TEXT NOT NULL,
            updated_at_local TEXT NOT NULL,
            updated_at_utc TEXT NOT NULL,
            FOREIGN KEY (meeting_uid) REFERENCES meetings(uid)
          )
        `,
      },
      {
        q: `
          CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_participants_meeting_nick
          ON meeting_participants (meeting_uid, nick)
        `,
      },
      {
        q: `
          CREATE INDEX IF NOT EXISTS idx_meeting_participants_meeting_uid
          ON meeting_participants (meeting_uid)
        `,
      },
      {
        q: `
          CREATE TABLE IF NOT EXISTS recovery_tokens (
            token TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            created_at_utc TEXT NOT NULL,
            expires_at_utc TEXT NOT NULL,
            used_at_utc TEXT NULL
          )
        `,
      },
      {
        q: `
          CREATE INDEX IF NOT EXISTS idx_recovery_tokens_email
          ON recovery_tokens (email)
        `,
      },
    ]);

    // Idempotent ALTERs: Turso/SQLite no soportan "ADD COLUMN IF NOT EXISTS",
    // asi que ignoramos el error de columna duplicada cuando ya existe.
    await tryExecuteStatement(
      { q: "ALTER TABLE meetings ADD COLUMN scheduled_at_utc TEXT NULL" },
      ["duplicate column name", "already exists"],
    );
    await tryExecuteStatement(
      { q: "ALTER TABLE meeting_participants ADD COLUMN recovery_email TEXT NULL" },
      ["duplicate column name", "already exists"],
    );

    await executeStatements([
      {
        q: `
          CREATE INDEX IF NOT EXISTS idx_meeting_participants_recovery_email
          ON meeting_participants (recovery_email)
        `,
      },
    ]);
  })();

  return schemaPromise;
}

function mapMeeting(record: Record<string, unknown>): MeetingRecord {
  const rawScheduled = record.scheduled_at_utc;
  return {
    uid: String(record.uid || ""),
    title: String(record.title || ""),
    createdAtUTC: String(record.created_at_utc || ""),
    scheduledAtUTC: rawScheduled == null || rawScheduled === "" ? null : String(rawScheduled),
  };
}

function mapParticipant(record: Record<string, unknown>): MeetingParticipantRecord {
  const rawEmail = record.recovery_email;
  return {
    uid: String(record.uid || ""),
    meetingUid: String(record.meeting_uid || ""),
    nick: String(record.nick || ""),
    localSchedule: parseSchedule(record.local_schedule),
    utcSchedule: parseSchedule(record.utc_schedule),
    updatedAtLocal: String(record.updated_at_local || ""),
    updatedAtUTC: String(record.updated_at_utc || ""),
    timezone: String(record.timezone || "UTC"),
    recoveryEmail: rawEmail == null || rawEmail === "" ? null : String(rawEmail),
  };
}

async function getMeetingRow(meetingUid: string) {
  const payload = await executeStatements([
    {
      q: "SELECT * FROM meetings WHERE uid = ? LIMIT 1",
      params: [meetingUid],
    },
  ]);

  const rows = rowsToObjects(getFirstResult(payload));
  return rows[0] || null;
}

export async function createMeetingTorso(title: string, scheduledAtUTC?: string | null) {
  await ensureSchema();

  const cleanTitle = normalizeString(title);
  if (!cleanTitle) {
    throw new Error("El titulo es requerido");
  }

  const cleanScheduled = normalizeString(scheduledAtUTC);
  let scheduledIso: string | null = null;
  if (cleanScheduled) {
    const parsed = new Date(cleanScheduled);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error("La fecha objetivo es invalida");
    }
    scheduledIso = parsed.toISOString();
  }

  const meeting: MeetingRecord = {
    uid: crypto.randomUUID(),
    title: cleanTitle,
    createdAtUTC: new Date().toISOString(),
    scheduledAtUTC: scheduledIso,
  };

  await executeStatements([
    {
      q: `
        INSERT INTO meetings (uid, title, created_at_utc, scheduled_at_utc)
        VALUES (?, ?, ?, ?)
      `,
      params: [meeting.uid, meeting.title, meeting.createdAtUTC, meeting.scheduledAtUTC],
    },
  ]);

  return meeting;
}

export async function getMeetingTorso(meetingUid: string) {
  await ensureSchema();

  const cleanMeetingUid = normalizeString(meetingUid);
  if (!cleanMeetingUid) {
    return null;
  }

  // Two separate queries to avoid ambiguity with Turso batch response format
  // (Turso returns [{results:[stmt1]}, {results:[stmt2]}] for batch, not a single merged object)
  const meetingPayload = await executeStatements([
    {
      q: "SELECT * FROM meetings WHERE uid = ? LIMIT 1",
      params: [cleanMeetingUid],
    },
  ]);

  const meetingRows = rowsToObjects(getFirstResult(meetingPayload));
  if (!meetingRows.length) {
    return null;
  }

  const participantsPayload = await executeStatements([
    {
      q: `
        SELECT * FROM meeting_participants
        WHERE meeting_uid = ?
        ORDER BY updated_at_utc DESC, nick ASC
      `,
      params: [cleanMeetingUid],
    },
  ]);

  const participantRows = rowsToObjects(getFirstResult(participantsPayload));

  return {
    ...mapMeeting(meetingRows[0]),
    participants: participantRows.map(mapParticipant),
  };
}

export async function getMeetingParticipantByUidTorso(meetingUid: string, uid: string) {
  await ensureSchema();

  const cleanMeetingUid = normalizeString(meetingUid);
  const cleanUid = normalizeString(uid);
  if (!cleanMeetingUid || !cleanUid) {
    return null;
  }

  const payload = await executeStatements([
    {
      q: `
        SELECT * FROM meeting_participants
        WHERE meeting_uid = ? AND uid = ?
        LIMIT 1
      `,
      params: [cleanMeetingUid, cleanUid],
    },
  ]);

  const rows = rowsToObjects(getFirstResult(payload));
  return rows[0] ? mapParticipant(rows[0]) : null;
}

export async function getMeetingParticipantByNickTorso(meetingUid: string, nick: string) {
  await ensureSchema();

  const cleanMeetingUid = normalizeString(meetingUid);
  const cleanNick = normalizeString(nick);
  if (!cleanMeetingUid || !cleanNick) {
    return null;
  }

  const payload = await executeStatements([
    {
      q: `
        SELECT * FROM meeting_participants
        WHERE meeting_uid = ? AND nick = ?
        LIMIT 1
      `,
      params: [cleanMeetingUid, cleanNick],
    },
  ]);

  const rows = rowsToObjects(getFirstResult(payload));
  return rows[0] ? mapParticipant(rows[0]) : null;
}

export async function saveMeetingParticipantTorso(
  meetingUid: string,
  data: {
    uid: string;
    nick: string;
    localSchedule: string[];
    utcSchedule: string[];
    updatedAtLocal: string;
    updatedAtUTC: string;
    timezone?: string;
    recoveryEmail?: string | null;
  },
) {
  await ensureSchema();

  const cleanMeetingUid = normalizeString(meetingUid);
  const cleanUid = normalizeString(data.uid);
  const cleanNick = normalizeString(data.nick);

  if (!cleanMeetingUid || !cleanUid || !cleanNick) {
    throw new Error("meetingUid, uid y nick son requeridos");
  }

  const meeting = await getMeetingRow(cleanMeetingUid);
  if (!meeting) {
    throw new Error("La reunion no existe");
  }

  const nickConflict = await executeStatements([
    {
      q: `
        SELECT uid FROM meeting_participants
        WHERE meeting_uid = ? AND nick = ? AND uid != ?
        LIMIT 1
      `,
      params: [cleanMeetingUid, cleanNick, cleanUid],
    },
  ]);

  const conflictingRows = rowsToObjects(getFirstResult(nickConflict));
  if (conflictingRows.length) {
    throw new Error(`Nick "${cleanNick}" ya esta en uso en esta reunion`);
  }

  const rawEmail = data.recoveryEmail === undefined ? undefined : normalizeEmail(data.recoveryEmail);
  let recoveryEmail: string | null = null;
  if (rawEmail !== undefined) {
    if (rawEmail === "") {
      recoveryEmail = null;
    } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rawEmail)) {
      throw new Error("El email de recuperacion es invalido");
    } else {
      recoveryEmail = rawEmail;
    }
  }

  const participant: MeetingParticipantRecord = {
    uid: cleanUid,
    meetingUid: cleanMeetingUid,
    nick: cleanNick,
    localSchedule: parseSchedule(data.localSchedule),
    utcSchedule: parseSchedule(data.utcSchedule),
    updatedAtLocal: String(data.updatedAtLocal || new Date().toString()),
    updatedAtUTC: String(data.updatedAtUTC || new Date().toISOString()),
    timezone: normalizeString(data.timezone) || "UTC",
    recoveryEmail,
  };

  await executeStatements([
    {
      q: `
        INSERT INTO meeting_participants (
          uid,
          meeting_uid,
          nick,
          local_schedule,
          utc_schedule,
          timezone,
          updated_at_local,
          updated_at_utc,
          recovery_email
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(uid) DO UPDATE SET
          meeting_uid = excluded.meeting_uid,
          nick = excluded.nick,
          local_schedule = excluded.local_schedule,
          utc_schedule = excluded.utc_schedule,
          timezone = excluded.timezone,
          updated_at_local = excluded.updated_at_local,
          updated_at_utc = excluded.updated_at_utc,
          recovery_email = COALESCE(excluded.recovery_email, meeting_participants.recovery_email)
      `,
      params: [
        participant.uid,
        participant.meetingUid,
        participant.nick,
        JSON.stringify(participant.localSchedule),
        JSON.stringify(participant.utcSchedule),
        participant.timezone,
        participant.updatedAtLocal,
        participant.updatedAtUTC,
        participant.recoveryEmail,
      ],
    },
  ]);

  return participant;
}

function mapEnrichedMeeting(record: Record<string, unknown>): EnrichedMeetingRecord {
  const base = mapMeeting(record);
  return {
    ...base,
    participantUid: String(record.participant_uid || ""),
    nick: String(record.nick || ""),
  };
}

export async function listMeetingsByParticipantUidsTorso(uids: string[]) {
  await ensureSchema();

  const cleanUids = Array.from(
    new Set(
      (Array.isArray(uids) ? uids : [])
        .map((item) => normalizeString(item))
        .filter((item) => item.length > 0),
    ),
  );
  if (!cleanUids.length) return [] as EnrichedMeetingRecord[];

  const placeholders = cleanUids.map(() => "?").join(", ");
  const payload = await executeStatements([
    {
      q: `
        SELECT
          m.uid AS uid,
          m.title AS title,
          m.created_at_utc AS created_at_utc,
          m.scheduled_at_utc AS scheduled_at_utc,
          p.uid AS participant_uid,
          p.nick AS nick
        FROM meeting_participants p
        INNER JOIN meetings m ON m.uid = p.meeting_uid
        WHERE p.uid IN (${placeholders})
        ORDER BY
          CASE WHEN m.scheduled_at_utc IS NULL THEN 1 ELSE 0 END,
          m.scheduled_at_utc ASC,
          m.created_at_utc DESC
      `,
      params: cleanUids,
    },
  ]);

  return rowsToObjects(getFirstResult(payload)).map(mapEnrichedMeeting);
}

export async function listMeetingsByRecoveryEmailTorso(email: string) {
  await ensureSchema();

  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) return [] as EnrichedMeetingRecord[];

  const payload = await executeStatements([
    {
      q: `
        SELECT
          m.uid AS uid,
          m.title AS title,
          m.created_at_utc AS created_at_utc,
          m.scheduled_at_utc AS scheduled_at_utc,
          p.uid AS participant_uid,
          p.nick AS nick
        FROM meeting_participants p
        INNER JOIN meetings m ON m.uid = p.meeting_uid
        WHERE p.recovery_email = ?
        ORDER BY
          CASE WHEN m.scheduled_at_utc IS NULL THEN 1 ELSE 0 END,
          m.scheduled_at_utc ASC,
          m.created_at_utc DESC
      `,
      params: [cleanEmail],
    },
  ]);

  return rowsToObjects(getFirstResult(payload)).map(mapEnrichedMeeting);
}

export async function createRecoveryTokenTorso(email: string, ttlMinutes = 30) {
  await ensureSchema();

  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) {
    throw new Error("Email requerido");
  }

  const token = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + ttlMinutes * 60 * 1000);

  await executeStatements([
    {
      q: `
        INSERT INTO recovery_tokens (token, email, created_at_utc, expires_at_utc)
        VALUES (?, ?, ?, ?)
      `,
      params: [token, cleanEmail, now.toISOString(), expires.toISOString()],
    },
  ]);

  return { token, email: cleanEmail, expiresAtUTC: expires.toISOString() };
}

export async function consumeRecoveryTokenTorso(token: string): Promise<string | null> {
  await ensureSchema();

  const cleanToken = normalizeString(token);
  if (!cleanToken) return null;

  const lookup = await executeStatements([
    {
      q: `
        SELECT email, expires_at_utc, used_at_utc
        FROM recovery_tokens
        WHERE token = ?
        LIMIT 1
      `,
      params: [cleanToken],
    },
  ]);

  const rows = rowsToObjects(getFirstResult(lookup));
  if (!rows.length) return null;

  const row = rows[0];
  if (row.used_at_utc) return null;

  const expiresAt = Date.parse(String(row.expires_at_utc || ""));
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;

  await executeStatements([
    {
      q: "UPDATE recovery_tokens SET used_at_utc = ? WHERE token = ?",
      params: [new Date().toISOString(), cleanToken],
    },
  ]);

  return normalizeEmail(row.email);
}

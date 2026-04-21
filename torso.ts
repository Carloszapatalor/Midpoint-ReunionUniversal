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

type UserRecord = {
  uid: string;
  username: string;
  passwordHash: string;
  sessionToken: string | null;
  createdAtUTC: string;
  updatedAtUTC: string;
};

type RecoveryTokenRecord = {
  userUid: string;
  tokenHash: string;
  expiresAtUTC: string;
  usedAtUTC: string | null;
  createdAtUTC: string;
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
};

type MeetingParticipantPrivateRecord = MeetingParticipantRecord & {
  accessToken: string;
};

type MeetingRecord = {
  uid: string;
  title: string;
  ownerUid: string;
  createdAtUTC: string;
};

type DashboardMeetingRecord = MeetingRecord & {
  participantCount: number;
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

async function executeStatement(q: string, params: unknown[] = []) {
  return executeStatements([{ q, params }]);
}

async function getTableColumns(tableName: "users" | "meetings" | "meeting_participants" | "recovery_tokens") {
  const payload = await executeStatement(`PRAGMA table_info(${tableName})`);
  const rows = rowsToObjects(getFirstResult(payload));
  return new Set(rows.map((row) => String(row.name || "")));
}

async function ensureColumnExists(tableName: "users" | "meetings" | "meeting_participants" | "recovery_tokens", columnName: string, definition: string) {
  const columns = await getTableColumns(tableName);
  if (!columns.has(columnName)) {
    await executeStatement(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

let schemaPromise: Promise<void> | null = null;

async function ensureSchema() {
  if (schemaPromise) {
    return schemaPromise;
  }

  schemaPromise = (async () => {
    await executeStatement(`
      CREATE TABLE IF NOT EXISTS users (
        uid TEXT PRIMARY KEY,
        username TEXT,
        password_hash TEXT,
        session_token TEXT,
        created_at_utc TEXT,
        updated_at_utc TEXT
      )
    `);
    await ensureColumnExists("users", "username", "TEXT");
    await ensureColumnExists("users", "password_hash", "TEXT");
    await ensureColumnExists("users", "session_token", "TEXT");
    await ensureColumnExists("users", "created_at_utc", "TEXT");
    await ensureColumnExists("users", "updated_at_utc", "TEXT");
    await executeStatement("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username)");
    await executeStatement("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_session_token ON users (session_token)");

    await executeStatement(`
      CREATE TABLE IF NOT EXISTS meetings (
        uid TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        owner_uid TEXT,
        created_at_utc TEXT NOT NULL
      )
    `);
    await ensureColumnExists("meetings", "owner_uid", "TEXT");
    await executeStatement("CREATE INDEX IF NOT EXISTS idx_meetings_owner_uid ON meetings (owner_uid)");

    await executeStatement(`
      CREATE TABLE IF NOT EXISTS recovery_tokens (
        uid TEXT PRIMARY KEY,
        user_uid TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at_utc TEXT NOT NULL,
        used_at_utc TEXT,
        created_at_utc TEXT NOT NULL,
        FOREIGN KEY (user_uid) REFERENCES users(uid)
      )
    `);
    await ensureColumnExists("recovery_tokens", "user_uid", "TEXT");
    await ensureColumnExists("recovery_tokens", "token_hash", "TEXT");
    await ensureColumnExists("recovery_tokens", "expires_at_utc", "TEXT");
    await ensureColumnExists("recovery_tokens", "used_at_utc", "TEXT");
    await ensureColumnExists("recovery_tokens", "created_at_utc", "TEXT");
    await executeStatement("CREATE INDEX IF NOT EXISTS idx_recovery_tokens_user_uid ON recovery_tokens (user_uid)");
    await executeStatement("CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_tokens_token_hash ON recovery_tokens (token_hash)");
    await executeStatement("CREATE INDEX IF NOT EXISTS idx_recovery_tokens_expires_at_utc ON recovery_tokens (expires_at_utc)");

    await executeStatement(`
      CREATE TABLE IF NOT EXISTS meeting_participants (
        uid TEXT PRIMARY KEY,
        meeting_uid TEXT NOT NULL,
        nick TEXT NOT NULL,
        access_token TEXT,
        local_schedule TEXT NOT NULL DEFAULT '[]',
        utc_schedule TEXT NOT NULL DEFAULT '[]',
        timezone TEXT NOT NULL,
        updated_at_local TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL,
        FOREIGN KEY (meeting_uid) REFERENCES meetings(uid)
      )
    `);
    await ensureColumnExists("meeting_participants", "access_token", "TEXT");
    await executeStatement(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_participants_meeting_nick
      ON meeting_participants (meeting_uid, nick)
    `);
    await executeStatement(`
      CREATE INDEX IF NOT EXISTS idx_meeting_participants_meeting_uid
      ON meeting_participants (meeting_uid)
    `);
  })();

  return schemaPromise;
}

function mapUser(record: Record<string, unknown>): UserRecord {
  return {
    uid: String(record.uid || ""),
    username: String(record.username || ""),
    passwordHash: String(record.password_hash || ""),
    sessionToken: record.session_token ? String(record.session_token) : null,
    createdAtUTC: String(record.created_at_utc || ""),
    updatedAtUTC: String(record.updated_at_utc || ""),
  };
}

function mapRecoveryToken(record: Record<string, unknown>): RecoveryTokenRecord {
  return {
    userUid: String(record.user_uid || ""),
    tokenHash: String(record.token_hash || ""),
    expiresAtUTC: String(record.expires_at_utc || ""),
    usedAtUTC: record.used_at_utc ? String(record.used_at_utc) : null,
    createdAtUTC: String(record.created_at_utc || ""),
  };
}

function mapMeeting(record: Record<string, unknown>): MeetingRecord {
  return {
    uid: String(record.uid || ""),
    title: String(record.title || ""),
    ownerUid: String(record.owner_uid || ""),
    createdAtUTC: String(record.created_at_utc || ""),
  };
}

function mapDashboardMeeting(record: Record<string, unknown>): DashboardMeetingRecord {
  return {
    ...mapMeeting(record),
    participantCount: Number(record.participant_count || 0),
  };
}

function mapParticipant(record: Record<string, unknown>): MeetingParticipantRecord {
  return {
    uid: String(record.uid || ""),
    meetingUid: String(record.meeting_uid || ""),
    nick: String(record.nick || ""),
    localSchedule: parseSchedule(record.local_schedule),
    utcSchedule: parseSchedule(record.utc_schedule),
    updatedAtLocal: String(record.updated_at_local || ""),
    updatedAtUTC: String(record.updated_at_utc || ""),
    timezone: String(record.timezone || "UTC"),
  };
}

function mapParticipantPrivate(record: Record<string, unknown>): MeetingParticipantPrivateRecord {
  return {
    ...mapParticipant(record),
    accessToken: String(record.access_token || ""),
  };
}

function generateParticipantAccessToken() {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`;
}

async function getMeetingRow(meetingUid: string) {
  const payload = await executeStatement("SELECT * FROM meetings WHERE uid = ? LIMIT 1", [meetingUid]);
  const rows = rowsToObjects(getFirstResult(payload));
  return rows[0] || null;
}

export async function createUserTorso(data: {
  uid: string;
  username: string;
  passwordHash: string;
  createdAtUTC: string;
  updatedAtUTC: string;
}) {
  await ensureSchema();

  const uid = normalizeString(data.uid);
  const username = normalizeString(data.username);
  const passwordHash = normalizeString(data.passwordHash);

  if (!uid || !username || !passwordHash) {
    throw new Error("uid, username y passwordHash son requeridos");
  }

  try {
    await executeStatement(`
      INSERT INTO users (uid, username, password_hash, session_token, created_at_utc, updated_at_utc)
      VALUES (?, ?, ?, NULL, ?, ?)
    `, [uid, username, passwordHash, data.createdAtUTC, data.updatedAtUTC]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error al crear usuario";
    if (message.includes("idx_users_username") || message.includes("UNIQUE constraint failed: users.username")) {
      throw new Error(`Usuario "${username}" ya esta en uso`);
    }
    throw error;
  }

  const created = await getUserByUidTorso(uid);
  if (!created) throw new Error("No se pudo cargar el usuario creado");
  return created;
}

export async function getUserByUidTorso(uid: string) {
  await ensureSchema();

  const cleanUid = normalizeString(uid);
  if (!cleanUid) return null;

  const payload = await executeStatement("SELECT * FROM users WHERE uid = ? LIMIT 1", [cleanUid]);
  const rows = rowsToObjects(getFirstResult(payload));
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function getUserByUsernameTorso(username: string) {
  await ensureSchema();

  const cleanUsername = normalizeString(username);
  if (!cleanUsername) return null;

  const payload = await executeStatement("SELECT * FROM users WHERE username = ? LIMIT 1", [cleanUsername]);
  const rows = rowsToObjects(getFirstResult(payload));
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function getUserBySessionTokenTorso(sessionToken: string) {
  await ensureSchema();

  const cleanToken = normalizeString(sessionToken);
  if (!cleanToken) return null;

  const payload = await executeStatement("SELECT * FROM users WHERE session_token = ? LIMIT 1", [cleanToken]);
  const rows = rowsToObjects(getFirstResult(payload));
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function setUserSessionTokenTorso(uid: string, sessionToken: string | null, updatedAtUTC: string) {
  await ensureSchema();

  await executeStatement(`
    UPDATE users
    SET session_token = ?, updated_at_utc = ?
    WHERE uid = ?
  `, [sessionToken, updatedAtUTC, uid]);

  return getUserByUidTorso(uid);
}

export async function updateUserPasswordHashTorso(uid: string, passwordHash: string, updatedAtUTC: string) {
  await ensureSchema();

  await executeStatement(`
    UPDATE users
    SET password_hash = ?, session_token = NULL, updated_at_utc = ?
    WHERE uid = ?
  `, [passwordHash, updatedAtUTC, uid]);

  return getUserByUidTorso(uid);
}

export async function createPasswordRecoveryTokenTorso(data: {
  uid: string;
  userUid: string;
  tokenHash: string;
  expiresAtUTC: string;
  createdAtUTC: string;
}) {
  await ensureSchema();

  const uid = normalizeString(data.uid);
  const userUid = normalizeString(data.userUid);
  const tokenHash = normalizeString(data.tokenHash);
  const expiresAtUTC = normalizeString(data.expiresAtUTC);
  const createdAtUTC = normalizeString(data.createdAtUTC);

  if (!uid || !userUid || !tokenHash || !expiresAtUTC || !createdAtUTC) {
    throw new Error("uid, userUid, tokenHash, expiresAtUTC y createdAtUTC son requeridos");
  }

  await executeStatement("UPDATE recovery_tokens SET used_at_utc = ? WHERE user_uid = ? AND used_at_utc IS NULL", [createdAtUTC, userUid]);

  const columns = await getTableColumns("recovery_tokens");
  if (columns.has("uid")) {
    await executeStatement(`
      INSERT INTO recovery_tokens (uid, user_uid, token_hash, expires_at_utc, used_at_utc, created_at_utc)
      VALUES (?, ?, ?, ?, NULL, ?)
    `, [uid, userUid, tokenHash, expiresAtUTC, createdAtUTC]);
    return;
  }

  await executeStatement(`
    INSERT INTO recovery_tokens (user_uid, token_hash, expires_at_utc, used_at_utc, created_at_utc)
    VALUES (?, ?, ?, NULL, ?)
  `, [userUid, tokenHash, expiresAtUTC, createdAtUTC]);
}

export async function getActivePasswordRecoveryTokenTorso(tokenHash: string, nowUTC: string) {
  await ensureSchema();

  const cleanHash = normalizeString(tokenHash);
  const cleanNowUTC = normalizeString(nowUTC);
  if (!cleanHash || !cleanNowUTC) return null;

  const payload = await executeStatement(`
    SELECT * FROM recovery_tokens
    WHERE token_hash = ?
      AND used_at_utc IS NULL
      AND expires_at_utc > ?
    LIMIT 1
  `, [cleanHash, cleanNowUTC]);

  const rows = rowsToObjects(getFirstResult(payload));
  return rows[0] ? mapRecoveryToken(rows[0]) : null;
}

export async function markPasswordRecoveryTokenUsedTorso(tokenHash: string, usedAtUTC: string) {
  await ensureSchema();

  const cleanTokenHash = normalizeString(tokenHash);
  const cleanUsedAtUTC = normalizeString(usedAtUTC);
  if (!cleanTokenHash || !cleanUsedAtUTC) {
    throw new Error("tokenHash y usedAtUTC son requeridos");
  }

  await executeStatement("UPDATE recovery_tokens SET used_at_utc = ? WHERE token_hash = ?", [cleanUsedAtUTC, cleanTokenHash]);
}

function generateMeetingId(length = 4): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map((b) => alphabet[b % alphabet.length]).join("");
}

export async function createMeetingTorso(title: string, ownerUid: string) {
  await ensureSchema();

  const cleanTitle = normalizeString(title);
  const cleanOwnerUid = normalizeString(ownerUid);

  if (!cleanTitle) {
    throw new Error("El titulo es requerido");
  }

  if (!cleanOwnerUid) {
    throw new Error("El creador es requerido");
  }

  const owner = await getUserByUidTorso(cleanOwnerUid);
  if (!owner) {
    throw new Error("El usuario creador no existe");
  }

  let shortId = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    shortId = generateMeetingId(4);
    const existing = await getMeetingRow(shortId);
    if (!existing) break;
    if (attempt === 4) throw new Error("No se pudo generar un ID unico para la reunion, intenta de nuevo");
  }

  const meeting: MeetingRecord = {
    uid: shortId,
    title: cleanTitle,
    ownerUid: cleanOwnerUid,
    createdAtUTC: new Date().toISOString(),
  };

  await executeStatement(`
    INSERT INTO meetings (uid, title, owner_uid, created_at_utc)
    VALUES (?, ?, ?, ?)
  `, [meeting.uid, meeting.title, meeting.ownerUid, meeting.createdAtUTC]);

  return meeting;
}

export async function listMeetingsByOwnerTorso(ownerUid: string) {
  await ensureSchema();

  const cleanOwnerUid = normalizeString(ownerUid);
  if (!cleanOwnerUid) return [];

  const payload = await executeStatement(`
    SELECT
      m.uid,
      m.title,
      m.owner_uid,
      m.created_at_utc,
      (
        SELECT COUNT(*) FROM meeting_participants p WHERE p.meeting_uid = m.uid
      ) AS participant_count
    FROM meetings m
    WHERE m.owner_uid = ?
    ORDER BY m.created_at_utc DESC
  `, [cleanOwnerUid]);

  const rows = rowsToObjects(getFirstResult(payload));
  return rows.map(mapDashboardMeeting);
}

export async function deleteMeetingByOwnerTorso(ownerUid: string, meetingUid: string) {
  await ensureSchema();

  const cleanOwnerUid = normalizeString(ownerUid);
  const cleanMeetingUid = normalizeString(meetingUid);
  if (!cleanOwnerUid || !cleanMeetingUid) {
    throw new Error("ownerUid y meetingUid son requeridos");
  }

  const payload = await executeStatement(
    "SELECT uid FROM meetings WHERE uid = ? AND owner_uid = ? LIMIT 1",
    [cleanMeetingUid, cleanOwnerUid],
  );
  const rows = rowsToObjects(getFirstResult(payload));
  if (!rows.length) {
    return { deleted: false };
  }

  await executeStatement("DELETE FROM meeting_participants WHERE meeting_uid = ?", [cleanMeetingUid]);
  await executeStatement("DELETE FROM meetings WHERE uid = ? AND owner_uid = ?", [cleanMeetingUid, cleanOwnerUid]);

  return { deleted: true };
}

export async function getMeetingTorso(meetingUid: string) {
  await ensureSchema();

  const cleanMeetingUid = normalizeString(meetingUid);
  if (!cleanMeetingUid) {
    return null;
  }

  const meetingPayload = await executeStatement("SELECT * FROM meetings WHERE uid = ? LIMIT 1", [cleanMeetingUid]);
  const meetingRows = rowsToObjects(getFirstResult(meetingPayload));
  if (!meetingRows.length) {
    return null;
  }

  const participantsPayload = await executeStatement(`
    SELECT * FROM meeting_participants
    WHERE meeting_uid = ?
    ORDER BY updated_at_utc DESC, nick ASC
  `, [cleanMeetingUid]);

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

  const payload = await executeStatement(`
    SELECT * FROM meeting_participants
    WHERE meeting_uid = ? AND uid = ?
    LIMIT 1
  `, [cleanMeetingUid, cleanUid]);

  const rows = rowsToObjects(getFirstResult(payload));
  return rows[0] ? mapParticipant(rows[0]) : null;
}

async function getMeetingParticipantByUidPrivateTorso(meetingUid: string, uid: string) {
  await ensureSchema();

  const cleanMeetingUid = normalizeString(meetingUid);
  const cleanUid = normalizeString(uid);
  if (!cleanMeetingUid || !cleanUid) {
    return null;
  }

  const payload = await executeStatement(`
    SELECT * FROM meeting_participants
    WHERE meeting_uid = ? AND uid = ?
    LIMIT 1
  `, [cleanMeetingUid, cleanUid]);

  const rows = rowsToObjects(getFirstResult(payload));
  return rows[0] ? mapParticipantPrivate(rows[0]) : null;
}

export async function getMeetingParticipantByNickTorso(meetingUid: string, nick: string) {
  await ensureSchema();

  const cleanMeetingUid = normalizeString(meetingUid);
  const cleanNick = normalizeString(nick);
  if (!cleanMeetingUid || !cleanNick) {
    return null;
  }

  const payload = await executeStatement(`
    SELECT * FROM meeting_participants
    WHERE meeting_uid = ? AND nick = ?
    LIMIT 1
  `, [cleanMeetingUid, cleanNick]);

  const rows = rowsToObjects(getFirstResult(payload));
  return rows[0] ? mapParticipant(rows[0]) : null;
}

export async function getMeetingParticipantByNickWithAccessTorso(meetingUid: string, nick: string, accessToken: string) {
  await ensureSchema();

  const cleanMeetingUid = normalizeString(meetingUid);
  const cleanNick = normalizeString(nick);
  const cleanAccessToken = normalizeString(accessToken);
  if (!cleanMeetingUid || !cleanNick) {
    return { exists: false, reserved: false, participant: null, participantToken: "" };
  }

  const payload = await executeStatement(`
    SELECT * FROM meeting_participants
    WHERE meeting_uid = ? AND nick = ?
    LIMIT 1
  `, [cleanMeetingUid, cleanNick]);

  const rows = rowsToObjects(getFirstResult(payload));
  if (!rows[0]) {
    return { exists: false, reserved: false, participant: null, participantToken: "" };
  }

  const participant = mapParticipantPrivate(rows[0]);
  if (!cleanAccessToken || participant.accessToken !== cleanAccessToken) {
    return { exists: true, reserved: true, participant: null, participantToken: "" };
  }

  return {
    exists: true,
    reserved: false,
    participant: mapParticipant(rows[0]),
    participantToken: participant.accessToken,
  };
}

export async function getMeetingParticipantByUidWithAccessTorso(meetingUid: string, uid: string, accessToken: string) {
  const participant = await getMeetingParticipantByUidPrivateTorso(meetingUid, uid);
  const cleanAccessToken = normalizeString(accessToken);

  if (!participant) {
    return { exists: false, reserved: false, participant: null, participantToken: "" };
  }

  if (!cleanAccessToken || participant.accessToken !== cleanAccessToken) {
    return { exists: true, reserved: true, participant: null, participantToken: "" };
  }

  return {
    exists: true,
    reserved: false,
    participant: {
      uid: participant.uid,
      meetingUid: participant.meetingUid,
      nick: participant.nick,
      localSchedule: participant.localSchedule,
      utcSchedule: participant.utcSchedule,
      updatedAtLocal: participant.updatedAtLocal,
      updatedAtUTC: participant.updatedAtUTC,
      timezone: participant.timezone,
    },
    participantToken: participant.accessToken,
  };
}

export async function saveMeetingParticipantTorso(
  meetingUid: string,
  data: {
    uid: string;
    nick: string;
    participantToken?: string;
    localSchedule: string[];
    utcSchedule: string[];
    updatedAtLocal: string;
    updatedAtUTC: string;
    timezone?: string;
  },
) {
  await ensureSchema();

  const cleanMeetingUid = normalizeString(meetingUid);
  const cleanUid = normalizeString(data.uid);
  const cleanNick = normalizeString(data.nick);
  const cleanParticipantToken = normalizeString(data.participantToken);

  if (!cleanMeetingUid || !cleanUid || !cleanNick) {
    throw new Error("meetingUid, uid y nick son requeridos");
  }

  const meeting = await getMeetingRow(cleanMeetingUid);
  if (!meeting) {
    throw new Error("La reunion no existe");
  }

  const nickConflictPayload = await executeStatement(`
    SELECT uid FROM meeting_participants
    WHERE meeting_uid = ? AND nick = ? AND uid != ?
    LIMIT 1
  `, [cleanMeetingUid, cleanNick, cleanUid]);

  const conflictingRows = rowsToObjects(getFirstResult(nickConflictPayload));
  if (conflictingRows.length) {
    throw new Error(`Nick "${cleanNick}" ya esta en uso en esta reunion`);
  }

  const existingParticipant = await getMeetingParticipantByUidPrivateTorso(cleanMeetingUid, cleanUid);
  const accessToken = existingParticipant?.accessToken || generateParticipantAccessToken();

  if (existingParticipant && existingParticipant.accessToken !== cleanParticipantToken) {
    throw new Error("La sesion del participante ya no es valida");
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
  };

  await executeStatement(`
    INSERT INTO meeting_participants (
      uid,
      meeting_uid,
      nick,
      access_token,
      local_schedule,
      utc_schedule,
      timezone,
      updated_at_local,
      updated_at_utc
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(uid) DO UPDATE SET
      meeting_uid = excluded.meeting_uid,
      nick = excluded.nick,
      access_token = excluded.access_token,
      local_schedule = excluded.local_schedule,
      utc_schedule = excluded.utc_schedule,
      timezone = excluded.timezone,
      updated_at_local = excluded.updated_at_local,
      updated_at_utc = excluded.updated_at_utc
  `, [
    participant.uid,
    participant.meetingUid,
    participant.nick,
    accessToken,
    JSON.stringify(participant.localSchedule),
    JSON.stringify(participant.utcSchedule),
    participant.timezone,
    participant.updatedAtLocal,
    participant.updatedAtUTC,
  ]);

  return { participant, participantToken: accessToken };
}
